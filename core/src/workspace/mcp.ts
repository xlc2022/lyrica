import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse, McpClient, McpConnectionClosedError, McpHttpError, parseJsonRpcMessage, StreamableHttpTransport,
  type JsonRpcId, type JsonRpcMessage, type McpTransport,
} from "@earendil-works/pi-mcp";

// MCP servers she reaches (DESIGN.md, "MCP servers"), through Pi's own
// client: remote ones over streamable HTTP, and local ones, a program started
// in the thread's sandbox and spoken to on its pipes (docs/briefs/mcp-local.md).
// Lyrica writes no protocol code; this file holds the two transports every
// connection uses, so what reaches Pi is already kept small and nothing a
// server says is written to disk.

/** A server's result text above this is cut in the middle before Pi sees it, so Pi never saves the rest to a temporary file. */
export const MCP_RESULT_BYTES = 16 * 1024;

/** How the last connection to a server went: it answered, it refused the token, or it couldn't be reached. */
export type McpStateKind = "online" | "rejected" | "unreachable";

/** A server that didn't answer as one should, with the state it leaves the server in. */
export class McpServerProblem extends Error {
  constructor(readonly state: Exclude<McpStateKind, "online">, message: string) { super(message); this.name = "McpServerProblem"; }
}

/** Where a local server runs, as the facts line and the thread drawer say it: the thread's own sandbox. */
export const LOCAL_HOST = "this machine";

/** A server's address as kept: http or https, no credentials in it. A general server's token goes only over https. */
export function mcpUrl(raw: string, pool?: "general" | "private", token?: string): string {
  let url: URL;
  try { url = new URL(String(raw ?? "").trim()); } catch { throw new Error("the URL looks like https://mcp.example.com/mcp"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("a remote MCP server's URL starts with https:// or http://; a local one is given as a command instead");
  if (url.username || url.password) throw new Error("put the token in the Token field, not in the URL");
  if (pool === "general" && token && url.protocol !== "https:") throw new Error("a general server's token is sent only over https");
  url.hash = "";
  return url.toString();
}

/** The host (and port) of a server's URL, as resolveHost and the facts line want it. */
export const mcpHost = (url: string): string => new URL(url).host;

/** Where a server is, for its facts line: its URL's host, or "this machine" for a local one. */
export const mcpPlace = (m: { url: string; command: string[] }): string => (m.command.length ? LOCAL_HOST : mcpHost(m.url));

/**
 * A command line as a shell would split it: words separated by blanks, with
 * single quotes, double quotes and a backslash keeping blanks and quotes in a
 * word. Nothing is expanded: no variables, no globs, no `$(…)`.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < line.length && '"\\'.includes(line[i + 1]!)) word = (word ?? "") + line[++i];
      else word = (word ?? "") + c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else if (/\s/.test(c)) {
      if (word !== undefined) { words.push(word); word = undefined; }
    } else {
      word = (word ?? "") + c;
    }
  }
  if (quote) throw new Error(`a ${quote} quote isn't closed`);
  if (word !== undefined) words.push(word);
  return words;
}

/** A local server's command as kept: the program (a name on the sandbox's PATH, or an absolute path) and its arguments, from one line. */
export function mcpCommand(raw: string): string[] {
  const line = String(raw ?? "").trim();
  if (/[\0-\x1f\x7f]/.test(line)) throw new Error("a command is one line");
  const argv = shellWords(line);
  if (!argv.length) throw new Error("the command is the program and its arguments, like ebay-mcp-server");
  if (!/^[A-Za-z0-9_.+/@:-]+$/.test(argv[0]!) || argv[0]!.startsWith("-")) throw new Error("the program is a name on the sandbox's PATH, or an absolute path");
  if (argv.length > 64 || argv.some((a) => a.length > 1024)) throw new Error("that's too long for a command");
  return argv;
}

/** A command as one line again, for the drawer: a word with a blank or a quote in it is quoted. */
export const mcpCommandLine = (argv: string[]): string => argv.map((a) => (/[\s'"\\]/.test(a) || !a ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ");

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A local server's environment as kept, from `KEY=value` lines (blank lines
 * and `#` comments skipped): at most 64 variables, each value one line of
 * at most 4096 characters, taken as written (no `${VAR}` or `!command`
 * expansion, which Pi would do in an `mcp.json`).
 */
export function mcpEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    const name = eq < 0 ? t : t.slice(0, eq).trim();
    if (!ENV_NAME.test(name)) throw new Error(`"${name.slice(0, 40)}" isn't a variable name: KEY=value, one per line`);
    if (eq < 0) throw new Error(`${name} needs a value: ${name}=…`);
    const value = t.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    if (value.length > 4096 || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${name}'s value is too long, or isn't one line`);
    env[name] = value;
  }
  if (Object.keys(env).length > 64) throw new Error("that's too many variables");
  return env;
}

/** A kept environment, checked again before it is saved or started. */
export function checkMcpEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!ENV_NAME.test(name) || typeof value !== "string" || value.length > 4096 || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${String(name).slice(0, 40)} isn't KEY=value`);
    out[name] = value;
  }
  if (Object.keys(out).length > 64) throw new Error("that's too many variables");
  return out;
}

/** A server's name: letters, digits, '_' and '-', as Pi names its tools `mcp__<name>__<tool>`. */
export const MCP_NAME = /^[A-Za-z0-9_-]{1,40}$/;

/** Pi's namespace for a server: names that differ only in '-' and '_' are one server to it. */
export const mcpNamespace = (name: string): string => `mcp__${name.replace(/-/g, "_")}`;

const headers = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

/** Fetch that never follows a redirect, so the token goes only to the URL the user gave. */
const noRedirects = (f: typeof fetch = fetch) => (input: string | URL, init?: RequestInit) => f(input, { ...init, redirect: "error" });

/** Why a connection failed, as the state it leaves the server in. */
export function mcpFailure(err: unknown): Exclude<McpStateKind, "online"> {
  return err instanceof McpHttpError && (err.status === 401 || err.status === 403) ? "rejected" : "unreachable";
}

export interface McpTransportOptions {
  url: string;
  token?: string;
  fetch?: typeof fetch;
  /** How each connection attempt went, for the server's state in Settings. */
  state?: (kind: McpStateKind) => void;
}

/**
 * Streamable HTTP to one server, with what Lyrica keeps: the token as a
 * bearer header (never expanded the way Pi expands `${VAR}` or `!command` in
 * mcp.json), no redirects, the server's log messages dropped (Pi would append
 * them to mcp.log), resources and prompts not offered (out of scope; Pi saves
 * binary resources to temporary files), and each tool result cut to
 * MCP_RESULT_BYTES with binary resources left out, so Pi never writes the
 * full text to a temporary file.
 */
export function mcpTransport(o: McpTransportOptions): McpTransport {
  return kept(new StreamableHttpTransport({ url: o.url, headers: headers(o.token), fetch: noRedirects(o.fetch) }), o.state, mcpFailure);
}

/** A local server's process, as `Sandbox.start` hands it back: its three pipes. */
export type McpProcess = ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };

export interface McpStdioTransportOptions {
  /** Starts the server's program, in the thread's sandbox: `Workspace.startMcpServer`. */
  start: () => Promise<McpProcess>;
  /** How each start went, for the server's state in Settings: online once it answers `initialize`, unreachable when it doesn't start. */
  state?: (kind: McpStateKind) => void;
}

/**
 * A local server, started in the thread's sandbox and spoken to on its
 * pipes, with the same filters as the HTTP transport. Its stderr is held in
 * memory, the last STDERR_BYTES, only to say why it didn't answer; nothing
 * of it reaches disk or the model.
 */
export function mcpStdioTransport(o: McpStdioTransportOptions): McpTransport {
  return kept(new ProcessTransport(o.start), o.state, () => "unreachable");
}

/** The transport's filters: log notifications dropped, resources and prompts not offered, results cut, each failure's state recorded. */
function kept(inner: McpTransport, state: ((kind: McpStateKind) => void) | undefined, failure: (err: unknown) => Exclude<McpStateKind, "online">): McpTransport {
  const o = { state };
  const calls = new Set<JsonRpcId>();
  const inits = new Set<JsonRpcId>();
  const keep = (m: JsonRpcMessage): JsonRpcMessage | undefined => {
    if (isJsonRpcNotification(m) && m.method === "notifications/message") return undefined;
    if (!isJsonRpcResponse(m) || !("result" in m)) {
      if (isJsonRpcResponse(m)) { calls.delete(m.id); inits.delete(m.id); }
      return m;
    }
    if (inits.delete(m.id)) {
      o.state?.("online");
      const result = m.result as { capabilities?: Record<string, unknown> };
      const { resources: _r, prompts: _p, ...capabilities } = result.capabilities ?? {};
      return { ...m, result: { ...result, capabilities } };
    }
    if (calls.delete(m.id)) return { ...m, result: keepResult(m.result) };
    return m;
  };
  return {
    async start() {
      try {
        await inner.start();
      } catch (err) {
        o.state?.(failure(err));
        throw err;
      }
    },
    async send(m) {
      if (isJsonRpcRequest(m)) {
        if (m.method === "tools/call") calls.add(m.id);
        if (m.method === "initialize") inits.add(m.id);
      }
      try {
        await inner.send(m);
      } catch (err) {
        if (isJsonRpcRequest(m)) o.state?.(failure(err));
        throw err;
      }
    },
    close: () => inner.close(),
    onMessage: (listener) => inner.onMessage((m) => { const out = keep(m); if (out) listener(out); }),
    onError: (listener) => inner.onError(listener),
    onClose: (listener) => inner.onClose(listener),
    setProtocolVersion: (v) => inner.setProtocolVersion?.(v),
  };
}

/** How much of a local server's stderr is held, in memory, for the line that says why it didn't answer. */
const STDERR_BYTES = 4096;
/** A line of a local server's stdout longer than this isn't a message it may send. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** How long a local server gets to exit after its stdin closes, then after SIGTERM. */
const CLOSE_GRACE_MS = 500;
const CLOSE_TIMEOUT_MS = 2000;

/**
 * Newline-delimited JSON-RPC on a process's pipes, the process started by
 * `start` (Pi's own stdio transport starts the program itself, as lyricad's
 * user with lyricad's environment, which is why this one exists). Closing
 * ends stdin, then SIGTERM, then SIGKILL, as the protocol says.
 */
class ProcessTransport implements McpTransport {
  private child: McpProcess | undefined;
  private closed = false;
  private closeEmitted = false;
  private pending = Buffer.alloc(0);
  private errTail = "";
  private readonly messageListeners = new Set<(m: JsonRpcMessage) => void>();
  private readonly errorListeners = new Set<(e: Error) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(private readonly startProcess: () => Promise<McpProcess>) {}

  /** The last of what the program wrote to stderr: its own words on why it stopped. */
  stderr(): string { return this.errTail; }

  async start(): Promise<void> {
    if (this.child) throw new Error("MCP process transport already started");
    if (this.closed) throw new McpConnectionClosedError();
    const child = await this.startProcess();
    this.child = child;
    child.stdout.on("data", (d: Buffer) => this.read(d));
    child.stderr.on("data", (d: Buffer) => { this.errTail = (this.errTail + d.toString("utf8")).slice(-STDERR_BYTES); });
    child.stdin.on("error", () => {}); // the program may exit without reading
    child.on("error", (err) => this.emitError(err));
    child.on("close", () => { this.child = undefined; this.emitClose(); });
  }

  async send(m: JsonRpcMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (this.closed || !stdin?.writable) throw new McpConnectionClosedError();
    await new Promise<void>((resolve, reject) => stdin.write(`${JSON.stringify(m)}\n`, (err) => (err ? reject(err) : resolve())));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) { this.emitClose(); return; }
    await new Promise<void>((resolve) => {
      const timers = [setTimeout(() => child.kill("SIGTERM"), CLOSE_GRACE_MS), setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS + CLOSE_TIMEOUT_MS)];
      child.once("close", () => { for (const t of timers) clearTimeout(t); resolve(); });
      child.stdin.end();
    });
  }

  onMessage(listener: (m: JsonRpcMessage) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onError(listener: (e: Error) => void): () => void { this.errorListeners.add(listener); return () => this.errorListeners.delete(listener); }
  onClose(listener: () => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  setProtocolVersion(): void {}

  private read(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    for (let nl = this.pending.indexOf(0x0a); nl >= 0; nl = this.pending.indexOf(0x0a)) {
      const line = this.pending.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      this.pending = this.pending.subarray(nl + 1);
      if (!line.trim()) continue;
      try { this.emitMessage(parseJsonRpcMessage(JSON.parse(line))); } catch (err) { this.emitError(err as Error); }
    }
    if (this.pending.length > MAX_LINE_BYTES) {
      this.pending = Buffer.alloc(0);
      this.emitError(new Error(`the server wrote a line over ${MAX_LINE_BYTES} bytes`));
    }
  }

  private emitMessage(m: JsonRpcMessage): void { for (const l of this.messageListeners) l(m); }
  private emitError(e: Error): void { for (const l of this.errorListeners) l(e); }
  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const l of this.closeListeners) l();
  }
}

type Block = { type: string; text?: string; resource?: { uri?: string; mimeType?: string; text?: string; blob?: string } };

/**
 * A tool result as it may reach Pi: binary resources (other than images)
 * named instead of kept, and text over MCP_RESULT_BYTES cut in the middle,
 * saying how much was cut. Images pass through.
 */
export function keepResult(result: unknown): unknown {
  const r = result as { content?: Block[]; structuredContent?: unknown } | undefined;
  if (!r || !Array.isArray(r.content)) return result;
  let content: Block[] = r.content.map((b) => {
    const res = b?.type === "resource" ? b.resource : undefined;
    if (res && typeof res.blob === "string" && !String(res.mimeType ?? "").startsWith("image/")) {
      return { type: "text", text: `[A binary resource, ${res.uri ?? "unnamed"}, not shown]` };
    }
    return b;
  });
  if (!content.length && r.structuredContent !== undefined) content = [{ type: "text", text: JSON.stringify(r.structuredContent) }];
  const texts = content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text]
    : b.type === "resource" && typeof b.resource?.text === "string" ? [b.resource.text] : []));
  const all = Buffer.from(texts.join("\n"));
  if (all.length <= MCP_RESULT_BYTES) return { ...r, content };
  const half = Math.floor((MCP_RESULT_BYTES - 200) / 2);
  const text = `${all.subarray(0, half).toString()}\n…${all.length - 2 * half} bytes cut…\n${all.subarray(all.length - half).toString()}`;
  const images = content.filter((b) => b.type === "image" || (b.type === "resource" && typeof b.resource?.blob === "string"));
  return { ...r, content: [{ type: "text", text }, ...images] };
}

/** What a check found: the server answered `initialize` and `tools/list`. */
export interface McpProbe {
  tools: number;
  /** The first line of the server's instructions, or its title: the line Pi lists the server with. */
  description: string | null;
}

/**
 * Checks a remote server before it is saved: an MCP `initialize` and
 * `tools/list`, which must answer within 15 seconds. Throws McpServerProblem.
 */
export function probeMcp(url: string, token?: string, f?: typeof fetch): Promise<McpProbe> {
  return probe(new StreamableHttpTransport({ url, headers: headers(token), fetch: noRedirects(f), openGetStream: false }), mcpHost(url));
}

/** Checks a local server before it is saved: started by `start` (in a sandbox), it must answer `initialize` and `tools/list` within 15 seconds. Throws McpServerProblem. */
export function probeMcpCommand(start: () => Promise<McpProcess>): Promise<McpProbe> {
  const transport = new ProcessTransport(start);
  return probe(transport, LOCAL_HOST, () => transport.stderr());
}

async function probe(transport: McpTransport, place: string, stderr?: () => string): Promise<McpProbe> {
  const client = new McpClient({ name: "lyrica", version: "1", requestTimeoutMs: 15_000 });
  try {
    const init = await client.connect(transport);
    const tools = await client.listTools({ timeoutMs: 15_000 });
    const line = (init.instructions ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? init.serverInfo?.title ?? null;
    return { tools: tools.length, description: line ? line.slice(0, 200) : null };
  } catch (err) {
    const state = mcpFailure(err);
    // A local server's own last words, one line, say more than "closed" does: a missing key, a program not found.
    const said = stderr?.().trim().split("\n").filter(Boolean).at(-1)?.slice(0, 300);
    throw new McpServerProblem(state, state === "rejected" ? `${place} rejected the token`
      : `${place === LOCAL_HOST ? "the program" : place} didn't answer as an MCP server: ${(err as Error).message}${said ? ` (it said: ${said})` : ""}`);
  } finally {
    await client.close().catch(() => {});
  }
}
