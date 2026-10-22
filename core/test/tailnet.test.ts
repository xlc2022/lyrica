import { createServer as createHttp } from "node:http";
import { createServer as createTcp, connect, type AddressInfo, type Socket } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { addressesOutside, useTailnetProxy } from "../src/index.ts";
import { fakeHost } from "./fake-host.ts";
import { withModels } from "./helpers.ts";

// Her tailscaled's proxy, as a stand-in: every CONNECT goes to the same port on loopback, and the targets are kept.
const targets: string[] = [];
const proxy = createTcp((client: Socket) => {
  client.once("data", (head) => {
    const target = /^CONNECT (\S+) HTTP\/1\.1/.exec(head.toString("latin1"))?.[1] ?? "";
    targets.push(target);
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
useTailnetProxy(`127.0.0.1:${(proxy.address() as AddressInfo).port}`, () => "tail1234.ts.net");
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
  });
});
