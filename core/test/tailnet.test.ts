import { createServer as createHttp } from "node:http";
import { createSecureServer } from "node:http2";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { createServer as createTcp, connect, type AddressInfo, type Socket } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { createServer as createHttps } from "node:https";
import { lookup } from "node:dns/promises";
import { addressesOutside, HostRefused, resolveHost, useTailnetProxy, whyUnreachable } from "../src/index.ts";
import { proxmoxHttps } from "../src/workspace/proxmox.ts";
import { tailnetRelay } from "../src/workspace/transport.ts";
import { fakeHost } from "./fake-host.ts";
import { fakeProxmox, selfSigned } from "./fake-proxmox.ts";
import { withModels } from "./helpers.ts";

// Her tailscaled's proxy, as a stand-in: every CONNECT goes to the same port on loopback, and the targets are kept.
const targets: string[] = [];
const proxy = createTcp((client: Socket) => {
  client.once("data", (head) => {
    const target = /^CONNECT (\S+) HTTP\/1\.1/.exec(head.toString("latin1"))?.[1] ?? "";
    targets.push(target);
    // Like tailscaled when its dial fails: 500, with the dial error as the body.
    if (target.startsWith("100.99.")) {
      const why = `dial tcp ${target}: connect: connection refused\n`;
      client.end(`HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${why.length}\r\n\r\n${why}`);
      return;
    }
    const port = Number(target.slice(target.lastIndexOf(":") + 1));
    const upstream = connect({ host: "127.0.0.1", port }, () => {
      client.write("HTTP/1.1 200 OK\r\n\r\n");
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
// Public names with tailnet records, as a forge's can have (git.example.net → 100.x); every other name resolves as usual.
const RECORDS: Record<string, string[]> = { "forge.example.net": ["100.70.1.2"], "dark.example.net": ["100.99.3.4"] };
useTailnetProxy(`127.0.0.1:${(proxy.address() as AddressInfo).port}`, () => "tail1234.ts.net",
  async (host) => RECORDS[host] ?? (await lookup(host, { all: true })).map((a) => a.address));
afterAll(() => proxy.close());

describe("the tailnet, through her tailscaled's proxy", () => {
  it("pairs with and calls a model host at a tailnet address, checking its key inside the tunnel", async () => {
    const m = await withModels();
    const host = await fakeHost({ name: "lyrica-danube" });
    const port = host.address.split(":")[1];
    targets.length = 0;
    const ep = await m.models.pairHost(m.ada, { name: "danube", addresses: [`100.101.124.57:${port}`], code: host.newCode() });
    expect(ep.fingerprint).toBe(host.fingerprint);
    expect(await m.models.probe(m.ada.id, ep.id)).toEqual({ state: "up" });
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(new Set(targets)).toEqual(new Set([`100.101.124.57:${port}`]));
    // Another machine at that address is refused, as it would be directly.
    await host.replaceKey();
    expect(await m.models.probe(m.ada.id, ep.id)).toMatchObject({ state: "down" });
  });

  it("says why her tailscaled couldn't reach a host, rather than its status code", async () => {
    const m = await withModels();
    const err = await m.models.pairHost(m.ada, { name: "nautica", addresses: ["100.99.1.2"], code: "7kq2-m9xd-4rtb-w1hz" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(HostRefused);
    expect((err as Error).message).toBe("Couldn't reach the host at 100.99.1.2 (connect 100.99.1.2:7236: her tailscaled couldn't reach it (nothing there takes connections on port 7236)).");
  });

  it("sends names in her tailnet and tailnet addresses through it, and nothing else", async () => {
    const server = createHttp((_, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}'));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      targets.length = 0;
      expect((await fetch(`http://lm.tail1234.ts.net:${port}/v1/models`)).status).toBe(200);
      expect((await fetch(`http://[fd7a:115c:a1e0::5]:${port}/v1/models`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/v1/models`)).status).toBe(200);
      expect(targets).toEqual([`lm.tail1234.ts.net:${port}`, `[fd7a:115c:a1e0::5]:${port}`]);
    } finally {
      server.close();
    }
    // A name in her tailnet counts as her own network: tailscaled resolves it to a peer.
    expect(await addressesOutside("http://lm.tail1234.ts.net:1234/v1")).toEqual([]);
    // So does a Git account's or a machine's host there, which this machine's resolver can't look up.
    // The name stands for its address, for the connection to take through the proxy.
    expect(await resolveHost("forge.tail1234.ts.net")).toEqual({ addresses: ["forge.tail1234.ts.net"], outside: false });
  });

  it("reaches an SSH machine in her tailnet through a loopback relay, for the helper's one connection", async () => {
    // An SSH server's stand-in: it says its banner and echoes.
    const sshd = createTcp((c) => { c.write("SSH-2.0-stand-in\r\n"); c.pipe(c); });
    await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", r));
    const port = (sshd.address() as AddressInfo).port;
    try {
      targets.length = 0;
      const relay = (await tailnetRelay("box.tail1234.ts.net", port))!;
      expect(targets).toEqual([`box.tail1234.ts.net:${port}`]);
      const said = await new Promise<string>((resolve) => {
        const c = connect({ host: "127.0.0.1", port: relay.port }, () => c.write("hello"));
        let got = "";
        c.on("data", (d) => { got += d.toString(); if (got.includes("hello")) { c.destroy(); resolve(got); } });
      });
      expect(said).toBe("SSH-2.0-stand-in\r\nhello");
      // One connection only: the port is closed after it.
      await expect(new Promise<void>((resolve, reject) => connect({ host: "127.0.0.1", port: relay.port }, () => resolve()).on("error", reject))).rejects.toThrow(/ECONNREFUSED/);
      relay.close();
      // Anything else is dialled directly.
      expect(await tailnetRelay("127.0.0.1", port)).toBeUndefined();
    } finally {
      sshd.close();
    }
  });

  it("reads a Proxmox certificate at a name in her tailnet through the proxy", async () => {
    const pve = await fakeProxmox();
    try {
      targets.length = 0;
      expect(await proxmoxHttps.fingerprint("pve.tail1234.ts.net", pve.port)).toBe(pve.fingerprint);
      expect(targets).toEqual([`pve.tail1234.ts.net:${pve.port}`]);
    } finally {
      await pve.close();
    }
  });

  it("leaves every other fetch as it was: compressed HTTP/2 answers still decode, through the tunnel too", async () => {
    // Node's fetch under a newer undici's dispatcher lost an HTTP/2 answer's headers, so br and gzip bodies came back raw.
    const body = '{"ok":true}';
    const server = createSecureServer({ ...selfSigned(), allowHTTP1: true }, (req, res) => {
      const br = req.url === "/br";
      res.writeHead(200, { "content-type": "application/json", "content-encoding": br ? "br" : "gzip" }).end(br ? brotliCompressSync(body) : gzipSync(body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const reject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      for (const host of ["127.0.0.1", "lm.tail1234.ts.net"]) {
        for (const path of ["/br", "/gzip"]) {
          const res = await fetch(`https://${host}:${port}${path}`);
          expect(res.headers.get("content-encoding")).toBe(path.slice(1));
          expect(await res.json()).toEqual({ ok: true });
        }
      }
    } finally {
      if (reject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = reject;
      server.close();
    }
  });

  it("sends a public name whose records point into the tailnet through it, to the address", async () => {
    const server = createHttp((_, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"login":"ada"}'));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      targets.length = 0;
      expect(await (await fetch(`http://forge.example.net:${port}/api/v1/user`)).json()).toEqual({ login: "ada" });
      expect((await fetch(`http://localhost:${port}/api/v1/user`)).status).toBe(200);
      expect(targets).toEqual([`100.70.1.2:${port}`]);
    } finally {
      server.close();
    }
  });
});

describe("why a Git host gave no answer", () => {
  const why = (url: string, host: string, init: RequestInit = {}) => fetch(url, init).then(() => "answered", (err) => whyUnreachable(host, err));

  it("names the cause in plain words, and keeps the host as typed", async () => {
    // Her tailscaled's own reason, for a name whose record points into the tailnet.
    expect(await why("https://dark.example.net/api/v1/user", "dark.example.net"))
      .toBe("dark.example.net is on your tailnet, and Lyrica's Tailscale couldn't reach it: nothing there takes connections on port 443");
    expect(await why("https://nothing.invalid/", "nothing.invalid")).toBe("nothing.invalid doesn't resolve from this server");
    const closed = createTcp();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await why(`https://127.0.0.1:${port}/`, `127.0.0.1:${port}`)).toBe(`127.0.0.1:${port} refused the connection on port ${port}`);
    const tls = createHttps(selfSigned(), (_, res) => res.end("{}"));
    await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
    const tlsPort = (tls.address() as AddressInfo).port;
    try {
      expect(await why(`https://127.0.0.1:${tlsPort}/`, "Git.Example.net")).toBe("Git.Example.net's certificate isn't valid: no trusted authority signed it");
      expect(await why(`https://127.0.0.1:${tlsPort}/`, "git.example.net", { signal: AbortSignal.timeout(0) })).toBe("git.example.net didn't answer in time");
    } finally {
      tls.close();
    }
  });
});
