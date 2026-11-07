// What `lyrica chat` and `lyrica mem` share: lyricad's API over its Unix
// socket, a login whose cookie lives only in this process, and the prompts.
// Nothing here writes a file (docs/briefs/terminal-clients.md).
import { request } from "node:http";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { LoginResponse, Pool, State, ThreadEvent } from "@lyrica/daemon/api";

/** The group socket install.sh and the NixOS module make; else the runtime's own. */
export const CLIENT_SOCKET = "/run/lyrica-clients/lyricad.sock";

/** The socket to use: --socket, LYRICA_SOCKET, the group socket, then `<runtime>/lyricad.sock`. */
export function socketPath(opts: { socket?: string; runtime?: string }): string {
  if (opts.socket) return opts.socket;
  if (process.env.LYRICA_SOCKET) return process.env.LYRICA_SOCKET;
  if (!opts.runtime) {
    try { accessSync(CLIENT_SOCKET, constants.R_OK | constants.W_OK); return CLIENT_SOCKET; } catch { /* not this account's */ }
  }
  return join(opts.runtime ?? process.env.LYRICA_HOME ?? "runtime", "lyricad.sock");
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Plain words for a socket that isn't there or isn't this account's. */
function unreachable(path: string, err: NodeJS.ErrnoException): Error {
  if (err.code === "EACCES") return new Error(`${path}: this account can't use it; ask the operator to add you to the lyrica-clients group, or run as root`);
  if (err.code === "ENOENT" || err.code === "ECONNREFUSED") return new Error(`${path}: lyricad isn't running`);
  return new Error(`${path}: ${err.message}`);
}

/** Strips terminal control sequences and characters, keeping newlines and tabs. */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, "");
}

/** A signed-in client. The cookie is held in memory and gone when the process exits. */
export class Client {
  private cookie?: string;
  userId?: string;
  constructor(readonly socket: string) {}

  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const req = request({
        socketPath: this.socket, method, path,
        headers: {
          host: "localhost", origin: "http://localhost",
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
        },
      }, (res) => {
        const set = res.headers["set-cookie"]?.[0];
        if (set) { const value = set.split(";")[0]!; this.cookie = value.endsWith("=") ? undefined : value; }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            const message = (json as { error?: string } | undefined)?.error ?? `lyricad answered ${status}`;
            return reject(new ApiError(status, message));
          }
          resolve(json as T);
        });
      });
      req.on("error", (err) => reject(unreachable(this.socket, err)));
      req.end(data);
    });
  }

  get<T = unknown>(path: string) { return this.call<T>("GET", path); }
  post<T = unknown>(path: string, body: unknown = {}) { return this.call<T>("POST", path, body); }

  /** `/api/u/<user>` + rest. */
  u(rest: string): string {
    if (!this.userId) throw new Error("not signed in");
    return `/api/u/${encodeURIComponent(this.userId)}${rest}`;
  }

  async login(login: string, password: string): Promise<void> {
    const res = await this.post<LoginResponse>("/api/login", { login, password });
    this.userId = res.user.id;
  }

  async logout(): Promise<void> {
    if (!this.cookie) return;
    try { await this.post("/api/logout", {}); } catch { /* the session ends with the process anyway */ }
    this.cookie = undefined;
  }

  /** Reads a thread's event stream until `close` is called or the server ends it. */
  events(pool: Pool, threadId: string, onEvent: (e: ThreadEvent) => void): { close: () => void; ended: Promise<void> } {
    let closed = false;
    let req: ReturnType<typeof request> | undefined;
    const ended = new Promise<void>((resolve) => {
      req = request({
        socketPath: this.socket, method: "GET",
        path: this.u(`/threads/${pool}/${encodeURIComponent(threadId)}/events`),
        headers: { host: "localhost", ...(this.cookie ? { cookie: this.cookie } : {}) },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(); }
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!data) continue;
            try { onEvent(JSON.parse(data) as ThreadEvent); } catch { /* a bad event is skipped */ }
          }
        });
        res.on("end", () => resolve());
        res.on("close", () => resolve());
      });
      req.on("error", () => resolve());
      req.end();
    });
    return { close: () => { if (!closed) { closed = true; req?.destroy(); } }, ended };
  }
}

/** The prompts a client asks through, so tests can drive one without a terminal. */
export interface Io {
  /** One line; hidden input isn't echoed. `initial` prefills an editable line. */
  ask(question: string, opts?: { hidden?: boolean; initial?: string }): Promise<string>;
  /** Writes to standard output, already made printable. */
  out(text: string): void;
  /** Writes a message to standard error. */
  err(text: string): void;
  /** Ctrl-C while waiting on her: calls `fn`, returns a function that stops listening. */
  onInterrupt(fn: () => void): () => void;
}

/** Logs in with a login name (asked if not given) and a password read at a hidden prompt. */
export async function signIn(io: Io, socket: string, login?: string): Promise<Client> {
  const client = new Client(socket);
  const state = await client.get<State>("/api/state");
  if (state.setup) throw new Error("Lyrica is still being set up; finish the setup page first");
  if (state.locked) throw new Error("Lyrica is locked; unlock her from the web page or with lyrica serve at a terminal");
  const name = login || (await io.ask("Login: "));
  const password = await io.ask("Password: ", { hidden: true });
  try {
    await client.login(name, password);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw new Error("wrong login or password");
    throw err;
  }
  return client;
}

/** Ctrl-C at a prompt: the client stops what it was asking. */
export class Interrupted extends Error {
  constructor() { super("interrupted"); }
}

/** Reads one line from the terminal; hidden input isn't echoed. */
export async function askLine(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("lyrica reads passwords only at a terminal prompt");
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { done(); return resolve(hidden ? buf : buf.trim()); }
        if (ch === "\u0003") { done(); return reject(new Interrupted()); }
        if (ch === "\u007f" || ch === "\b") {
          if (buf && !hidden) process.stderr.write("\b \b");
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
          if (!hidden) process.stderr.write(ch);
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

/**
 * The terminal: readline for visible lines, with its history kept in this
 * process only (never saved), and the raw prompt for hidden ones.
 */
export function terminalIo(): Io {
  const history: string[] = [];
  return {
    async ask(question, opts = {}) {
      if (opts.hidden) return askLine(question, true);
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY, history: [...history], historySize: 200, removeHistoryDuplicates: true });
      return new Promise<string>((resolve, reject) => {
        let answered = false;
        rl.on("SIGINT", () => { answered = true; rl.close(); process.stderr.write("\n"); reject(new Interrupted()); });
        rl.on("close", () => { if (!answered) reject(new Interrupted()); });
        rl.question(question, (line) => {
          answered = true;
          if (line.trim()) history.unshift(line);
          rl.close();
          resolve(line);
        });
        if (opts.initial) rl.write(opts.initial);
      });
    },
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
    onInterrupt(fn) {
      process.on("SIGINT", fn);
      return () => void process.off("SIGINT", fn);
    },
  };
}
