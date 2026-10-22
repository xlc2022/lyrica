import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type IncomingHttpHeaders } from "node:http2";
import { createServer as createTcp, type AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
// Like the proxy, which dials the address: the certificate is checked against it, whatever the Host header says.
import { checkServerIdentity, createSecureContext, createServer as createTlsServer, type PeerCertificate, type SecureContext } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import type { HostAddress, WebAccess, WebAccessStatus } from "../src/api.ts";
import { browser, daemon, login, runtime } from "./helpers.ts";

const TOKEN = "cf-token-7d1e5b0a9c2f4e6b8a1d3c5e7f9b0a2c";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });
const track = (s: Server | ReturnType<typeof createTcp>) => cleanup.push(() => new Promise((r) => { s.close(r); (s as Server).closeAllConnections?.(); }));

/** A fake Caddy admin API on a Unix socket: GET /config/ and POST /load, which can be told to refuse. */
async function fakeCaddy(dir: string) {
  const socket = join(dir, "caddy-admin.sock");
  const state = { config: { admin: { listen: `unix/${socket}|0660` } } as unknown, loads: [] as any[], refuse: false };
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/config/") { res.writeHead(200); return res.end(JSON.stringify(state.config)); }
      if (req.method === "POST" && req.url === "/load") {
        if (state.refuse) { res.writeHead(400); return res.end(JSON.stringify({ error: `loading config: API token '${TOKEN}' appears invalid` })); }
        state.config = JSON.parse(body);
        state.loads.push(state.config);
        res.writeHead(200);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  track(srv);
  await new Promise<void>((r) => srv.listen(socket, r));
  return { socket, state };
}

/** A test CA that issues certificates for names, like Let's Encrypt would. */
function testCa() {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-ca-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  ssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=Test CA", "-days", "2");
  const issue = (name: string) => {
    writeFileSync(join(dir, "ext"), `subjectAltName=DNS:${name}\n`);
    ssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
    ssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "1", "-extfile", "ext");
    return createSecureContext({ key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) });
  };
  return { ca: readFileSync(join(dir, "ca.pem"), "utf8"), issue };
}

/** "Caddy" serving HTTPS for the names it has certificates for, on 127.0.0.1:port. */
async function caddyServing(port: number, ca: ReturnType<typeof testCa>, names: string[]) {
  const contexts = new Map<string, SecureContext>(names.map((n) => [n, ca.issue(n)]));
  const srv = createTlsServer({ SNICallback: (n, cb) => cb(contexts.has(n) ? null : new Error("no certificate"), contexts.get(n)) }, (s) => s.end());
  track(srv);
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
  return { add: (n: string) => contexts.set(n, ca.issue(n)) };
}

const freePort = async () => {
  const s = createTcp();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
};

async function setup(addresses: HostAddress[] = [{ address: "127.0.0.1", kind: "lan", interface: "lo" }], rtIn?: Awaited<ReturnType<typeof runtime>>) {
  const rt = rtIn ?? await runtime();
  const caddy = await fakeCaddy(rt.home);
  const ca = testCa();
  const httpsPort = await freePort();
  const dm = await daemon(rt, {
    web: { caddySocket: caddy.socket, tlsLog: join(rt.home, "tls.log"), httpsPort, addresses: () => addresses, certWaitMs: 1500, trustCa: ca.ca },
    rateLimit: { free: 1, baseMs: 60_000, maxMs: 600_000 },
  });
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const url = `/api/u/${rt.ada.id}/admin/web-access`;
  return { rt, ...dm, caddy, ca, httpsPort, ada, url };
}

const builtin = (name = "lyrica.example.net") => ({
  mode: "builtin", name, builtin: { addresses: ["127.0.0.1"], provider: "cloudflare", credentials: { api_token: TOKEN }, staging: false },
});
const routes = (cfg: any) => cfg.apps.http.servers.lyrica.routes.map((r: any) => r.match[0].host[0]);

describe("web access, Direct", () => {
  it("serves HTTP/2 and checks mutation origins against :authority without Host", async () => {
    const rt = await runtime();
    const port = await freePort();
    const { base } = await daemon(rt, {
      web: { directPort: port, addresses: () => [{ address: "127.0.0.1", kind: "lan", interface: "lo" }], caddySocket: join(rt.home, "no-caddy.sock") },
    });
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const panel = await ada.put<WebAccess>(`/api/u/${rt.ada.id}/admin/web-access`, { mode: "direct" });
    expect(panel.status).toBe(200);
    const origin = `https://127.0.0.1:${port}`;
    const client = connect(origin, {
      ca: panel.body.direct!.pem, servername: "",
      checkServerIdentity: (_host, cert) => checkServerIdentity("127.0.0.1", cert),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      });
      expect(client.alpnProtocol).toBe("h2");
      const request = (path: string, postOrigin?: string) => new Promise<number>((resolve, reject) => {
        // No Host header: HTTP/2 supplies :authority instead.
        const req = client.request({ ":path": path, ":authority": new URL(origin).host,
          ...(postOrigin ? { ":method": "POST", origin: postOrigin, "content-type": "application/json" } : {}) });
        let headers: IncomingHttpHeaders;
        req.on("response", (h) => { headers = h; });
        req.on("error", reject);
        req.on("end", () => resolve(Number(headers[":status"])));
        req.resume();
        req.end(postOrigin ? JSON.stringify({ login: "ada", password: "pw" }) : undefined);
      });
      expect(await request("/api/state")).toBe(200);
      expect(await request("/api/login", origin)).toBe(200);
      expect(await request("/api/login", "https://other.example.net")).toBe(403);
    } finally {
      client.destroy();
    }
  });
});

describe("web access, built-in Caddy", () => {
  it("writes Caddy's config for the site, DNS provider and upstream, and never gives the token back", async () => {
    const { rt, d, caddy, ca, httpsPort, ada, url, logs } = await setup();
    await caddyServing(httpsPort, ca, ["lyrica.example.net"]);
    const put = await ada.put<WebAccess>(url, builtin());
    expect(put.status).toBe(200);
    const cfg = caddy.state.config as any;
    expect(cfg.admin.listen).toBe(`unix/${caddy.socket}|0660`);
    expect(cfg.logging.logs.default).toEqual({ exclude: ["tls"] }); // TLS errors (which can quote a token) never reach the journal
    const server = cfg.apps.http.servers.lyrica;
    expect(server.listen).toEqual([`127.0.0.1:${httpsPort}`]);
    expect(routes(cfg)).toEqual(["lyrica.example.net"]);
    expect(server.routes[0].handle[0]).toMatchObject({ handler: "reverse_proxy", upstreams: [{ dial: `127.0.0.1:${d.port}` }] });
    expect(server.automatic_https).toEqual({ disable_redirects: true });
    const policy = cfg.apps.tls.automation.policies[0];
    expect(policy.subjects).toEqual(["lyrica.example.net"]);
    expect(policy.issuers[0]).toMatchObject({ module: "acme", challenges: { dns: { provider: { name: "cloudflare", api_token: TOKEN } } } });

    // The token never comes back, and saving the same provider again without it keeps it.
    expect(put.body.builtin!.credentials).toEqual({ api_token: { set: true } });
    expect(JSON.stringify((await ada.get(url)).body)).not.toContain(TOKEN);
    expect((await ada.put(url, { ...builtin(), builtin: { ...builtin().builtin, credentials: {} } })).status).toBe(200);
    expect(JSON.stringify(caddy.state.config)).toContain(TOKEN);

    const status = (await ada.get<WebAccessStatus>(`${url}/status`)).body;
    expect(status).toMatchObject({ mode: "builtin", caddy: { answers: true, configured: true, applied: true }, certificate: { subject: "lyrica.example.net" } });
    expect(JSON.stringify(status)).not.toContain(TOKEN);

    // Encrypted at rest with the rest of self.db, and never logged.
    for (const f of readdirSync(rt.home).filter((x) => x.startsWith("self.db"))) expect(readFileSync(join(rt.home, f)).includes(TOKEN)).toBe(false);
    expect(logs.join("\n")).not.toContain(TOKEN);

    // Sandboxes: the front door's port on this machine and wherever the name resolves.
    expect(d.services!.web.frontDoor()).toEqual({ ports: [httpsPort], hosts: ["lyrica.example.net"], exclude: [] });
  });

  it("keeps the old name served until the new one's certificate verifies, and goes back if none comes", async () => {
    const { caddy, ca, httpsPort, ada, url } = await setup();
    const tls = await caddyServing(httpsPort, ca, ["old.example.net"]);
    expect((await ada.put(url, builtin("old.example.net"))).status).toBe(200);
    const settled = caddy.state.config;

    // No certificate for the new name (no DNS record yet, a token for the wrong zone): both names were served while
    // waiting, then the old config is back and nothing is saved.
    caddy.state.loads.length = 0;
    const failed = await ada.put<{ error: string }>(url, builtin("new.example.net"));
    expect(failed.status).toBe(400);
    expect(failed.body.error).toMatch(/no certificate for new\.example\.net came within/);
    expect(routes(caddy.state.loads[0])).toEqual(["new.example.net", "old.example.net"]);
    expect(caddy.state.config).toEqual(settled);
    expect((await ada.get<WebAccess>(url)).body.name).toBe("old.example.net");

    // Once it can get one, the switch finishes and the old name goes.
    tls.add("new.example.net");
    caddy.state.loads.length = 0;
    expect((await ada.put(url, builtin("new.example.net"))).status).toBe(200);
    expect(caddy.state.loads.map(routes)).toEqual([["new.example.net", "old.example.net"], ["new.example.net"]]);
  });

  it("keeps the previous config when Caddy refuses the new one", async () => {
    const { caddy, ada, url, logs } = await setup();
    expect((await ada.put<{ error: string }>(url, builtin("not a host"))).body.error).toMatch(/^the hostname is a domain name/);
    caddy.state.refuse = true;
    const refused = await ada.put<{ error: string }>(url, builtin());
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("appears invalid");
    expect(refused.body.error).not.toContain(TOKEN);
    expect((await ada.get<WebAccess>(url)).body.mode).toBe("off");
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("says when Caddy runs with no site", async () => {
    const { ca, httpsPort, caddy, ada, url } = await setup();
    await caddyServing(httpsPort, ca, ["lyrica.example.net"]);
    await ada.put(url, builtin());
    caddy.state.config = { admin: { listen: `unix/${caddy.socket}|0660` } }; // its saved config was set aside at start
    expect((await ada.get<WebAccessStatus>(`${url}/status`)).body.caddy).toEqual({ answers: true, configured: false, applied: false });
  });

  it("is for administrators only", async () => {
    const { base, rt, url } = await setup();
    const sam = await login(base, "sam", "pw2");
    const samUrl = url.replace(rt.ada.id, rt.sam.id);
    for (const p of [samUrl, `${samUrl}/status`, `${samUrl}/snippet`]) expect((await sam.get(p)).status).toBe(403);
    expect((await sam.put(samUrl, builtin())).status).toBe(403);
    expect((await sam.get(url)).status).toBe(401);
  });
});

// The external listener needs an address other than loopback, as on a LAN.
const lan = Object.values(networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address;

/** One request to the extra listener: status, or the error. */
function call(o: { https: boolean; port: number; path: string; method?: string; ca?: string; headers?: Record<string, string>; body?: string }): Promise<number | string> {
  return new Promise((resolve) => {
    const make = o.https ? httpsRequest : httpRequest;
    const req = make({ host: lan, port: o.port, path: o.path, method: o.method ?? "GET", headers: o.headers, timeout: 5000, ...(o.https ? { ca: o.ca, checkServerIdentity: (_h: string, cert: PeerCertificate) => checkServerIdentity(lan!, cert) } : {}) }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", (err) => resolve(err.message));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(o.body);
  });
}

const external = (port: number, proxies: string[], extra: Record<string, unknown> = {}) =>
  ({ mode: "external", name: "lyrica.example.net", external: { address: lan, port, proxies, ...extra } });

/**
 * Turns the external listener on at a free port. Other test files run
 * alongside and can take a port between freePort and the daemon's listen,
 * so a port it couldn't open is tried again with another. Any other answer
 * fails the test with its reason.
 */
async function onFreePort(ada: Awaited<ReturnType<typeof login>>, url: string, proxies: string[], extra: Record<string, unknown> = {}) {
  for (let tries = 1; ; tries++) {
    const port = await freePort();
    const put = await ada.put<WebAccess & { error?: string }>(url, external(port, proxies, extra));
    if (put.status === 400 && /couldn't listen/.test(put.body.error ?? "") && tries < 5) continue;
    expect(put.status, put.body.error).toBe(200);
    return { port, put };
  }
}

describe.skipIf(!lan)("web access, external proxy", () => {
  it("listens for the listed proxies only, over HTTPS the proxy pins, and believes only their forwarded addresses", async () => {
    const { rt, d, ada, url } = await setup([{ address: lan!, kind: "lan", interface: "eth0" }]);
    const { port, put } = await onFreePort(ada, url, ["192.0.2.250"], { proxyPort: 8443 });
    expect(put.status).toBe(200);
    const ext = put.body.external!;
    expect(ext).toMatchObject({ address: lan, port, https: true, proxyPort: 8443, fingerprint: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/) });

    // Its settings and TLS key are in a file only lyricad's user can read, so it can open before unlock.
    const file = join(rt.home, "web-external.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("PRIVATE KEY");

    // From an address that isn't a listed proxy (this machine's own): refused.
    expect(typeof await call({ https: true, port, path: "/api/state", ca: ext.pem })).toBe("string");

    // Listed: HTTPS with the pinned certificate works; plain HTTP on a LAN address doesn't, nor an unpinned client.
    await ada.put(url, external(port, [lan!], { proxyPort: 8443 }));
    expect(await call({ https: true, port, path: "/api/state", ca: ext.pem })).toBe(200);
    expect(await call({ https: false, port, path: "/api/state" })).not.toBe(200);
    expect(typeof await call({ https: true, port, path: "/api/state" })).toBe("string");

    // A new name keeps the certificate (it names only the address), so the proxy's pin holds.
    const renamed = (await ada.put<WebAccess>(url, { ...external(port, [lan!]), name: "home.example.net" })).body.external!;
    expect(renamed.fingerprint).toBe(ext.fingerprint);

    // X-Forwarded-For from the proxy names the client: each forwarded address is limited on its own.
    const attempt = (ip: string, loginName: string) => call({
      https: true, port, path: "/api/login", method: "POST", ca: ext.pem, body: JSON.stringify({ login: loginName, password: "x" }),
      headers: { "content-type": "application/json", host: "home.example.net", origin: "https://home.example.net", "x-forwarded-for": ip },
    });
    expect(await attempt("203.0.113.1", "nobody-1")).toBe(401);
    expect(await attempt("203.0.113.2", "nobody-2")).toBe(401);
    expect(await attempt("203.0.113.1", "nobody-3")).toBe(429);

    // The proxy's site, and the front door for sandboxes: its port on the proxy and the name, and the extra port everywhere.
    const snippet = (await ada.get<{ caddyfile: string }>(`${url}/snippet`)).body.caddyfile;
    expect(snippet).toContain("home.example.net {");
    expect(snippet).toContain(`reverse_proxy https://${lan}:${port}`);
    expect(snippet).toContain("tls_trust_pool file");
    expect(snippet).toContain("dns cloudflare");
    expect(d.services!.web.frontDoor()).toEqual({ ports: [443], hosts: ["home.example.net", lan], exclude: [port] });

    // Back to off: the extra listener closes and its file goes.
    expect((await ada.put(url, { mode: "off" })).status).toBe(200);
    expect(typeof await call({ https: true, port, path: "/api/state", ca: ext.pem })).toBe("string");
    expect(readdirSync(rt.home)).not.toContain("web-external.json");
  });

  it("opens before unlock, answering only state, unlock and the web UI", async () => {
    const first = await setup([{ address: lan!, kind: "lan", interface: "eth0" }]);
    const { port, put } = await onFreePort(first.ada, first.url, [lan!]);
    const ext = put.body.external!;
    await first.stop();

    const again = await daemon(first.rt, { web: { caddySocket: first.caddy.socket, addresses: () => [{ address: lan!, kind: "lan", interface: "eth0" }] } });
    expect(again.d.locked).toBe(true);
    expect(await call({ https: true, port, path: "/api/state", ca: ext.pem })).toBe(200);
    expect(await call({ https: true, port, path: `/api/u/${first.rt.ada.id}/threads`, ca: ext.pem })).toBe(503);
  });

  it("serves plain HTTP only on a Tailscale interface, whatever the address range", async () => {
    const { ada, url } = await setup([{ address: lan!, kind: "tailscale", interface: "tailscale0" }]);
    const { port, put } = await onFreePort(ada, url, [lan!]);
    expect(put.body.external).toMatchObject({ https: false });
    expect(await call({ https: false, port, path: "/api/state" })).toBe(200);
    expect((await ada.get<{ caddyfile: string }>(`${url}/snippet`)).body.caddyfile).toContain(`reverse_proxy ${lan}:${port}`);
  });

  it("refuses an address that isn't this machine's, or a taken port, and keeps the previous setup", async () => {
    const { d, ada, url } = await setup([{ address: lan!, kind: "lan", interface: "eth0" }]);
    expect((await ada.put(url, external(7999, ["192.0.2.1"], { address: "192.0.2.99" }))).status).toBe(400);
    expect((await ada.put(url, external(d.port, ["192.0.2.1"]))).status).toBe(400);
    const busy = createTcp();
    track(busy);
    await new Promise<void>((r) => busy.listen(0, lan, r));
    const taken = (busy.address() as AddressInfo).port;
    const r = await ada.put<{ error: string }>(url, external(taken, ["192.0.2.1"]));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/couldn't listen/);
    expect((await ada.get<WebAccess>(url)).body.mode).toBe("off");

    // Changing the port: if the new one can't open, the old listener keeps working.
    const { port, put } = await onFreePort(ada, url, [lan!]);
    const ext = put.body.external!;
    expect((await ada.put(url, external(taken, [lan!]))).status).toBe(400);
    expect(await call({ https: true, port, path: "/api/state", ca: ext.pem })).toBe(200);
  });
});
