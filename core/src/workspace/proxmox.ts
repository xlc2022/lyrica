// A Proxmox machine: reached over its API with a narrow token, never a shell
// on the hypervisor. One call per action; the token is sent only to the
// certificate Li confirmed.

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { ownAddresses } from "./machines.ts";

export const PROXMOX_ACTIONS = ["status", "list", "start", "stop", "shutdown", "reboot", "snapshots"] as const;
export type ProxmoxAction = (typeof PROXMOX_ACTIONS)[number];
/** The actions that only read: Plan mode may use them, and they never ask on their own. */
export const PROXMOX_READS: ReadonlySet<ProxmoxAction> = new Set(["status", "list", "snapshots"]);
/** Actions that always ask, in every mode, with this warning, until allowed in the thread. */
export const PROXMOX_SUSPECT: Partial<Record<ProxmoxAction, string>> = {
  stop: "This cuts the power to the VM at once, like pulling the plug: anything unsaved in it is lost.",
  reboot: "This restarts the VM: everything running in it stops.",
};

/** What Allow in this thread covers: a command exactly, or a Proxmox action on one VM. */
export function suspectKey(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  return tool === "proxmox" ? `${String(i.action)} ${String(i.vm ?? "")}`.trim() : String(i.command);
}

/** The token as Proxmox prints it: `user@realm!tokenid=secret`. */
const TOKEN = /^([^\s@!=]+@[^\s@!=]+![A-Za-z][A-Za-z0-9._-]*)=([A-Za-z0-9-]{8,})$/;
/** The certificate's SHA-256 fingerprint, as `openssl x509 -fingerprint -sha256` and Node print it. */
const CERT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** The token's id (`user@realm!tokenid`), without the secret. Throws for anything else. */
export function tokenId(token: string): string {
  const m = TOKEN.exec(token.trim());
  if (!m) throw new Error("the token looks like lyrica@pve!agent=<secret>, as pveum printed it");
  return m[1]!;
}

/** A confirmed certificate fingerprint in the one form kept, or a thrown error. */
export function certFingerprint(fp: string): string {
  const clean = fp.trim().replace(/^sha256 fingerprint=/i, "").toUpperCase();
  if (!CERT.test(clean)) throw new Error("a certificate fingerprint looks like AB:CD:… (32 pairs)");
  return clean;
}

/** https://host:8006, host:port or host; the port defaults to 8006. */
export function parseProxmoxAddress(address: string): { host: string; port: number } {
  const m = /^(?:https:\/\/)?(\[[0-9a-fA-F:.]+\]|[^:/\s@[\]]+)(?::(\d+))?\/?$/.exec(address.trim());
  const port = Number(m?.[2] ?? 8006);
  if (!m || port < 1 || port > 65535) throw new Error("the address looks like https://host:8006");
  return { host: m[1]!.replace(/^\[|\]$/g, ""), port };
}

/** The address as shown: https://host:port. */
export const proxmoxAddress = (host: string, port: number): string => `https://${host.includes(":") ? `[${host}]` : host}:${port}`;

/** What Li runs as root on the Proxmox node, for a token that can see everything and power only the chosen VMs. */
export function proxmoxSetup(): string {
  return [
    "# 1. A user and a role that can see VMs and power them, nothing more",
    "pveum user add lyrica@pve --comment Lyrica",
    'pveum role add LyricaPower --privs "VM.Audit VM.PowerMgmt"',
    "pveum user token add lyrica@pve agent --privsep 1",
    "",
    "# 2. Reads everywhere; power only on the VMs she may manage (repeat per VM, or use /pool/<name>).",
    "#    A separated token has only what both it and its user have, so both get each role.",
    "pveum acl modify / --roles PVEAuditor --users lyrica@pve --tokens 'lyrica@pve!agent'",
    "pveum acl modify /vms/101 --roles LyricaPower --users lyrica@pve --tokens 'lyrica@pve!agent'",
    "",
    "# Never PVEVMUser: its console and guest-agent rights run code in the guest. Never Sys.PowerMgmt.",
    "",
    "# The certificate's fingerprint, to compare with the one Lyrica shows",
    "openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pveproxy-ssl.pem 2>/dev/null || openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pve-ssl.pem",
  ].join("\n");
}

export interface ProxmoxEndpoint { host: string; port: number; token: string }

export interface ProxmoxTransport {
  /** The certificate's SHA-256 fingerprint. Nothing is sent. */
  fingerprint(host: string, port: number): Promise<string>;
  /**
   * One API call; resolves to the answer's `data`. `verify` gets the
   * certificate's fingerprint before anything is sent, and the token goes
   * out only if it says yes. Errors carry the status, never the request.
   */
  call(to: ProxmoxEndpoint, method: "GET" | "POST", path: string, verify: (fingerprint: string) => boolean): Promise<unknown>;
}

/** A TLS connection whose certificate is read by fingerprint, not by a CA: Proxmox's own certificate is self-signed. */
function open(host: string, port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${host}:${port} didn't answer`)); }, 10_000);
    socket.once("secureConnect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Node's TLS and HTTP in this process. */
export const proxmoxHttps: ProxmoxTransport = {
  async fingerprint(host, port) {
    const socket = await open(host, port);
    const fp = socket.getPeerCertificate().fingerprint256;
    socket.destroy();
    return fp;
  },
  async call(to, method, path, verify) {
    const socket = await open(to.host, to.port);
    if (!verify(socket.getPeerCertificate().fingerprint256)) {
      socket.destroy();
      throw new Error("its certificate isn't the one you confirmed; confirm the new fingerprint in Settings if it changed on purpose");
    }
    return new Promise((resolve, reject) => {
      // The request goes over the connection already checked, never a new one.
      const req = httpRequest({
        host: to.host, port: to.port, method, path: `/api2/json${path}`, createConnection: () => socket, timeout: 30_000,
        headers: { Authorization: `PVEAPIToken=${to.token}`, Accept: "application/json" },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          socket.destroy();
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) return reject(new Error(`Proxmox answered ${status}${res.statusMessage ? ` ${res.statusMessage}` : ""}`));
          try { resolve((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: unknown }).data); } catch { reject(new Error("Proxmox's answer wasn't JSON")); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("Proxmox didn't answer in 30 s")));
      req.on("error", (err) => { socket.destroy(); reject(err); });
      req.end();
    });
  },
};

/** One machine's API: a call bound to its address, token and confirmed certificate. */
export type ProxmoxCall = (method: "GET" | "POST", path: string) => Promise<unknown>;

interface Resource { vmid: number; name?: string; node: string; type: "qemu" | "lxc"; status?: string; template?: number }

const resources = async (api: ProxmoxCall): Promise<Resource[]> =>
  ((await api("GET", "/cluster/resources?type=vm")) as Resource[] ?? []).filter((r) => r.type === "qemu" || r.type === "lxc");

const label = (r: Resource) => `${r.vmid}${r.name ? ` ${r.name}` : ""}`;
const base = (r: Resource) => `/nodes/${encodeURIComponent(r.node)}/${r.type}/${r.vmid}`;

/** A VM or container by number or name, among those the token can see. */
async function find(api: ProxmoxCall, vm: string | undefined): Promise<Resource> {
  if (!vm?.trim()) throw new Error("say which VM or container, by number or name");
  const all = await resources(api);
  const key = vm.trim();
  const hits = /^\d+$/.test(key) ? all.filter((r) => String(r.vmid) === key) : all.filter((r) => r.name === key);
  if (hits.length > 1) throw new Error(`several are named ${key}: ${hits.map((r) => r.vmid).join(", ")}; use the number`);
  if (!hits[0]) throw new Error(`there's no VM or container ${key} that this token can see`);
  return hits[0];
}

const VERBS: Record<"start" | "stop" | "shutdown" | "reboot", string> = { start: "start", stop: "stop (power off)", shutdown: "shut down", reboot: "reboot" };
const gib = (n?: number) => `${((n ?? 0) / 2 ** 30).toFixed(1)}`;
function uptime(s?: number): string {
  if (!s) return "";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `, up ${d ? `${d} d ` : ""}${d || h ? `${h} h` : `${m} min`}`;
}

/** Runs one action and says what happened, in a line or a short list. */
export async function proxmoxAction(api: ProxmoxCall, action: ProxmoxAction, vm?: string): Promise<string> {
  if (!PROXMOX_ACTIONS.includes(action)) throw new Error(`the proxmox tool can't ${String(action)}`);
  if (action === "list") {
    const all = (await resources(api)).filter((r) => !r.template).sort((a, b) => a.vmid - b.vmid);
    return all.length ? all.map((r) => `${label(r)} (${r.type === "lxc" ? "container" : "VM"} on ${r.node}): ${r.status ?? "unknown"}`).join("\n")
      : "This token can see no VMs or containers.";
  }
  const r = await find(api, vm);
  if (action === "status") {
    const s = (await api("GET", `${base(r)}/status/current`)) as { status?: string; qmpstatus?: string; uptime?: number; cpu?: number; cpus?: number; mem?: number; maxmem?: number };
    const running = s.status === "running";
    const state = s.qmpstatus && s.qmpstatus !== s.status ? `${s.status} (${s.qmpstatus})` : s.status ?? "unknown";
    return `${label(r)} on ${r.node}: ${state}${running ? `${uptime(s.uptime)}, CPU ${Math.round((s.cpu ?? 0) * 100)}% of ${s.cpus ?? "?"}, memory ${gib(s.mem)} of ${gib(s.maxmem)} GiB` : ""}`;
  }
  if (action === "snapshots") {
    const snaps = ((await api("GET", `${base(r)}/snapshot`)) as { name: string; description?: string; snaptime?: number }[] ?? []).filter((s) => s.name !== "current");
    return snaps.length ? snaps.map((s) => `${s.name}${s.snaptime ? ` (${new Date(s.snaptime * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}${s.description?.trim() ? `: ${s.description.trim()}` : ""}`).join("\n")
      : `${label(r)} has no snapshots.`;
  }
  await api("POST", `${base(r)}/status/${action}`);
  return `Asked ${r.node} to ${VERBS[action]} ${label(r)}. It runs as a task there; check with status.`;
}

/** What tells this computer apart: its name, network cards and addresses, and its default gateways. */
export interface Self { hostname: string; macs: string[]; addresses: string[]; gateways: string[] }

/** This computer, read now. */
export function thisComputer(): Self {
  const macs = Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal && a.mac !== "00:00:00:00:00:00").map((a) => a!.mac.toLowerCase());
  return { hostname: hostname(), macs: [...new Set(macs)], addresses: ownAddresses(), gateways: defaultGateways() };
}

/** IPv4 default gateways from /proc/net/route (little-endian hex). */
function defaultGateways(): string[] {
  try {
    return readFileSync("/proc/net/route", "utf8").split("\n").slice(1).map((l) => l.trim().split(/\s+/))
      .filter((f) => f[1] === "00000000" && f[2] && f[2] !== "00000000")
      .map((f) => Buffer.from(f[2]!, "hex").reverse().join("."));
  } catch {
    return [];
  }
}

const MAC = /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/gi;
/** Looking further than this many guests for her own VM isn't worth the wait; the name check still covers them. */
const MAX_CONFIGS = 300;

/**
 * Why this Proxmox can't be added, when it runs Lyrica's own VM as far as can
 * be told: its address is this computer or its default gateway, or a guest it
 * runs has this computer's name or one of its network cards. Undefined when
 * nothing points that way.
 */
export async function ownNode(api: ProxmoxCall, addresses: string[], self: Self): Promise<string | undefined> {
  const at = ownAddress(addresses, self);
  if (at) return at;
  const all = await resources(api);
  const name = self.hostname.split(".")[0]!.toLowerCase();
  const named = all.find((r) => r.name?.toLowerCase() === name);
  const mine = (r: Resource) => `${r.name ?? r.type} (${r.vmid} on ${r.node})`;
  if (named) return `it runs ${mine(named)}, which has this computer's name`;
  // A few at a time, so a big cluster doesn't make Confirm wait on one handshake after another.
  const guests = all.slice(0, MAX_CONFIGS);
  for (let i = 0; i < guests.length; i += 8) {
    const configs = await Promise.all(guests.slice(i, i + 8).map((r) => api("GET", `${base(r)}/config`).catch(() => ({})) as Promise<Record<string, unknown>>));
    const hit = configs.findIndex((config) => Object.entries(config).filter(([k]) => /^net\d+$/.test(k))
      .flatMap(([, v]) => String(v).match(MAC) ?? []).some((m) => self.macs.includes(m.toLowerCase())));
    if (hit >= 0) return `it runs ${mine(guests[i + hit]!)}, which has this computer's network card`;
  }
  return undefined;
}

/** Why an address is likely the Proxmox that runs Lyrica: it is this computer or its default gateway. */
export function ownAddress(addresses: string[], self: Self): string | undefined {
  const at = addresses.find((a) => self.addresses.includes(a) || self.gateways.includes(a));
  return at && `${at} is ${self.addresses.includes(at) ? "this computer" : "this computer's default gateway"}, so it's likely the Proxmox that runs Lyrica`;
}
