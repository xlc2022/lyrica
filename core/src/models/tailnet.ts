// Calls to the tailnet. Her tailscaled runs with userspace networking, so this
// machine has no route to tailnet addresses; it opens a proxy on loopback
// (`--outbound-http-proxy-listen`) instead. Tailnet destinations go through it
// by HTTP CONNECT, and TLS runs inside the tunnel end to end, so a model
// host's pinned key is checked exactly as on a direct connection. Everything
// else is dialled directly, and so is a tailnet destination when nothing
// listens on the proxy's port (no tailscaled of hers, or one started before
// it had the proxy): a machine with its own Tailscale reaches it that way.
import { BlockList, connect as tcp, isIP, type Socket } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

const TAILNET = new BlockList();
TAILNET.addSubnet("100.64.0.0", 10, "ipv4");
TAILNET.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

let proxy: { host: string; port: number } | undefined;
let suffix: () => string | undefined = () => undefined;
let builtinFetch: typeof fetch | undefined;

/**
 * Sends tailnet destinations through her tailscaled's proxy (`host:port` on
 * loopback), from every fetch and every model host connection. `magicDns`
 * gives her tailnet's MagicDNS suffix, when she is on one: names under it go
 * through the proxy too, where tailscaled resolves them to its peers.
 *
 * Only those calls change: they go through undici's own fetch with its own
 * dispatcher, as one version. Node's fetch keeps its own dispatcher for
 * everything else, since a newer undici's dispatcher under Node's fetch
 * loses an HTTP/2 answer's headers and so its content encoding.
 */
export function useTailnetProxy(address: string, magicDns: () => string | undefined = () => undefined): void {
  const u = new URL(`http://${address}`);
  if (!["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)) throw new Error("the tailnet proxy listens on loopback");
  proxy = { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || 80 };
  suffix = magicDns;
  const direct = buildConnector({});
  const dispatcher = new Agent({
    connect: (opts, callback) => {
      const host = String(opts.hostname).replace(/^\[|\]$/g, "");
      const port = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
      tailnetSocket(host, port).then(
        (socket) => (!socket ? direct(opts, callback) : opts.protocol === "https:" ? direct({ ...opts, httpSocket: socket } as never, callback) : callback(null, socket)),
        (err: Error) => callback(err, null),
      );
    },
  });
  const builtin = (builtinFetch ??= globalThis.fetch);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!viaTailnet(url.hostname)) return builtin(input, init);
    const from = input instanceof Request
      ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, duplex: "half", redirect: input.redirect }
      : {};
    return undiciFetch(url, { ...from, ...(init as object), dispatcher } as never) as unknown as Promise<Response>;
  }) as typeof fetch;
}

/** A name under her tailnet's MagicDNS suffix (tailscaled resolves those to its peers). */
export function tailnetName(host: string): boolean {
  const s = suffix()?.replace(/^\.|\.$/g, "").toLowerCase();
  return !!s && host.replace(/\.$/, "").toLowerCase().endsWith(`.${s}`);
}

/** Whether a host is reached through the proxy: a tailnet address, or a name in her tailnet. */
export function viaTailnet(host: string): boolean {
  if (!proxy) return false;
  const h = host.replace(/^\[|\]$/g, "");
  const v = isIP(h);
  return v ? TAILNET.check(h, v === 6 ? "ipv6" : "ipv4") : tailnetName(h);
}

/** At most this much of a refused CONNECT's body is read for its reason. */
const REASON_BYTES = 1024;

/**
 * Why tailscaled couldn't dial, from the error it wrote back ("dial tcp
 * 100.64.0.7:7236: connect: connection refused"), in plain words; the
 * error itself, cleaned and cut short, when it isn't a common one.
 */
function dialReason(body: Buffer, port: number): string {
  const text = body.toString("utf8").replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 200);
  const lower = text.toLowerCase();
  if (lower.includes("refused")) return `nothing there takes connections on port ${port}`;
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) return "no answer: the machine may be off, or the tailnet's access rules may not let this server reach it";
  if (lower.includes("no route") || lower.includes("unreachable")) return "no route to it in the tailnet";
  if (lower.includes("no such host") || lower.includes("unknown") || lower.includes("not found")) return "no machine of that name in the tailnet";
  return text;
}

/** Not listening: no proxy to go through. */
class NoProxy extends Error {}

/** A connection to `host:port` through the proxy for a tailnet destination; undefined to dial it directly. */
export function tailnetSocket(host: string, port: number, o: { paused?: boolean } = {}): Promise<Socket | undefined> {
  if (!viaTailnet(host)) return Promise.resolve(undefined);
  return tunnel(host, port, 10_000, o).catch((e) => {
    if (e instanceof NoProxy) return undefined;
    throw e;
  });
}

/**
 * A TCP connection to `host:port` through the proxy, once it has said yes.
 * `paused` holds what arrives until its taker reads it, for a server that
 * speaks first (SSH's banner) to a taker that comes later.
 */
export function tunnel(host: string, port: number, timeoutMs = 10_000, o: { paused?: boolean } = {}): Promise<Socket> {
  const p = proxy;
  if (!p) return Promise.reject(new Error("no tailnet proxy"));
  const target = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  return new Promise((resolve, reject) => {
    const socket = tcp({ host: p.host, port: p.port });
    let said = Buffer.alloc(0);
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`connect ETIMEDOUT ${host} (through her tailscaled)`)));
    const onError = (e: NodeJS.ErrnoException) => fail(e.code === "ECONNREFUSED" ? new NoProxy("her tailscaled's proxy isn't listening") : e);
    socket.once("error", onError);
    socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    const onData = (chunk: Buffer) => {
      said = Buffer.concat([said, chunk]);
      const end = said.indexOf("\r\n\r\n");
      if (end < 0) {
        if (said.length > 8192) fail(new Error("her tailscaled's proxy gave no answer"));
        return;
      }
      socket.off("data", onData);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(said.subarray(0, end).toString("latin1"))?.[1]);
      if (status !== 200) {
        // tailscaled answers a CONNECT it couldn't dial with 500 and the dial error as its body: read it for the reason.
        const length = Number(/\r\ncontent-length: *(\d{1,5})\r\n/i.exec(`${said.subarray(0, end).toString("latin1")}\r\n`)?.[1] ?? REASON_BYTES);
        const want = end + 4 + Math.min(length, REASON_BYTES);
        let body = said;
        const done = () => fail(new Error(`connect ${host}:${port}: her tailscaled couldn't reach it (${dialReason(body.subarray(end + 4, want), port) || (status ? `it answered ${status}` : "no answer")})`));
        if (body.length >= want) return done();
        const wait = setTimeout(done, 1000);
        const more = (chunk: Buffer) => {
          body = Buffer.concat([body, chunk]);
          if (body.length >= want) { clearTimeout(wait); done(); }
        };
        socket.on("data", more);
        socket.once("end", () => { clearTimeout(wait); done(); });
        return;
      }
      if (o.paused) socket.pause();
      socket.setTimeout(0);
      // Whoever takes the socket listens for its errors from here.
      socket.off("error", onError);
      socket.on("error", () => {});
      // Anything after the answer already belongs to the tunnel.
      if (said.length > end + 4) socket.unshift(said.subarray(end + 4));
      resolve(socket);
    };
    socket.on("data", onData);
  });
}
