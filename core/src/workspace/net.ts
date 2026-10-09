import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// How a sandbox with network access is wired. pasta gives it a network
// namespace of its own, with its own address, and nftables rules loaded into
// that namespace before the command starts default-deny everything the
// thread's switches and hosts don't allow. bwrap then drops every
// capability, so the command can't change the rules.

/** The sandbox's own address, so the host's LAN address stays a separate machine to it. */
export const SANDBOX_ADDRESS = "10.255.255.2";
/** pasta's side: the default route, and with internet on, the DNS forwarder. */
export const SANDBOX_GATEWAY = "10.255.255.1";

export interface HostEntry {
  /** The entry as stored: host, or host:port, with IPv6 in brackets. */
  entry: string;
  /** An IP, a CIDR range, or a hostname. */
  host: string;
  port?: number;
}

/** Parses an allowed-host entry: an IP, CIDR range, hostname or URL, each with an optional port. */
export function parseHost(raw: string): HostEntry {
  let s = raw.trim();
  let port: number | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const url = new URL(s);
    s = url.hostname;
    port = url.port ? Number(url.port) : ({ "http:": 80, "https:": 443 } as Record<string, number>)[url.protocol];
    if (s.startsWith("[")) s = s.slice(1, -1);
  } else if (s.startsWith("[")) {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
    if (!m) throw new Error(`can't read host ${raw}`);
    s = m[1]!;
    port = m[2] ? Number(m[2]) : undefined;
  } else if ((s.match(/:/g) ?? []).length === 1) {
    const [h, p] = s.split(":") as [string, string];
    s = h;
    port = Number(p);
  }
  const [addr, prefix, ...rest] = s.split("/");
  const family = isIP(addr ?? "");
  const name = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(s);
  if (rest.length || (prefix !== undefined && (!family || !/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) {
    throw new Error(`can't read host ${raw}`);
  }
  if (!family && !name) throw new Error(`can't read host ${raw}`);
  // Sandboxes are IPv4-only for now, and an IPv6 rule would do nothing until that changes.
  if (family === 6) throw new Error(`${raw}: IPv6 hosts aren't supported yet`);
  // An entry that matches everything would be internet access with the switch off.
  if (prefix !== undefined && Number(prefix) === 0) throw new Error(`${raw} would allow every address; use the internet switch instead`);
  if (family && ["0.0.0.0", "255.255.255.255"].includes(addr!)) throw new Error(`${raw} isn't a host`);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`bad port in ${raw}`);
  const host = family ? s : s.toLowerCase();
  const shown = host.includes(":") && !host.includes("/") && port !== undefined ? `[${host}]` : host;
  return { entry: port === undefined ? shown : `${shown}:${port}`, host, port };
}

export interface ResolvedHosts {
  /** Address or CIDR, family and optional port, for the firewall. */
  rules: { addr: string; port?: number }[];
  /** Lines for the sandbox's /etc/hosts, pinning each hostname to what it resolved to now. */
  pinned: string[];
}

/** Resolves hostnames once, when a sandbox starts. A name that doesn't resolve is left out. */
export async function resolveHosts(entries: string[]): Promise<ResolvedHosts> {
  const out: ResolvedHosts = { rules: [], pinned: [] };
  for (const e of entries.map(parseHost)) {
    if (isIP(e.host.split("/")[0]!)) {
      out.rules.push({ addr: e.host, port: e.port });
      continue;
    }
    const addrs = await lookup(e.host, { all: true, family: 4 }).catch(() => []);
    for (const a of addrs) {
      out.rules.push({ addr: a.address, port: e.port });
      out.pinned.push(`${a.address} ${e.host}`);
    }
  }
  return out;
}

/**
 * The ports something listens on at this machine's loopback (or on every
 * address), from /proc/net. pasta forwards exactly these, minus excluded
 * ones, when the machine's-services switch is on.
 */
export function loopbackPorts(proto: "tcp" | "udp"): number[] {
  const ports = new Set<number>();
  for (const file of [proto, `${proto}6`]) {
    let text = "";
    try { text = readFileSync(`/proc/net/${file}`, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const [, local, , state] = line.trim().split(/\s+/);
      if (!local || state !== (proto === "tcp" ? "0A" : "07")) continue;
      const [addr, port] = local.split(":") as [string, string];
      const loopbackOrAny = /^0+$/.test(addr) || (addr.length === 8 && addr.endsWith("7F")) || addr === "00000000000000000000000001000000";
      if (loopbackOrAny) ports.add(parseInt(port, 16));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** pasta's options for a thread's network. */
export function pastaArgs(net: { internet: boolean; services: boolean; hosts: boolean }, exclude: number[]): string[] {
  const args = ["--quiet", "--ipv4-only", "-t", "none", "-u", "none"];
  if (net.internet || net.hosts) {
    args.push("--config-net", "--no-map-gw", "-a", SANDBOX_ADDRESS, "-n", "30", "-g", SANDBOX_GATEWAY);
    if (net.internet) args.push("--dns-forward", SANDBOX_GATEWAY);
  }
  const forward = (proto: "tcp" | "udp") => {
    const ports = net.services ? loopbackPorts(proto).filter((p) => !exclude.includes(p)) : [];
    return ports.length ? ports.join(",") : "none";
  };
  args.push("-T", forward("tcp"), "-U", forward("udp"));
  return args;
}

/** The nftables ruleset loaded into the sandbox's namespace: default deny, then what the thread allows. */
export function nftRules(internet: boolean, hosts: ResolvedHosts["rules"], exclude: number[]): string {
  const rules = ["ct state established,related accept"];
  if (exclude.length) rules.push(`meta l4proto { tcp, udp } th dport { ${exclude.join(", ")} } reject`);
  // pasta forwards only the allowed loopback ports, so loopback itself can stay open.
  rules.push('oif "lo" accept');
  if (internet) rules.push("accept");
  for (const h of hosts) {
    const match = `ip daddr ${h.addr}`;
    rules.push(h.port ? `${match} meta l4proto { tcp, udp } th dport ${h.port} accept` : `${match} accept`);
  }
  rules.push("meta l4proto tcp reject with tcp reset", "reject");
  return `table inet lyrica {\n  chain out {\n    type filter hook output priority 0; policy drop;\n${rules.map((r) => `    ${r}\n`).join("")}  }\n}\n`;
}
