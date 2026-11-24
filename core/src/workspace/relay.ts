import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { lookup } from "node:dns/promises";
import { connect, isIP, type AddressInfo, type Socket } from "node:net";
import * as tls from "node:tls";
import { createSecureContext, TLSSocket, type SecureContext } from "node:tls";
import { tailnetProxied, tailnetSocket, viaTailnet } from "../models/tailnet.ts";
import { makeAuthority } from "./certs.ts";
import type { Dialer } from "./mullvad.ts";
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
  /** Reading only: clone, fetch and the API's reads; a push or a write through the API is refused here, whatever the token allows. */
  readOnly?: boolean;
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
  /** Called when Anthropic refuses a Claude Code request because the user's Claude plan reached its usage limit, with when it resets if it says. */
  onLimit?: (until?: number) => void;
  /**
   * Uploads off (Network.uploads): the run's internet is only this relay, which ends TLS for any host and passes
   * reads alone (`readOnlyRequest`); a credential still writes, but only to its own repository. `refused` says which
   * addresses the run's internet never reaches: this machine's own, as the firewall shuts them.
   */
  readOnlyInternet?: { refused(address: string): boolean };
  /**
   * Mullvad on (Network.mullvad): the run's internet is only this relay, and every connection it makes for the run
   * goes through this dialer (mullvad.ts), names looked up inside the tunnel; while the tunnel is down it fails rather
   * than going direct. With uploads on a CONNECT is tunnelled as it is, without ending its TLS. Claude Code's calls to
   * Anthropic are model calls and stay as they are.
   */
  mullvad?: Dialer;
}

/** One Claude Code request's tokens: `inputTokens` counts every prompt token read, cached or not. `model` is the model that answered, when it said. */
export interface ClaudeCodeUsage { inputTokens: number; outputTokens: number; model?: string }

export interface Relay {
  /** The loopback port the relay listens on, forwarded into the run's sandbox. */
  port: number;
  /** What opens it: the bearer token for Anthropic, the proxy password for Git. Random, for this run only. */
  capability: string;
  /** The run's certificate authority, which the run trusts for its Git hosts and, with uploads off, every host; none without either. */
  ca?: string;
  /** Its host certificates' one key, for Chromium (certs.ts `leafKey`). */
  leafKey?: string;
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

/**
 * How an upstream on her tailnet is reached: through her tailscaled's proxy,
 * with TLS inside the tunnel, as a model host is (core/src/models/tailnet.ts).
 * Node's request takes its own connection for that one request, as does a
 * Git host's name while the proxy is in use (its lookup decides); every other
 * host keeps the default agent and its kept-alive connections.
 */
function tunnelTo(host: string, port: number, secure: boolean, mayResolveInto: boolean): Pick<RequestOptions, "createConnection"> {
  // A Git host's name may point into the tailnet (a public name with a 100.x record): only the lookup says.
  if (!viaTailnet(host) && !(mayResolveInto && tailnetProxied() && !isIP(host))) return {};
  const createConnection: NonNullable<RequestOptions["createConnection"]> = (o, cb) => {
    tailnetSocket(host, port).then((raw) => {
      if (!secure) return cb(null, raw ?? connect(port, host));
      const { ca } = o as tls.ConnectionOptions;
      cb(null, tls.connect({ host, port, ca, ...(raw ? { socket: raw } : {}), ...(isIP(host) ? {} : { servername: host }) }));
    }, (err: Error) => cb(err, undefined as never));
    return undefined;
  };
  return { createConnection };
}

/** A request's own connection through Mullvad (RelaySpec.mullvad), with TLS inside it end to end. */
function throughMullvad(dial: Dialer, host: string, port: number, secure: boolean): Pick<RequestOptions, "createConnection" | "agent"> {
  const createConnection: NonNullable<RequestOptions["createConnection"]> = (o, cb) => {
    dial(host, port).then((raw) => {
      if (!secure) return cb(null, raw);
      const { ca } = o as tls.ConnectionOptions;
      cb(null, tls.connect({ socket: raw, ca, host, ...(isIP(host) ? {} : { servername: host }) }));
    }, (err: Error) => cb(err, undefined as never));
    return undefined;
  };
  // No agent: with one (agent: false makes a fresh one) Node would ignore createConnection.
  return { createConnection, agent: undefined };
}

/** host:port as a CONNECT names it, without :443. */
const target = (hostPort: string) => hostPort.toLowerCase().replace(/:443$/, "");
const hostname = (t: string) => /^\[([^\]]*)\](?::\d+)?$/.exec(t)?.[1] ?? t.replace(/:\d+$/, "");

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

/**
 * Whether a read-only credential's request only reads: a fetch on the
 * repository's Git paths (never `git-receive-pack`, which is a push), and on
 * an API GET or HEAD, or a GraphQL query (checked from its body).
 */
function readsOnly(c: ForgeCredential, to: string, method: string, path: string): "yes" | "no" | "graphql" {
  const p = path.toLowerCase();
  const [route = "", query = ""] = p.split("?");
  if (to === target(c.host) && route.startsWith(`/${c.repo.toLowerCase()}.git/`)) {
    if (route.endsWith("/git-receive-pack") || /(^|&)service=git-receive-pack(&|$)/.test(query)) return "no";
    if (method === "GET" || method === "HEAD") return "yes";
    return method === "POST" && route.endsWith("/git-upload-pack") ? "yes" : "no";
  }
  if (method === "GET" || method === "HEAD") return "yes";
  return method === "POST" && (route === "/graphql" || route === "/api/graphql") ? "graphql" : "no";
}

/** Whether a GraphQL request only queries: one JSON body (or a batch) whose documents hold no mutation. A body that doesn't parse is a write. */
function graphqlReads(body: Buffer): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { return false; }
  const docs = (Array.isArray(parsed) ? parsed : [parsed]).map((x) => (x as { query?: unknown } | null)?.query);
  // Strings and comments can't hide an operation keyword from this: any "mutation" or "subscription" word refuses it.
  return docs.length > 0 && docs.every((q) => typeof q === "string" && !/\b(mutation|subscription)\b/.test(q));
}

/** Headers some servers take as the real method. */
const METHOD_OVERRIDES = ["x-http-method-override", "x-http-method", "x-method-override"];

/** A GraphQL query's body is read before it goes on; anything larger is refused for a read-only credential. */
const GRAPHQL_LIMIT = 256 * 1024;

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

/** Whether a GitHub GraphQL request body holds a createPullRequest mutation, as `gh pr create` sends. */
function graphqlCreatesPull(body: Buffer): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { return false; }
  const query = (parsed as { query?: unknown } | null)?.query;
  return typeof query === "string" && /\bmutation\b/.test(query) && /\bcreatePullRequest\b/.test(query);
}

/**
 * The number from a GraphQL create's answer: `pullRequest.number`, or the
 * number in its `url` (gh asks only for the id and url). The mutation names
 * the repository by node ID, so the answer's url must be this credential's
 * repository; nothing else is kept.
 */
function noteGraphqlPullCreate(c: ForgeCredential, body: Buffer, onPullCreate: NonNullable<RelaySpec["onPullCreate"]>): void {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { return; }
  const pull = (parsed as { data?: { createPullRequest?: { pullRequest?: { number?: unknown; url?: unknown } } } } | null)?.data?.createPullRequest?.pullRequest;
  if (!pull || typeof pull.url !== "string") return;
  let url: URL;
  try { url = new URL(pull.url); } catch { return; }
  const m = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (!m || m[1]!.toLowerCase() !== c.repo.toLowerCase()) return;
  const number = typeof pull.number === "number" ? pull.number : Number(m[2]);
  if (!Number.isInteger(number) || number !== Number(m[2])) return;
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

const totalUsage = (u: Record<string, number>, model: string | undefined): ClaudeCodeUsage | undefined => (Object.keys(u).length ? {
  inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
  outputTokens: u.output_tokens ?? 0,
  ...(model ? { model } : {}),
} : undefined);

/** A model ID as an answer names it, or nothing: only a short ID's characters are kept. */
const modelId = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(v) ? v : undefined);

/** A JSON answer names its model near its start, before its content: no more than this is held to read it. */
const MODEL_HEAD = 1024;

/**
 * Reads a /v1/messages answer's token counts beside it as it passes, never
 * holding it back. A stream's come from its message_start and message_delta
 * events only, and every other event's data (where the text is) is skipped
 * unread; a JSON answer's come from the `usage` object at its end, of which
 * only a short tail is held. The model comes from message_start, or from a
 * JSON answer's `model` field ahead of its content in a short head. Nothing
 * is kept once the counts are out.
 */
function usageReader(type: string, done: (usage: ClaudeCodeUsage) => void): { data(chunk: Buffer): void; end(): void } {
  const counts: Record<string, number> = {};
  let model: string | undefined;
  const finish = () => { const u = totalUsage(counts, model); if (u) done(u); };
  if (/^text\/event-stream/i.test(type)) {
    let line = "", event = "", skipping = false;
    const wanted = (l: string) => l.startsWith("event:") || (l.startsWith("data:") && USAGE_EVENTS.has(event));
    const take = (l: string) => {
      if (l === "") { event = ""; return; }
      if (l.startsWith("event:")) { event = l.slice(6).trim(); return; }
      if (!l.startsWith("data:") || !USAGE_EVENTS.has(event)) return;
      let data: { message?: { usage?: unknown; model?: unknown }; usage?: unknown };
      try { data = JSON.parse(l.slice(5)); } catch { return; }
      if (event === "message_start") model = modelId(data.message?.model) ?? model;
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
  let tail = Buffer.alloc(0), head = "";
  return {
    data(chunk) {
      if (head.length < MODEL_HEAD) head += chunk.subarray(0, MODEL_HEAD - head.length).toString("latin1");
      tail = Buffer.concat([tail, chunk]); if (tail.length > USAGE_LIMIT) tail = tail.subarray(tail.length - USAGE_LIMIT); },
    end() {
      const s = tail.toString("utf8");
      tail = Buffer.alloc(0);
      const named = /"model"\s*:\s*"([^"]*)"/.exec(head);
      const content = head.indexOf('"content"');
      if (named && (content < 0 || named.index < content)) model = modelId(named[1]);
      head = "";
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

/** The ports of every relay open now: no sandbox but the run's own may reach one (sandbox.ts excludes the others). */
const live = new Set<number>();
export const relayPorts = (): number[] => [...live];

/** What a run with uploads off may send to the internet. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);
/** A git fetch's request: wants and haves, refused past this. */
export const UPLOAD_PACK_LIMIT = 1024 * 1024;
/**
 * Where a git fetch's POST may go with uploads off, besides the hosts of the run's own Git credentials: forges whose
 * upload-pack endpoint reads the body as wants and haves, so a third party can't collect it there. Anywhere else the
 * body would be an upload channel (object ids are free-form hex), so a clone from another host uses the dumb protocol.
 */
export const PACK_HOSTS: readonly string[] = ["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"];
export const UPLOADS_OFF = "Uploads are off in this conversation: only GET, HEAD and OPTIONS requests (and a git fetch) reach the internet.\n";

/**
 * Whether a request only reads, for a run with uploads off: GET, HEAD or OPTIONS with no body, or a git fetch's
 * upload-pack POST (its body is held to UPLOAD_PACK_LIMIT as it passes). A method override, an upgrade (a WebSocket
 * sends both ways) or a body on a read is refused.
 */
export function readOnlyRequest(method: string | undefined, path: string, headers: IncomingHttpHeaders): "yes" | "upload-pack" | "no" {
  const m = String(method ?? "GET").toUpperCase();
  if (METHOD_OVERRIDES.some((h) => headers[h] !== undefined) || headers.upgrade !== undefined) return "no";
  const body = headers["transfer-encoding"] !== undefined || Number(headers["content-length"] ?? 0) > 0;
  if (READS.has(m)) return body ? "no" : "yes";
  const route = path.split("?")[0]!.toLowerCase();
  const type = String(headers["content-type"] ?? "").toLowerCase();
  return m === "POST" && route.endsWith("/git-upload-pack") && type.startsWith("application/x-git-upload-pack-request") ? "upload-pack" : "no";
}

/**
 * Whether a credential's write with uploads off stays in its own repository: a push to its Git paths, or its own
 * repository's REST API. Anything else it writes (another repository's issue, a gist) would carry text out.
 */
export function ownRepository(c: ForgeCredential, to: string, path: string): boolean {
  if (!plain(path)) return false;
  const route = path.split("?")[0]!.toLowerCase(), repo = c.repo.toLowerCase(), host = target(c.host);
  const under = (prefix: string) => route === prefix || route.startsWith(`${prefix}/`);
  if (to === host && route.startsWith(`/${repo}.git/`)) return true;
  if (c.kind === "github") return host === "github.com" ? (to === "api.github.com" || to === "uploads.github.com") && under(`/repos/${repo}`) : to === host && under(`/api/v3/repos/${repo}`);
  return (c.kind === "gitea" || c.kind === "forgejo") && to === host && under(`/api/v1/repos/${repo}`);
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
  const readOnly = spec.readOnlyInternet;
  const mullvad = spec.mullvad;
  const authority = forge.length || readOnly ? makeAuthority() : undefined;
  const contexts = new Map<string, SecureContext>();
  const contextFor = (host: string) => {
    if (!contexts.has(host)) contexts.set(host, createSecureContext(authority!.issue(host)));
    return contexts.get(host)!;
  };
  const ends = new Set(forge.flatMap(hostsOf).filter((h) => spec.reaches(h)));
  const sockets = new Set<Socket>();
  const track = (s: Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => s.destroy()); return s; };

  const forward = (to: string, path: string, req: IncomingMessage, res: ServerResponse, headers: IncomingHttpHeaders, capture?: (body: Buffer) => void,
    onUsage?: (usage: ClaudeCodeUsage) => void, body?: Buffer, rest = false) => {
    const base = new URL(spec.upstreams?.[to] ?? `https://${to}`);
    const secure = base.protocol === "https:";
    const request = secure ? httpsRequest : httpRequest;
    // The Host the client asked for, set here: with a connection of its own (tunnelTo) Node has no agent, takes 80 as the
    // default port and would send "github.com:80" over TLS, which GitHub answered with redirects until git gave up.
    const out = request({ protocol: base.protocol, hostname: hostname(base.host), port: base.port || undefined, method: req.method, path, headers: { ...headers, host: to },
      ...secure ? { ca: upstreamCAs() } : {},
      ...spec.mullvad && to !== ANTHROPIC_HOST && !spec.upstreams?.[to] ? throughMullvad(spec.mullvad, hostname(base.host), Number(base.port) || (secure ? 443 : 80), secure)
        : tunnelTo(hostname(base.host), Number(base.port) || (secure ? 443 : 80), secure, to !== ANTHROPIC_HOST) }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      // The plan's usage limit: a 429 whose unified rate limit is rejected, with its reset in seconds.
      if (to === ANTHROPIC_HOST && up.statusCode === 429 && up.headers["anthropic-ratelimit-unified-status"] === "rejected") {
        const reset = Number(up.headers["anthropic-ratelimit-unified-reset"]);
        try { spec.onLimit?.(reset > 0 ? reset * 1000 : undefined); } catch { /* telling never breaks the answer */ }
      }
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
      // A create's answer is asked for uncompressed; one that comes compressed anyway is passed on unread.
      if (!capture || up.headers["content-encoding"]) { up.pipe(res); return; }
      // A create's answer is small and worth a look; anything larger is piped on without a record.
      const chunks: Buffer[] = [];
      let size = 0;
      up.on("data", (c: Buffer) => { res.write(c); if (size < CAPTURE_LIMIT) { chunks.push(c); size += c.length; } });
      up.on("end", () => { res.end(); if (size <= CAPTURE_LIMIT) capture(Buffer.concat(chunks)); });
      up.on("error", () => res.destroy());
    });
    out.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    // `rest`: the body so far was read first, and the rest of the request follows it.
    if (body && rest) { out.write(body); req.pipe(out); } else if (body) out.end(body); else req.pipe(out);
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
    // Uploads off: a plain http request through the relay as its proxy (an absolute URL), to read.
    if ((readOnly || mullvad) && /^http:\/\//i.test(path)) {
      let url: URL;
      try { url = new URL(path); } catch { return refuse(req, res, 400, "Not a URL.\n"); }
      return readOnly ? outbound(url.host, false, `${url.pathname}${url.search}`, req, res) : passOn(url, req, res);
    }
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
    // Uploads off: what a credential writes stays in its own repository, and anything else only reads.
    if (readOnly && readOnlyRequest(req.method, path, req.headers) === "no" && !(c && ownRepository(c, to, path))) {
      const graphql = c && req.method === "POST" && readsOnly(c, to, "POST", path) === "graphql";
      if (!graphql || req.headers["content-encoding"]) return refuse(req, res, 403, UPLOADS_OFF);
      // A GraphQL query still reads, and gh's pull request create is its one write; any other mutation is refused.
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (d: Buffer) => { size += d.length; if (size <= GRAPHQL_LIMIT) chunks.push(d); });
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (size > GRAPHQL_LIMIT || !(graphqlReads(body) || (graphqlCreatesPull(body) && !c!.readOnly))) return refuse(req, res, 403, UPLOADS_OFF);
        const capture = graphqlCreatesPull(body) && spec.onPullCreate;
        if (capture) headers["accept-encoding"] = "identity";
        forward(to, path, req, res, headers, capture ? (answer) => noteGraphqlPullCreate(c!, answer, spec.onPullCreate!) : undefined, undefined, body);
      });
      return;
    }
    if (c?.readOnly) {
      const reads = readsOnly(c, to, String(req.method ?? "GET").toUpperCase(), path);
      const no = () => refuse(req, res, 403, `This run can only read ${c!.repo}: ${req.method} ${to}${path.split("?")[0]} would change it.\n`);
      // A method override would make a GET a write upstream: refused, so "GET reads" holds here, not by the forge's grace.
      if (reads === "no" || METHOD_OVERRIDES.some((h) => req.headers[h] !== undefined)) return no();
      if (reads === "graphql") {
        if (req.headers["content-encoding"]) return no();
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (d: Buffer) => { size += d.length; if (size <= GRAPHQL_LIMIT) chunks.push(d); });
        req.on("end", () => {
          const body = Buffer.concat(chunks);
          if (size > GRAPHQL_LIMIT || !graphqlReads(body)) return no();
          forward(to, path, req, res, headers, undefined, undefined, body);
        });
        return;
      }
    }
    // A pull request create is recorded for CI wakes; its answer is asked for uncompressed, as gh's client would gzip it.
    if (c && spec.onPullCreate && pullCreatePath(c, req.method, path)) {
      headers["accept-encoding"] = "identity";
      return forward(to, path, req, res, headers, (body) => notePullCreate(c!, body, spec.onPullCreate!));
    }
    if (c && spec.onPullCreate && c.kind === "github" && req.method === "POST" && readsOnly(c, to, "POST", path) === "graphql") {
      // gh pr create is a GraphQL mutation: its body is read first and sent on as it came. One past the limit isn't
      // a create gh sends: what was read goes on, with the rest of the request streamed after it.
      const chunks: Buffer[] = [];
      let size = 0;
      const data = (d: Buffer) => {
        chunks.push(d);
        size += d.length;
        if (size <= GRAPHQL_LIMIT) return;
        req.off("data", data).off("end", end).pause();
        forward(to, path, req, res, headers, undefined, undefined, Buffer.concat(chunks), true);
      };
      const end = () => {
        const body = Buffer.concat(chunks);
        if (req.headers["content-encoding"] || !graphqlCreatesPull(body)) return forward(to, path, req, res, headers, undefined, undefined, body);
        headers["accept-encoding"] = "identity";
        forward(to, path, req, res, headers, (answer) => noteGraphqlPullCreate(c!, answer, spec.onPullCreate!), undefined, body);
      };
      req.on("data", data).on("end", end);
      return;
    }
    forward(to, path, req, res, headers);
  });

  /**
   * A read going out with uploads off, to `to` (host or host:port) at an address the run's internet reaches: the name
   * is looked up here and the request goes to that address, so a name can't be pointed at this machine afterwards.
   */
  const outbound = (to: string, secure: boolean, path: string, req: IncomingMessage, res: ServerResponse) => {
    const kind = readOnlyRequest(req.method, path, req.headers);
    const host = hostname(to);
    if (kind === "no" || (kind === "upload-pack" && !PACK_HOSTS.includes(host.toLowerCase()) && !forge.some((c) => c.host.toLowerCase() === host.toLowerCase()))) return refuse(req, res, 403, UPLOADS_OFF);
    const port = Number(/^(?:\[[^\]]*\]|[^:]*):(\d+)$/.exec(to)?.[1] ?? (secure ? 443 : 80));
    const base = spec.upstreams?.[to] ? new URL(spec.upstreams[to]!) : undefined;
    const go = (address: string, p: number, tls: boolean, dial?: Dialer) => {
      const out = (tls ? httpsRequest : httpRequest)({
        host: address, port: p, method: req.method, path, agent: false, headers: { ...passed(req), host: to },
        ...tls ? { ca: upstreamCAs(), ...(isIP(host) ? {} : { servername: host }) } : {},
        ...dial ? throughMullvad(dial, address, p, tls) : {},
      }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        up.on("error", () => res.destroy());
      });
      out.on("error", (err) => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end(dial ? `${err.message}.\n` : `${to} couldn't be reached.\n`); else res.destroy(); });
      if (kind === "upload-pack") {
        let size = 0;
        req.on("data", (d: Buffer) => { size += d.length; if (size > UPLOAD_PACK_LIMIT) { out.destroy(); res.destroy(); } });
      }
      req.pipe(out);
    };
    if (base) return go(hostname(base.host), Number(base.port) || (base.protocol === "https:" ? 443 : 80), base.protocol === "https:");
    // Through Mullvad the name is looked up inside the tunnel, and the connection leaves from Mullvad's server, where
    // this machine's own addresses are as far away as any other host's.
    if (mullvad) return go(host, port, secure, mullvad);
    (isIP(host) ? Promise.resolve([host]) : lookup(host, { all: true, family: 4 }).then((a) => a.map((x) => x.address))).then((addresses) => {
      // IPv4 only, as the sandbox is: an IPv6 literal (::1, ::ffff:127.0.0.1) could reach this machine's loopback.
      if (addresses.some((a) => isIP(a) !== 4)) return refuse(req, res, 403, `${host} is an IPv6 address; with uploads off the internet is reached over IPv4 only.\n`);
      const address = addresses.find((a) => !readOnly!.refused(a));
      if (!address) return refuse(req, res, 403, `${host} is this machine, which the internet switch never reaches.\n`);
      go(address, port, secure);
    }, () => refuse(req, res, 502, `${host} doesn't resolve.\n`));
  };
  /** Mullvad on with uploads on: a plain http request through the relay as its proxy, sent on through the tunnel as it came. */
  const passOn = (url: URL, req: IncomingMessage, res: ServerResponse) => {
    const port = Number(url.port) || 80;
    const out = httpRequest({ host: url.hostname, port, method: req.method, path: `${url.pathname}${url.search}`, headers: { ...passed(req), host: url.host },
      ...throughMullvad(mullvad!, hostname(url.host), port, false) }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
      up.on("error", () => res.destroy());
    });
    out.on("error", (err) => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end(`${err.message}.\n`); else res.destroy(); });
    req.pipe(out);
  };
  // Uploads off: requests that came through CONNECT to any other host, after the relay ended their TLS.
  const web = createServer((req, res) => outbound(via.get(req.socket)!, true, req.url ?? "/", req, res));

  server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    track(socket);
    const proxyAuth = String(req.headers["proxy-authorization"] ?? "");
    const decoded = /^basic\s+/i.test(proxyAuth) ? Buffer.from(proxyAuth.replace(/^basic\s+/i, ""), "base64").toString() : "";
    const authed = same(decoded.slice(decoded.indexOf(":") + 1), capability);
    const to = target(req.url ?? "");
    // Uploads off: any host but a Git host's credentialed request is read here, with or without the capability
    // (Chromium sends none), since only this run's sandbox can reach this port.
    if (readOnly && !(authed && ends.has(to))) {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      const tls = track(new TLSSocket(socket, { isServer: true, secureContext: contextFor(hostname(to)) }));
      via.set(tls, to);
      return web.emit("connection", tls);
    }
    // Mullvad on with uploads on: any host but a Git host's credentialed request goes through the tunnel as it is,
    // its TLS untouched; while the tunnel is down the run is told why, and nothing goes direct.
    if (mullvad && !(authed && ends.has(to))) {
      const port = Number(/:(\d+)$/.exec(req.url ?? "")?.[1] ?? 443);
      mullvad(hostname(to), port).then((up) => {
        track(up);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) up.write(head);
        up.pipe(socket).pipe(up);
      }, (err: Error) => {
        const body = `${err.message}.\n`;
        socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      });
      return;
    }
    if (!forge.length || !authed) {
      return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="lyrica"\r\nContent-Length: 0\r\n\r\n');
    }
    if (ends.has(to)) {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      const tls = track(new TLSSocket(socket, { isServer: true, secureContext: contextFor(hostname(to)) }));
      via.set(tls, to);
      git.emit("connection", tls);
    } else if (spec.internet && !mullvad && /:443$/.test(req.url ?? "") && DOWNLOADS.some((d) => d.test(hostname(to)))) {
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
  const port = (server.address() as AddressInfo).port;
  live.add(port);
  return {
    port,
    capability,
    ca: authority?.cert,
    ...readOnly ? { leafKey: authority!.leafKey } : {},
    close: () => {
      live.delete(port);
      server.close();
      server.closeAllConnections();
      for (const s of sockets) s.destroy();
    },
  };
}
