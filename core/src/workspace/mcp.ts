import {
  isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse, McpClient, McpHttpError, StreamableHttpTransport,
  type JsonRpcId, type JsonRpcMessage, type McpTransport,
} from "@earendil-works/pi-mcp";

// MCP servers she reaches (DESIGN.md, "MCP servers"): remote ones, over
// streamable HTTP, through Pi's own client; a local (stdio) server is allowed
// in principle but not built yet. Lyrica writes no protocol code;
// this file is the one transport every connection uses, so what reaches Pi is
// already kept small and nothing a server says is written to disk.

/** A server's result text above this is cut in the middle before Pi sees it, so Pi never saves the rest to a temporary file. */
export const MCP_RESULT_BYTES = 16 * 1024;

/** How the last connection to a server went: it answered, it refused the token, or it couldn't be reached. */
export type McpStateKind = "online" | "rejected" | "unreachable";

/** A server that didn't answer as one should, with the state it leaves the server in. */
export class McpServerProblem extends Error {
  constructor(readonly state: Exclude<McpStateKind, "online">, message: string) { super(message); this.name = "McpServerProblem"; }
}

/** A server's address as kept: http or https, no credentials in it. A general server's token goes only over https. */
export function mcpUrl(raw: string, pool?: "general" | "private", token?: string): string {
  let url: URL;
  try { url = new URL(String(raw ?? "").trim()); } catch { throw new Error("the URL looks like https://mcp.example.com/mcp"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("an MCP server is a URL (streamable HTTP); a local server that runs a command isn't built yet");
  if (url.username || url.password) throw new Error("put the token in the Token field, not in the URL");
  if (pool === "general" && token && url.protocol !== "https:") throw new Error("a general server's token is sent only over https");
  url.hash = "";
  return url.toString();
}

/** The host (and port) of a server's URL, as resolveHost and the facts line want it. */
export const mcpHost = (url: string): string => new URL(url).host;

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
  const inner = new StreamableHttpTransport({ url: o.url, headers: headers(o.token), fetch: noRedirects(o.fetch) });
  const calls = new Set<JsonRpcId>();
  const inits = new Set<JsonRpcId>();
  const kept = (m: JsonRpcMessage): JsonRpcMessage | undefined => {
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
    start: () => inner.start(),
    async send(m) {
      if (isJsonRpcRequest(m)) {
        if (m.method === "tools/call") calls.add(m.id);
        if (m.method === "initialize") inits.add(m.id);
      }
      try {
        await inner.send(m);
      } catch (err) {
        if (isJsonRpcRequest(m)) o.state?.(mcpFailure(err));
        throw err;
      }
    },
    close: () => inner.close(),
    onMessage: (listener) => inner.onMessage((m) => { const out = kept(m); if (out) listener(out); }),
    onError: (listener) => inner.onError(listener),
    onClose: (listener) => inner.onClose(listener),
    setProtocolVersion: (v) => inner.setProtocolVersion(v),
  };
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
 * Checks a server before it is saved: an MCP `initialize` and `tools/list`,
 * which must answer within 15 seconds. Throws McpServerProblem.
 */
export async function probeMcp(url: string, token?: string, f?: typeof fetch): Promise<McpProbe> {
  const client = new McpClient({ name: "lyrica", version: "1", requestTimeoutMs: 15_000 });
  const transport = new StreamableHttpTransport({ url, headers: headers(token), fetch: noRedirects(f), openGetStream: false });
  try {
    const init = await client.connect(transport);
    const tools = await client.listTools({ timeoutMs: 15_000 });
    const line = (init.instructions ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? init.serverInfo?.title ?? null;
    return { tools: tools.length, description: line ? line.slice(0, 200) : null };
  } catch (err) {
    const state = mcpFailure(err);
    throw new McpServerProblem(state, state === "rejected" ? `${mcpHost(url)} rejected the token` : `${mcpHost(url)} didn't answer as an MCP server: ${(err as Error).message}`);
  } finally {
    await client.close().catch(() => {});
  }
}
