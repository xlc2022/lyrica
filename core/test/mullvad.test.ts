import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egress, MULLVAD_DNS, openRelay, parseWireGuard, socksConnect, wireproxyConfig, type Dialer } from "../src/index.ts";

// Her browsing through Mullvad (docs/workspace.md, "Mullvad"): a run with the switch on goes out only through the
// tunnel's dialer, and when the tunnel is down nothing goes direct.

const KEY_A = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const KEY_B = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";
const MULLVAD = `[Interface]
# Device: Quick Otter
PrivateKey = ${KEY_A}
Address = 10.66.12.34/32,fc00:bbbb:bbbb:bb01::3:c21/128
DNS = 10.64.0.1

[Peer]
PublicKey = ${KEY_B}
AllowedIPs = 0.0.0.0/0,::0/0
Endpoint = 185.213.154.68:51820
`;

describe("a Mullvad WireGuard configuration", () => {
  it("reads Mullvad's download, keeps its DNS inside the tunnel, and says what is wrong with anything else", () => {
    const c = parseWireGuard(MULLVAD);
    expect(c).toMatchObject({ privateKey: KEY_A, addresses: ["10.66.12.34/32", "fc00:bbbb:bbbb:bb01::3:c21/128"], dns: ["10.64.0.1"], peer: { publicKey: KEY_B, endpoint: "185.213.154.68:51820" } });
    // Without a DNS line wireproxy would look names up outside the tunnel: Mullvad's resolver is put in.
    expect(parseWireGuard(MULLVAD.replace("DNS = 10.64.0.1\n", "")).dns).toEqual([MULLVAD_DNS]);
    expect(() => parseWireGuard("hello")).toThrow(/isn't a WireGuard configuration/);
    expect(() => parseWireGuard(MULLVAD.replace(KEY_A, "nope"))).toThrow(/PrivateKey/);
    expect(() => parseWireGuard(MULLVAD.replace(/Endpoint.*\n/, ""))).toThrow(/Endpoint/);
    expect(() => parseWireGuard(`${MULLVAD}\n[Peer]\nPublicKey = ${KEY_B}\nEndpoint = 1.2.3.4:5\n`)).toThrow(/exactly one \[Peer\]/);
    const text = wireproxyConfig(c, { port: 41000, user: "lyrica", password: "pw" });
    expect(text).toMatch(/^DNS = 10\.64\.0\.1$/m);
    expect(text).toMatch(/^\[Socks5\]\nBindAddress = 127\.0\.0\.1:41000\nUsername = lyrica\nPassword = pw$/m);
  });
});

describe("a run's relay with Mullvad on", () => {
  let site: Server;
  let sitePort: number;
  const dialled: string[] = [];
  /** A tunnel that "exits" by connecting to the local site, whatever host it is asked for. */
  const tunnel: Dialer = (host, port) => new Promise((resolve, reject) => {
    dialled.push(`${host}:${port}`);
    const s = connect(sitePort, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  const down: Dialer = () => Promise.reject(new Error("Mullvad isn't connected yet"));

  beforeAll(async () => {
    site = createServer((req, res) => { req.resume(); res.end(`${req.method} ${req.headers.host}${req.url}`); });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    sitePort = (site.address() as AddressInfo).port;
  });
  afterAll(() => site.close());

  const plain = (port: number, url: string, method = "GET") => new Promise<{ status: number; body: string }>((resolve, reject) => {
    httpRequest({ host: "127.0.0.1", port, method, path: url }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d)).on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject).end(method === "POST" ? "form" : undefined);
  });
  const connectThrough = (port: number, to: string) => new Promise<{ status: number; socket?: Socket; body: string }>((resolve, reject) => {
    httpRequest({ host: "127.0.0.1", port, method: "CONNECT", path: to })
      .on("connect", (res, socket, head) => resolve({ status: res.statusCode ?? 0, socket, body: head.toString() }))
      .on("response", (res) => { let body = ""; res.on("data", (d) => (body += d)).on("end", () => resolve({ status: res.statusCode ?? 0, body })); })
      .on("error", reject).end();
  });

  it("sends every request through the tunnel, its TLS untouched, and refuses rather than going direct while it's down", async () => {
    const relay = await openRelay({ reaches: () => false, internet: true, mullvad: tunnel });
    try {
      dialled.length = 0;
      // Uploads on: a form still posts, through the tunnel.
      expect(await plain(relay.port, "http://example.org/a", "POST")).toEqual({ status: 200, body: "POST example.org/a" });
      // A CONNECT is a plain tunnel: the relay ends no TLS and issues no certificate.
      expect(relay.ca).toBeUndefined();
      const c = await connectThrough(relay.port, "example.com:443");
      expect(c.status).toBe(200);
      c.socket!.write("GET /raw HTTP/1.0\r\nHost: example.com\r\n\r\n");
      const raw = await new Promise<string>((r) => { let t = ""; c.socket!.on("data", (d) => (t += d)).on("end", () => r(t)); });
      expect(raw).toMatch(/GET example\.com\/raw$/);
      expect(dialled).toEqual(["example.org:80", "example.com:443"]);
    } finally {
      relay.close();
    }
    const off = await openRelay({ reaches: () => false, internet: true, mullvad: down });
    try {
      expect(await plain(off.port, "http://example.org/a")).toEqual({ status: 502, body: "Mullvad isn't connected yet.\n" });
      const c = await connectThrough(off.port, "example.com:443");
      expect(c.status).toBe(502);
      // Node hands a CONNECT's answer over as a socket whatever its status: the reason follows on it.
      const said = await new Promise<string>((r) => { let t = c.body; c.socket?.on("data", (d) => (t += d)).on("end", () => r(t)); if (!c.socket) r(t); });
      expect(said).toBe("Mullvad isn't connected yet.\n");
    } finally {
      off.close();
    }
  });

  it("with uploads off too, only reads, through the tunnel, with names looked up there", async () => {
    const relay = await openRelay({ reaches: () => false, internet: true, mullvad: tunnel, readOnlyInternet: { refused: () => true } });
    try {
      dialled.length = 0;
      // `refused` would refuse every address here: through Mullvad the name isn't looked up on this machine at all.
      expect(await plain(relay.port, "http://example.org/b")).toEqual({ status: 200, body: "GET example.org/b" });
      expect((await plain(relay.port, "http://example.org/b", "POST")).status).toBe(403);
      expect(dialled).toEqual(["example.org:80"]);
    } finally {
      relay.close();
    }
  });
});

describe("SearXNG's way out and the tunnel's login", () => {
  let site: TcpServer;
  let sitePort: number;
  let login: TcpServer;
  let loginPort: number;
  beforeAll(async () => {
    site = createTcpServer((s) => s.end("hello"));
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    sitePort = (site.address() as AddressInfo).port;
    // A SOCKS5 server with a login, as wireproxy's is: it answers only lyrica/pw, and connects to the site.
    login = createTcpServer((c) => {
      c.once("data", () => {
        c.write(Buffer.from([5, 2]));
        c.once("data", (auth) => {
          const ok = auth.subarray(2, 2 + auth[1]!).toString() === "lyrica" && auth.subarray(3 + auth[1]!).toString() === "pw";
          c.write(Buffer.from([1, ok ? 0 : 1]));
          if (!ok) return c.end();
          c.once("data", () => {
            const up = connect(sitePort, "127.0.0.1", () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); up.pipe(c); });
          });
        });
      });
    });
    await new Promise<void>((r) => login.listen(0, "127.0.0.1", r));
    loginPort = (login.address() as AddressInfo).port;
  });
  afterAll(() => { site.close(); login.close(); });

  const read = (s: Socket) => new Promise<string>((r) => { let t = ""; s.on("data", (d) => (t += d)).on("end", () => r(t)).on("close", () => r(t)); });

  it("connects through a login, and refuses a wrong one", async () => {
    expect(await read(await socksConnect({ port: loginPort, user: "lyrica", password: "pw" }, "example.org", 443))).toBe("hello");
    await expect(socksConnect({ port: loginPort, user: "lyrica", password: "no" }, "example.org", 443)).rejects.toThrow(/refused its login/);
  });

  it("goes direct while SearXNG's switch is off, and only through the tunnel while it's on", async () => {
    let route: Dialer | undefined;
    const dialled: string[] = [];
    const server = await egress(() => route, 0);
    const port = (server.address() as AddressInfo).port;
    // SearXNG's side: no login, a name to look up (socks5h).
    const ask = (host: string, to: number) => new Promise<{ reply: number; body: string }>((resolve) => {
      const s = connect(port, "127.0.0.1", () => s.write(Buffer.from([5, 1, 0])));
      let step = 0, body = "", reply = -1;
      s.on("data", (d: Buffer) => {
        if (step === 0) { step = 1; const name = Buffer.from(host); s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([to >> 8, to & 0xff])])); }
        else if (step === 1) { step = 2; reply = d[1]!; body = d.subarray(10).toString(); }
        else body += d;
      }).on("close", () => resolve({ reply, body }));
    });
    try {
      expect(await ask("127.0.0.1", sitePort)).toEqual({ reply: 0, body: "hello" });
      route = (host, p) => { dialled.push(`${host}:${p}`); return new Promise((resolve) => { const s = connect(sitePort, "127.0.0.1", () => resolve(s)); }); };
      expect(await ask("www.bing.com", 443)).toEqual({ reply: 0, body: "hello" });
      expect(dialled).toEqual(["www.bing.com:443"]);
      route = () => Promise.reject(new Error("down"));
      expect((await ask("www.bing.com", 443)).reply).toBe(4);
    } finally {
      server.close();
    }
  });
});
