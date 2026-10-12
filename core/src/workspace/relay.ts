import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { createSecureContext, getCACertificates, TLSSocket, type SecureContext } from "node:tls";
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
}

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
 * works.
 */
let trusted: string[] | undefined;
const upstreamCAs = () => trusted ??= [...new Set([...getCACertificates("default"), ...getCACertificates("system")])];

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

  const forward = (to: string, path: string, req: IncomingMessage, res: ServerResponse, headers: IncomingHttpHeaders) => {
    const base = new URL(spec.upstreams?.[to] ?? `https://${to}`);
    const request = base.protocol === "https:" ? httpsRequest : httpRequest;
    const out = request({ protocol: base.protocol, hostname: hostname(base.host), port: base.port || undefined, method: req.method, path, headers,
      ...base.protocol === "https:" ? { ca: upstreamCAs() } : {} }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
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
    forward(ANTHROPIC_HOST, path, req, res, { ...passed(req, ["authorization", "x-api-key"]), authorization: `Bearer ${spec.anthropic}` });
  });

  // Git: requests that came through CONNECT to one of its hosts, after the relay ended their TLS.
  const via = new WeakMap<object, string>();
  const git = createServer((req, res) => {
    const to = via.get(req.socket)!;
    const path = req.url ?? "/";
    const headers = passed(req);
    const auth = String(req.headers.authorization ?? "");
    if (auth) {
      const [scheme = "", value = ""] = auth.trim().split(/\s+/, 2);
      const basic = /^basic$/i.test(scheme) ? Buffer.from(value, "base64").toString() : undefined;
      const secret = basic === undefined ? value : basic.slice(basic.indexOf(":") + 1);
      const c = forge.find((x) => same(secret, x.placeholder));
      if (c ? !allowed(c, to, path) : forge.some((x) => auth.includes(x.placeholder) || basic?.includes(x.placeholder))) {
        return refuse(req, res, 403, `This run's Git credential isn't for ${to}${path.split("?")[0]}.\n`);
      }
      if (c) headers.authorization = basic === undefined ? `${scheme} ${c.token}` : `Basic ${Buffer.from(`${basic.slice(0, basic.indexOf(":"))}:${c.token}`).toString("base64")}`;
    }
    forward(to, path, req, res, headers);
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
