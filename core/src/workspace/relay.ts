import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import * as tls from "node:tls";
import { createSecureContext, TLSSocket, type SecureContext } from "node:tls";
import { makeAuthority } from "./certs.ts";
import type { GitKind } from "./settings.ts";

// A sandbox run's way to the services its credentials are for (docs/workspace.md,
// "Credentials"). The tokens stay in lyricad: the run gets this relay's
// address, forwarded into its sandbox, a random capability that opens it,
// and a random placeholder for each token. Claude Code reaches Anthropic
// through it as its base URL; git, gh and tea reach their Git hosts through
// it as an HTTPS proxy. For a Git host the relay ends TLS itself, with a
// certificate from an authority made for this run, and swaps a placeholder
// for its token only on that repository's paths and its host's API.
// Anywhere else a placeholder is refused. It logs nothing and keeps
// nothing, and closes when the run ends, so what a run's environment holds
// is worth nothing afterwards or anywhere else.

/** Where Claude Code's requests go, and the host a run's network must reach for it to be given Claude Code. */
export const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_HOST = "api.anthropic.com";

/** A repository whose account's token the relay holds for a run. */
export interface ForgeCredential {
  /** owner/name on its host. */
  repo: string;
  kind: GitKind;
  /** host or host:port. */
  host: string;
  token: string;
  /** What the run holds instead. */
  placeholder: string;
}

export interface RelaySpec {
  /** The Claude Code token. */
  anthropic?: string;
  forge?: ForgeCredential[];
  /** Whether the run's network reaches a host (host or host:port): the relay goes nowhere it doesn't. */
  reaches: (host: string) => boolean;
  /** Whether the run has the internet: gh's downloads pass through only then. */
  internet: boolean;
  /** Where a host's requests go instead of https://host: for tests. */
  upstreams?: Record<string, string>;
  /** Called when the relay forwards a successful pull request create: only the repository and its number, never the body (docs/briefs/ci-wakes.md). */
  onPullCreate?: (pr: { repo: string; number: number }) => void;
  /** Called after each Claude Code message request with its token counts only, never its text: for the usage view. */
  onUsage?: (usage: ClaudeCodeUsage) => void;
}

/** One Claude Code request's tokens: `inputTokens` counts every prompt token read, cached or not. */
export interface ClaudeCodeUsage { inputTokens: number; outputTokens: number }

export interface Relay {
  /** The loopback port the relay listens on, forwarded into the run's sandbox. */
  port: number;
  /** What opens it: the bearer token for Anthropic, the proxy password for Git. Random, for this run only. */
  capability: string;
  /** The run's certificate authority, which the run trusts for its Git hosts; none without Git credentials. */
  ca?: string;
  close(): void;
}

/** Headers never passed on: the proxy's own, and what Node's request sets itself. */
const DROPPED = new Set(["host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "transfer-encoding", "upgrade"]);

/**
 * Hosts gh's downloads are redirected to (logs, artifacts, archives),
 * passed through untouched when the run has the internet: they need no
 * token, and the run could reach them anyway.
 */
const DOWNLOADS = [/\.githubusercontent\.com$/, /^codeload\.github\.com$/, /\.blob\.core\.windows\.net$/];

/**
 * What the relay trusts upstream: Node's roots and the host system's, as git
 * in the sandbox did, so a Forgejo behind a CA only this machine trusts still
 * works. Node before 22.15 has no way to read the system's, so there it
 * trusts Node's own roots only.
 */
let trusted: string[] | undefined;
const upstreamCAs = () => typeof tls.getCACertificates !== "function" ? undefined
  : trusted ??= [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])];

/** host:port as a CONNECT names it, without :443. */
const target = (hostPort: string) => hostPort.toLowerCase().replace(/:443$/, "");
const hostname = (t: string) => t.replace(/^\[(.*)\](:\d+)?$/, "$1").replace(/:\d+$/, "");

/** Whether a path, decoded as a server would, stays where it starts: no `.` or `..` segment, no `//`. */
function plain(path: string): boolean {
  let d: string;
  try { d = decodeURIComponent(path.split("?")[0]!); } catch { return false; }
  return !d.includes("//") && !d.split(/[/\\]/).some((x) => x === "." || x === "..");
}

/** Whether a placeholder for `c` may be swapped on a request to `to` for `path`. */
function allowed(c: ForgeCredential, to: string, path: string): boolean {
  const host = target(c.host);
  const p = path.toLowerCase();
  if (c.kind === "github" && host === "github.com" && (to === "api.github.com" || to === "uploads.github.com")) return true;
  // On the Git host itself: the repository's own Git paths and the host's API, never a way out of them.
  if (to !== host || !plain(path)) return false;
  if (p.startsWith(`/${c.repo.toLowerCase()}.git/`)) return true;
  if (c.kind === "github") return host !== "github.com" && p.startsWith("/api/");
  return (c.kind === "gitea" || c.kind === "forgejo") && p.startsWith("/api/v1/");
}

/** The Git hosts a credential is used on: its own, and GitHub's API hosts. */
const hostsOf = (c: ForgeCredential) => target(c.host) === "github.com" && c.kind === "github"
  ? ["github.com", "api.github.com", "uploads.github.com"] : [target(c.host)];

/** A forge's "pull created" answer fits easily in this; anything larger is piped on without a record. */
const CAPTURE_LIMIT = 64 * 1024;

/** Whether a request, with this credential, is that repository's pull request create (docs/briefs/ci-wakes.md step 1). */
function pullCreatePath(c: ForgeCredential, method: string | undefined, path: string): boolean {
  if (method !== "POST") return false;
  const p = path.toLowerCase().split("?")[0]!;
  if (c.kind === "github") return p === `/repos/${c.repo.toLowerCase()}/pulls`;
  return (c.kind === "forgejo" || c.kind === "gitea") && p === `/api/v1/repos/${c.repo.toLowerCase()}/pulls`;
}

/** The only fact from a create's answer: its number, with the repository already known. Nothing else is kept. */
function notePullCreate(c: ForgeCredential, body: Buffer, onPullCreate: NonNullable<RelaySpec["onPullCreate"]>): void {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { return; }
  const number = (parsed as { number?: unknown } | null)?.number;
  if (typeof number !== "number" || !Number.isInteger(number)) return;
  onPullCreate({ repo: c.repo, number });
}

/** A JSON answer's usage is its last field, and a stream's usage event is short: no more than this is held to read them. */
const USAGE_LIMIT = 16 * 1024;
const USAGE_EVENTS = new Set(["message_start", "message_delta"]);

/** Merges one usage object into the counts so far: later counts (message_delta's are cumulative) replace earlier ones. */
function mergeUsage(into: Record<string, number>, u: unknown): void {
  if (!u || typeof u !== "object") return;
  for (const key of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]) {
    const n = (u as Record<string, unknown>)[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) into[key] = n;
  }
}

const totalUsage = (u: Record<string, number>): ClaudeCodeUsage | undefined => (Object.keys(u).length ? {
  inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
  outputTokens: u.output_tokens ?? 0,
} : undefined);

/**
 * Reads a /v1/messages answer's token counts beside it as it passes, never
 * holding it back. A stream's come from its message_start and message_delta
 * events only, and every other event's data (where the text is) is skipped
 * unread; a JSON answer's come from the `usage` object at its end, of which
 * only a short tail is held. Nothing is kept once the counts are out.
 */
function usageReader(type: string, done: (usage: ClaudeCodeUsage) => void): { data(chunk: Buffer): void; end(): void } {
  const counts: Record<string, number> = {};
  const finish = () => { const u = totalUsage(counts); if (u) done(u); };
  if (/^text\/event-stream/i.test(type)) {
    let line = "", event = "", skipping = false;
    const wanted = (l: string) => l.startsWith("event:") || (l.startsWith("data:") && USAGE_EVENTS.has(event));
    const take = (l: string) => {
      if (l === "") { event = ""; return; }
      if (l.startsWith("event:")) { event = l.slice(6).trim(); return; }
      if (!l.startsWith("data:") || !USAGE_EVENTS.has(event)) return;
      let data: { message?: { usage?: unknown }; usage?: unknown };
      try { data = JSON.parse(l.slice(5)); } catch { return; }
      mergeUsage(counts, event === "message_start" ? data.message?.usage : data.usage);
    };
    return {
      data(chunk) {
        let text = chunk.toString("latin1");
        while (text) {
          const nl = text.indexOf("\n");
          if (!skipping) {
            line += nl < 0 ? text : text.slice(0, nl);
            // Once a line shows it is another event's, the rest of it is never held.
            if ((line.length >= 6 && !wanted(line)) || line.length > USAGE_LIMIT) { line = ""; skipping = true; }
          }
          if (nl < 0) break;
          if (!skipping) take(Buffer.from(line.replace(/\r$/, ""), "latin1").toString("utf8"));
          line = ""; skipping = false;
          text = text.slice(nl + 1);
        }
      },
      end: finish,
    };
  }
  if (!/^application\/json/i.test(type)) return { data() {}, end() {} };
  let tail = Buffer.alloc(0);
  return {
    data(chunk) { tail = Buffer.concat([tail, chunk]); if (tail.length > USAGE_LIMIT) tail = tail.subarray(tail.length - USAGE_LIMIT); },
    end() {
      const s = tail.toString("utf8");
      tail = Buffer.alloc(0);
      const open = s.indexOf("{", s.lastIndexOf('"usage"'));
      if (s.lastIndexOf('"usage"') < 0 || open < 0) return;
      let depth = 0;
      for (let i = open; i < s.length; i++) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}" && --depth === 0) {
          try { mergeUsage(counts, JSON.parse(s.slice(open, i + 1))); } catch { return; }
          return finish();
        }
      }
    },
  };
}

/** Opens a relay for one run. */
export async function openRelay(spec: RelaySpec): Promise<Relay> {
  const capability = randomBytes(32).toString("base64url");
  const forge = spec.forge ?? [];
  const same = (given: string, expected: string) => {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const authority = forge.length ? makeAuthority() : undefined;
  const contexts = new Map<string, SecureContext>();
  const contextFor = (host: string) => {
    if (!contexts.has(host)) contexts.set(host, createSecureContext(authority!.issue(host)));
    return contexts.get(host)!;
  };
  const ends = new Set(forge.flatMap(hostsOf).filter((h) => spec.reaches(h)));
  const sockets = new Set<Socket>();
  const track = (s: Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => s.destroy()); return s; };

  const forward = (to: string, path: string, req: IncomingMessage, res: ServerResponse, headers: IncomingHttpHeaders, capture?: (body: Buffer) => void,
    onUsage?: (usage: ClaudeCodeUsage) => void) => {
    const base = new URL(spec.upstreams?.[to] ?? `https://${to}`);
    const request = base.protocol === "https:" ? httpsRequest : httpRequest;
    const out = request({ protocol: base.protocol, hostname: hostname(base.host), port: base.port || undefined, method: req.method, path, headers,
      ...base.protocol === "https:" ? { ca: upstreamCAs() } : {} }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      if (onUsage && up.statusCode === 200 && !up.headers["content-encoding"]) {
        // Each chunk goes on as it comes; the counts are read beside it.
        const usage = usageReader(String(up.headers["content-type"] ?? ""), onUsage);
        up.on("data", (c: Buffer) => {
          // As pipe does: a slow reader holds the upstream back rather than filling memory.
          if (!res.write(c)) { up.pause(); res.once("drain", () => up.resume()); }
          try { usage.data(c); } catch { /* counting never breaks the answer */ }
        });
        up.on("end", () => { res.end(); try { usage.end(); } catch { /* as above */ } });
        up.on("error", () => res.destroy());
        return;
      }
      if (!capture) { up.pipe(res); return; }
      // A create's answer is small and worth a look; anything larger is piped on without a record.
      const chunks: Buffer[] = [];
      let size = 0;
      up.on("data", (c: Buffer) => { res.write(c); if (size < CAPTURE_LIMIT) { chunks.push(c); size += c.length; } });
      up.on("end", () => { res.end(); if (size <= CAPTURE_LIMIT) capture(Buffer.concat(chunks)); });
      up.on("error", () => res.destroy());
    });
    out.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    req.pipe(out);
  };
  const refuse = (req: IncomingMessage, res: ServerResponse, status: number, body: string, type = "text/plain") => {
    req.resume();
    res.writeHead(status, { "content-type": type }).end(body);
  };
  const passed = (req: IncomingMessage, drop: string[] = []) => {
    const headers: IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROPPED.has(k) && !drop.includes(k)) headers[k] = v;
    return headers;
  };

  // Claude Code: plain HTTP to the relay as its base URL, the capability as its bearer token.
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    if (!spec.anthropic || !same(String(req.headers.authorization ?? ""), `Bearer ${capability}`) || !path.startsWith("/v1/")) {
      return refuse(req, res, 401, '{"type":"error","error":{"type":"authentication_error","message":"not this run\'s relay"}}', "application/json");
    }
    const headers: IncomingHttpHeaders = { ...passed(req, ["authorization", "x-api-key"]), authorization: `Bearer ${spec.anthropic}` };
    // A message request's answer is read for its token counts, so it is asked for uncompressed.
    const messages = !!spec.onUsage && req.method === "POST" && path.split("?")[0] === "/v1/messages";
    if (messages) headers["accept-encoding"] = "identity";
    forward(ANTHROPIC_HOST, path, req, res, headers, undefined, messages ? spec.onUsage : undefined);
  });

  // Git: requests that came through CONNECT to one of its hosts, after the relay ended their TLS.
  const via = new WeakMap<object, string>();
  const git = createServer((req, res) => {
    const to = via.get(req.socket)!;
    const path = req.url ?? "/";
    const headers = passed(req);
    const auth = String(req.headers.authorization ?? "");
    let c: ForgeCredential | undefined;
    if (auth) {
      const [scheme = "", value = ""] = auth.trim().split(/\s+/, 2);
      const basic = /^basic$/i.test(scheme) ? Buffer.from(value, "base64").toString() : undefined;
      const secret = basic === undefined ? value : basic.slice(basic.indexOf(":") + 1);
      c = forge.find((x) => same(secret, x.placeholder));
      if (c ? !allowed(c, to, path) : forge.some((x) => auth.includes(x.placeholder) || basic?.includes(x.placeholder))) {
        return refuse(req, res, 403, `This run's Git credential isn't for ${to}${path.split("?")[0]}.\n`);
      }
      if (c) headers.authorization = basic === undefined ? `${scheme} ${c.token}` : `Basic ${Buffer.from(`${basic.slice(0, basic.indexOf(":"))}:${c.token}`).toString("base64")}`;
    }
    if (c && spec.onPullCreate && pullCreatePath(c, req.method, path)) forward(to, path, req, res, headers, (body) => notePullCreate(c!, body, spec.onPullCreate!));
    else forward(to, path, req, res, headers);
  });

  server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    track(socket);
    const proxyAuth = String(req.headers["proxy-authorization"] ?? "");
    const decoded = /^basic\s+/i.test(proxyAuth) ? Buffer.from(proxyAuth.replace(/^basic\s+/i, ""), "base64").toString() : "";
    if (!forge.length || !same(decoded.slice(decoded.indexOf(":") + 1), capability)) {
      return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="lyrica"\r\nContent-Length: 0\r\n\r\n');
    }
    const to = target(req.url ?? "");
    if (ends.has(to)) {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      const tls = track(new TLSSocket(socket, { isServer: true, secureContext: contextFor(hostname(to)) }));
      via.set(tls, to);
      git.emit("connection", tls);
    } else if (spec.internet && /:443$/.test(req.url ?? "") && DOWNLOADS.some((d) => d.test(hostname(to)))) {
      const up = track(connect(443, hostname(to), () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) up.write(head);
        up.pipe(socket).pipe(up);
      }));
      up.on("error", () => socket.destroy());
    } else {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    }
  });

  // No keep-alive across runs: close() ends every connection.
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    port: (server.address() as AddressInfo).port,
    capability,
    ca: authority?.cert,
    close: () => {
      server.close();
      server.closeAllConnections();
      for (const s of sockets) s.destroy();
    },
  };
}
