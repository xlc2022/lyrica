// HTTPS GETs for fetch: https only, every address and redirect checked, and
// the hub token sent only to the host it was meant for.
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { AddressRefused, guardedLookup, isPublic } from "./guard.ts";

export interface NetOptions {
  /** Which addresses may be connected to. Tests allow their own fake hub. */
  allowed?: (address: string) => boolean;
  /** Extra trusted certificates, for tests. */
  ca?: string;
}

export class DownloadError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/** A plain sentence for any error on the way to a server. */
export function plainError(e: unknown): DownloadError {
  if (e instanceof DownloadError) return e;
  const code = (e as { code?: string })?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new DownloadError("Couldn't find the server's address.", 503);
  if (code.startsWith("ERR_TLS") || code.includes("CERT")) return new DownloadError("The server's certificate isn't valid.", 503);
  return new DownloadError("Couldn't reach the server.", 503);
}

export interface Get {
  url: string;
  token?: string;
  /** The hub's own host: the token goes there and nowhere else, never to a CDN it redirects to. */
  tokenHost?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class Net {
  private readonly lookup: ReturnType<typeof guardedLookup>;
  private readonly allowed: (address: string) => boolean;
  private readonly ca?: string;

  constructor(o: NetOptions = {}) {
    this.allowed = o.allowed ?? isPublic;
    this.lookup = guardedLookup(this.allowed);
    this.ca = o.ca;
  }

  /** GETs `url`, following up to 10 redirects. Resolves with a 2xx response. */
  async get(g: Get): Promise<IncomingMessage> {
    let url = new URL(g.url);
    for (let hop = 0; hop <= 10; hop++) {
      if (url.protocol !== "https:") throw new DownloadError("Only https links are allowed.");
      // Node connects to an address given literally without calling lookup, so check it here.
      const literal = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(literal) && !this.allowed(literal)) throw new DownloadError(`${literal} is a private or local address, which downloads may not use.`);
      const headers: Record<string, string> = { "user-agent": "lyrica-host-fetch", ...g.headers };
      if (g.token && g.tokenHost && url.hostname === g.tokenHost) headers.authorization = `Bearer ${g.token}`;
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = https.get(url, { headers, lookup: this.lookup as never, ca: this.ca, signal: g.signal, timeout: 60_000 }, resolve);
        req.on("timeout", () => req.destroy(new DownloadError("The server stopped answering.", 503)));
        req.on("error", (e) => reject(e instanceof AddressRefused ? new DownloadError(e.message) : e));
      });
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        url = new URL(res.headers.location, url);
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        if (status === 401 || status === 403) throw new DownloadError("This repository needs an access token, or the token can't read it.", status);
        if (status === 404) throw new DownloadError("Not found on the hub.", status);
        throw new DownloadError(`The server answered ${status}.`, status);
      }
      return res;
    }
    throw new DownloadError("Too many redirects.");
  }

  async json(g: Get): Promise<any> {
    const res = await this.get({ ...g, headers: { accept: "application/json", ...g.headers } });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of res) {
      size += (c as Buffer).length;
      if (size > 32 << 20) throw new DownloadError("The hub's answer is too large.");
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
}
