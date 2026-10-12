import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Api from "./api.ts";
import { HttpError } from "./http.ts";

// Her own tailscaled (lyrica-tailscaled.service: userspace networking, the
// lyrica user, its own state and socket), driven with the `tailscale` CLI
// against that socket. Every command comes from COMMANDS and nothing else
// reaches the binary: never funnel, SSH, routes, exit nodes or --reset.

export const TAILSCALE_SOCKET = "/run/lyrica-tailscale/tailscaled.sock";

const COMMANDS = {
  status: () => ["status", "--json", "--peers=false"],
  login: (keyFile: string, controlServer?: string) => ["login", `--auth-key=file:${keyFile}`, ...(controlServer ? [`--login-server=${controlServer}`] : [])],
  up: () => ["up"],
  down: () => ["down"],
  logout: () => ["logout"],
  hostname: (hostname: string) => ["set", `--hostname=${hostname}`],
  serve: (port: number) => ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`],
  serveReset: () => ["serve", "reset"],
} satisfies Record<string, (...a: never[]) => string[]>;

type Name = keyof typeof COMMANDS;

export interface TailnetOptions {
  /** The `tailscale` binary: a name on PATH or a path. */
  binary?: string;
  /** Her tailscaled's socket. */
  socket?: string;
  /** Where the auth key's file is written for a moment (lyricad's state directory). */
  runtime: string;
  timeoutMs?: number;
}

/** What `tailscale status --json` says, as far as she needs it. */
interface Status {
  Version?: string;
  BackendState?: string;
  Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean };
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string; MagicDNSEnabled?: boolean } | null;
  CertDomains?: string[] | null;
}

class Missing extends Error {}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
/** An auth key, wherever the CLI might quote one. */
const KEY_PATTERN = /tskey-[A-Za-z0-9_-]+/g;

export class TailnetControl {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: TailnetOptions) {}

  get socket(): string { return this.o.socket ?? TAILSCALE_SOCKET; }

  /** One change at a time, as Web access does. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Runs one command from the table against her socket. Errors carry the CLI's own words, with any key hidden. */
  private run<N extends Name>(name: N, ...args: Parameters<(typeof COMMANDS)[N]>): Promise<string> {
    const argv = ["--socket", this.socket, ...(COMMANDS[name] as (...a: unknown[]) => string[])(...args)];
    return new Promise((resolve, reject) => {
      execFile(this.o.binary ?? "tailscale", argv, { timeout: this.o.timeoutMs ?? 60_000, maxBuffer: 1 << 20, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Missing("the tailscale command isn't installed"));
          const said = redact(`${stderr}`.trim() || err.message).split("\n").filter(Boolean).slice(-3).join(" ");
          if (/failed to connect to local tailscale|doesn't appear to be running|connect: no such file|connection refused/i.test(said)) {
            return reject(new Missing("her tailscaled isn't running (lyrica-tailscaled.service)"));
          }
          reject(new Error(`tailscale ${name === "hostname" ? "set" : name}: ${said}`));
        });
    });
  }

  private async rawStatus(): Promise<Status> {
    return JSON.parse(await this.run("status")) as Status;
  }

  /** Read from her tailscaled each time; nothing is kept. */
  async status(): Promise<Api.Tailnet> {
    let s: Status;
    try {
      s = await this.rawStatus();
    } catch (err) {
      if (err instanceof Missing) return { state: "notInstalled", reason: err.message };
      throw err;
    }
    return view(s);
  }

  /** Her DNS name, and whether the tailnet gives it HTTPS certificates. */
  async serveName(): Promise<{ dnsName: string; address?: string; certificates: boolean; magicDns: boolean }> {
    const s = await this.rawStatus();
    const v = view(s);
    if (v.state !== "connected" || !v.dnsName) throw new Error("she isn't connected to a tailnet");
    return { dnsName: v.dnsName, address: v.address, certificates: (s.CertDomains ?? []).includes(v.dnsName), magicDns: !!s.CurrentTailnet?.MagicDNSEnabled };
  }

  /**
   * Joins with an auth key, written to a 0600 file for `--auth-key file:` and
   * deleted when `login` returns, whatever the outcome. Then `set --hostname`
   * only when one was given and differs. Joined already: 409 unless `leave`.
   */
  join(j: Api.TailnetJoin): Promise<Api.Tailnet> {
    const authKey = String(j.authKey ?? "").trim();
    if (!authKey) return Promise.reject(new Error("an auth key is needed to join"));
    if (/\s/.test(authKey)) return Promise.reject(new Error("that doesn't look like an auth key"));
    const hostname = j.hostname === undefined || j.hostname === "" ? undefined : String(j.hostname).trim().toLowerCase();
    if (hostname !== undefined && !HOSTNAME.test(hostname)) return Promise.reject(new Error("the hostname uses letters, digits and '-', up to 63"));
    const controlServer = j.controlServer ? checkControlServer(String(j.controlServer)) : undefined;
    return this.serial(async () => {
      const before = await this.status();
      if (before.state === "notInstalled") throw new HttpError(409, `she can't join: ${before.reason}`);
      if (before.state === "connected" || before.state === "disconnected") {
        if (!j.leave) throw new HttpError(409, `she is on ${before.tailnet ?? "a tailnet"} already; leave it first`);
        await this.run("logout");
      }
      const file = join(this.o.runtime, `tailnet-key-${randomBytes(8).toString("hex")}`);
      try {
        writeFileSync(file, authKey, { mode: 0o600, flag: "wx" });
        await this.run("login", file, controlServer);
      } catch (err) {
        throw new Error(redact((err as Error).message, authKey));
      } finally {
        rmSync(file, { force: true });
      }
      const after = await this.status();
      if (hostname && after.hostname?.toLowerCase() !== hostname) await this.run("hostname", hostname);
      return this.status();
    });
  }

  connect(): Promise<Api.Tailnet> { return this.serial(async () => { await this.run("up"); return this.status(); }); }
  disconnect(): Promise<Api.Tailnet> { return this.serial(async () => { await this.run("down"); return this.status(); }); }
  leave(): Promise<Api.Tailnet> { return this.serial(async () => { await this.run("logout"); return this.status(); }); }

  /** `tailscale serve` on 443 to lyricad's serve port. */
  serve(port: number): Promise<void> { return this.serial(async () => { await this.run("serve", port); }); }
  serveReset(): Promise<void> { return this.serial(async () => { await this.run("serveReset"); }); }
}

function view(s: Status): Api.Tailnet {
  const self = s.Self ?? {};
  const dnsName = self.DNSName?.replace(/\.$/, "") || undefined;
  const base = {
    ...(s.Version ? { version: s.Version.split("-")[0] } : {}),
    ...(self.HostName ? { hostname: self.HostName } : {}),
  };
  const joined = {
    ...base,
    ...(s.CurrentTailnet?.Name ? { tailnet: s.CurrentTailnet.Name } : {}),
    ...(self.TailscaleIPs?.find((a) => a.includes(".")) ? { address: self.TailscaleIPs.find((a) => a.includes("."))! } : {}),
    ...(dnsName ? { dnsName } : {}),
  };
  switch (s.BackendState) {
    case "Running": return { state: "connected", ...joined };
    case "Stopped": return { state: "disconnected", ...joined };
    case "Starting": return { state: "disconnected", ...joined, reason: "connecting" };
    case "NeedsMachineAuth": return { state: "notJoined", ...base, reason: "waiting for this device to be approved in the tailnet's admin console" };
    default: return { state: "notJoined", ...base };
  }
}

function checkControlServer(url: string): string {
  let u: URL;
  try { u = new URL(url.trim()); } catch { throw new Error("the control server is an https:// address"); }
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("the control server is an https:// address");
  return u.origin + (u.pathname === "/" ? "" : u.pathname);
}

/** The CLI's messages could quote a key; never pass one on. */
function redact(text: string, key?: string): string {
  let out = text.replace(KEY_PATTERN, "[hidden]");
  if (key && key.length >= 4) out = out.split(key).join("[hidden]");
  return out;
}
