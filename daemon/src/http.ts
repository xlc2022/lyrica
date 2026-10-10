import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { AuthError, CloudModelForbidden, Forbidden, HostRefused, Locked, NoModel, Offline, PairingFailed, VoiceCloudOff, WrongPassword } from "@lyrica/core";
import { COOKIE } from "./auth.ts";

/** An error with an HTTP status. Its message is shown to the user. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

export interface Request {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** The route pattern, e.g. `/api/u/:userId/threads`. Logged instead of the path. */
  route: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /** The client's address: the proxy's X-Forwarded-For when it came through one on loopback. */
  ip: string;
  cookie: string | undefined;
  /** The parsed JSON body. */
  json<T>(): Promise<T>;
  /** The raw body, up to `limit` bytes. */
  bytes(limit: number): Promise<Buffer>;
}

export type Handler = (r: Request) => unknown;

export interface Route {
  method: string;
  pattern: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export function route(method: string, pattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_m, k: string) => { keys.push(k); return "([^/]+)"; })}$`);
  return { method, pattern, re, keys, handler };
}

export function match(routes: Route[], method: string, path: string): { route: Route; params: Record<string, string> } | "method" | undefined {
  let other = false;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    if (r.method !== method) { other = true; continue; }
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!); });
    return { route: r, params };
  }
  return other ? "method" : undefined;
}

const JSON_LIMIT = 1 << 20;

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) return reject(new HttpError(413, `too large: the limit is ${limit} bytes`));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `too large: the limit is ${limit} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Whose X-Forwarded-For a listener believes: on 127.0.0.1, the built-in Caddy's; on the extra listener, the external proxy's. */
export type TrustForwarded = (remote: string) => boolean;

export const fromLoopback: TrustForwarded = (remote) => remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";

export function makeRequest(req: IncomingMessage, res: ServerResponse, route: string, params: Record<string, string>, url: URL,
  trust: TrustForwarded = fromLoopback): Request {
  let body: Promise<Buffer> | undefined;
  const bytes = (limit: number) => (body ??= readBody(req, limit));
  return {
    req, res, method: req.method ?? "GET", route, params, query: url.searchParams, ip: clientIp(req, trust), cookie: cookieOf(req),
    bytes,
    async json<T>() {
      const raw = await bytes(JSON_LIMIT);
      if (!raw.length) return {} as T;
      try {
        return JSON.parse(raw.toString("utf8")) as T;
      } catch {
        throw new HttpError(400, "the body isn't valid JSON");
      }
    },
  };
}

function cookieOf(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

function clientIp(req: IncomingMessage, trust: TrustForwarded): string {
  const remote = req.socket.remoteAddress;
  if (!remote) return "local"; // the Unix socket
  const forwarded = req.headers["x-forwarded-for"];
  if (trust(remote) && typeof forwarded === "string") return forwarded.split(",").pop()!.trim() || remote;
  return remote;
}

/** An address as a client socket reports it, without the IPv4-mapped prefix. */
export const plainAddress = (a: string | undefined): string => (a ?? "").replace(/^::ffff:/, "");

/** A state-changing request must come from a page on this host. */
export function checkOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  let host: string | undefined;
  try {
    host = origin ? new URL(origin).host : undefined;
  } catch { /* refused below */ }
  if (!host || host !== req.headers.host) throw new HttpError(403, "cross-origin requests are refused");
}

/** Headers on every response: a strict CSP, no framing, no sniffing, no referrer. No CORS headers, ever. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body ?? { ok: true });
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(data);
}

/** The status for an error thrown by core or a handler. Validation errors are plain `Error`s with readable messages. */
export function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof Locked) return 503;
  if (err instanceof Forbidden) return 403;
  // 502 like a host that can't be reached: 503 means locked, and sends the web UI to unlock.
  if (err instanceof Offline) return 502;
  if (err instanceof AuthError || err instanceof WrongPassword) return 401;
  if (err instanceof CloudModelForbidden || err instanceof NoModel || err instanceof PairingFailed || err instanceof VoiceCloudOff) return 400;
  // A model host's refusal keeps its meaning; anything else from it is a bad gateway.
  if (err instanceof HostRefused) return ({ invalid: 400, refused: 403, not_found: 404, in_use: 409, too_big: 413, no_space: 507 } as Record<string, number>)[err.code] ?? 502;
  if (err instanceof Error && err.constructor === Error) return 400;
  return 500;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

/** Serves the built web UI. Unknown paths without an extension get index.html, for client-side routes. */
export function serveStatic(dir: string, path: string, res: ServerResponse): boolean {
  if (!existsSync(dir)) return false;
  const root = normalize(dir);
  let file = normalize(join(root, decodeURIComponent(path)));
  if (file !== root && !file.startsWith(root + sep)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(path)) return false;
    file = join(root, "index.html");
    if (!existsSync(file)) return false;
  }
  const hashed = /[.-][0-9a-zA-Z_-]{8,}\.(js|css|woff2|png|svg)$/.test(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
  return true;
}
