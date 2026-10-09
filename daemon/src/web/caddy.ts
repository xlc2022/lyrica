import { request } from "node:http";
import { provider } from "./providers.ts";

// The built-in Caddy: lyricad writes its whole JSON config through the admin
// API on a Unix socket. Caddy saves what it was given (`--resume`), so it keeps
// serving while lyricad is locked.

export const STAGING_CA = "https://acme-staging-v02.api.letsencrypt.org/directory";

export interface CaddySite {
  /** Lyrica's name, e.g. lyrica.example.net. */
  name: string;
  /** Host addresses to serve HTTPS on (Tailscale and/or LAN). */
  addresses: string[];
  /** HTTPS port; 443 outside tests. */
  port: number;
  provider: string;
  credentials: Record<string, string>;
  email?: string;
  staging: boolean;
  /** lyricad's own port on 127.0.0.1. */
  upstream: number;
}

export interface CaddyPaths {
  /** The admin socket, e.g. /run/lyrica-caddy/admin.sock. Caddy keeps it group-only (0660). */
  socket: string;
  /** Where Caddy writes TLS errors, for the status page. */
  tlsLog: string;
}

/** Caddy's config with no site: the admin socket only. Loaded in external mode. */
export function adminOnly(paths: CaddyPaths): Record<string, unknown> {
  return { admin: { listen: `unix/${paths.socket}|0660` } };
}

function issuer(site: CaddySite): Record<string, unknown> {
  const p = provider(site.provider);
  const dns: Record<string, string> = { name: p.id };
  for (const f of p.fields) {
    const value = site.credentials[f.name];
    if (value) dns[f.name] = value;
  }
  const out: Record<string, unknown> = { module: "acme", challenges: { dns: { provider: dns } } };
  if (site.email) out.email = site.email;
  if (site.staging) out.ca = STAGING_CA;
  return out;
}

/**
 * Caddy's whole config for Lyrica's site: HTTPS on the chosen addresses,
 * DNS-01, and a reverse proxy to lyricad. While the name changes, the old
 * site comes along (`also`), so the old name keeps working until the new one
 * has its certificate.
 */
export function caddyConfig(site: CaddySite, paths: CaddyPaths, also: CaddySite[] = []): Record<string, unknown> {
  const sites = [site, ...also];
  return {
    ...adminOnly(paths),
    logging: {
      logs: {
        // Never to stderr and the journal: a DNS plugin may put its token in an error.
        default: { exclude: ["tls"] },
        // TLS errors (a failed ACME order, a refused DNS token) go to a file only lyricad's group can read, for the status page.
        "lyrica-tls": {
          writer: { output: "file", filename: paths.tlsLog, mode: "0640", roll_size_mb: 1, roll_keep: 1 },
          encoder: { format: "json" },
          level: "ERROR",
          include: ["tls"],
        },
      },
    },
    apps: {
      http: {
        servers: {
          lyrica: {
            listen: [...new Set(sites.flatMap((s) => s.addresses.map((a) => `${a}:${s.port}`)))],
            routes: sites.map((s) => ({
              match: [{ host: [s.name] }],
              handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `127.0.0.1:${s.upstream}` }], flush_interval: -1 }],
              terminal: true,
            })),
            // HTTPS only: no listener on port 80 for redirects.
            automatic_https: { disable_redirects: true },
          },
        },
      },
      tls: { automation: { policies: sites.map((s) => ({ subjects: [s.name], issuers: [issuer(s)] })) } },
    },
  };
}

/** Caddy's admin API over its Unix socket. */
export class CaddyAdmin {
  constructor(readonly socket: string, private readonly timeoutMs = 15_000) {}

  /** The running config, or undefined if Caddy doesn't answer. */
  async config(): Promise<unknown> {
    try {
      const r = await this.call("GET", "/config/");
      return r.status === 200 ? JSON.parse(r.body || "null") : undefined;
    } catch {
      return undefined;
    }
  }

  /** Replaces the whole config. Caddy keeps the old one if the new one fails to start. */
  async load(config: unknown): Promise<void> {
    const r = await this.call("POST", "/load", JSON.stringify(config));
    if (r.status !== 200) throw new Error(`Caddy refused the config: ${caddyError(r.body)}`);
  }

  private call(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.socket, method, path, timeout: this.timeoutMs,
        headers: { host: "lyricad", ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) },
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on("timeout", () => req.destroy(new Error("Caddy didn't answer")));
      req.on("error", reject);
      req.end(body);
    });
  }
}

function caddyError(body: string): string {
  try {
    return (JSON.parse(body) as { error?: string }).error ?? body;
  } catch {
    return body.trim() || "no reason given";
  }
}
