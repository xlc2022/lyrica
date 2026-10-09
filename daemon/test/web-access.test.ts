import { readdirSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createTcp, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebAccess, WebAccessStatus } from "../src/api.ts";
import { browser, daemon, login, runtime } from "./helpers.ts";

const TOKEN = "cf-token-7d1e5b0a9c2f4e6b8a1d3c5e7f9b0a2c";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.close(r); s.closeAllConnections?.(); }))); });

/** A fake Caddy admin API on a Unix socket: GET /config/ and POST /load, which can be told to refuse. */
async function fakeCaddy(dir: string) {
  const socket = join(dir, "caddy-admin.sock");
  const state = { config: { admin: { listen: `unix/${socket}|0660` } } as unknown, loads: [] as unknown[], refuse: false };
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
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(socket, r));
  return { socket, state };
}

const freePort = async () => {
  const s = createTcp();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
};

/** Something listening where Caddy would serve, so the check after loading passes. */
async function caddyListening(port: number) {
  const s = createTcp((c) => c.destroy());
  servers.push(s as unknown as Server);
  await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
}

async function setup(addresses = [{ address: "127.0.0.1", kind: "lan" as const, interface: "lo" }]) {
  const rt = await runtime();
  const caddy = await fakeCaddy(rt.home);
  const httpsPort = await freePort();
  const dm = await daemon(rt, {
    web: { caddySocket: caddy.socket, tlsLog: join(rt.home, "tls.log"), httpsPort, addresses: () => addresses },
    rateLimit: { free: 1, baseMs: 60_000, maxMs: 600_000 },
  });
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const li = await login(dm.base, "li", "pw");
  const url = `/api/u/${rt.li.id}/admin/web-access`;
  return { rt, ...dm, caddy, httpsPort, li, url };
}

const builtin = { mode: "builtin", name: "lyrica.example.net", builtin: { addresses: ["127.0.0.1"], provider: "cloudflare", credentials: { api_token: TOKEN }, staging: true } };

describe("web access, built-in Caddy", () => {
  it("writes Caddy's config for the site, DNS provider and upstream, and never gives the token back", async () => {
    const { rt, d, caddy, httpsPort, li, url, logs } = await setup();
    await caddyListening(httpsPort);
    const put = await li.put<WebAccess>(url, builtin);
    expect(put.status).toBe(200);
    const cfg = caddy.state.config as any;
    expect(cfg.admin.listen).toBe(`unix/${caddy.socket}|0660`);
    const server = cfg.apps.http.servers.lyrica;
    expect(server.listen).toEqual([`127.0.0.1:${httpsPort}`]);
    expect(server.routes[0].match[0].host).toEqual(["lyrica.example.net"]);
    expect(server.routes[0].handle[0]).toMatchObject({ handler: "reverse_proxy", upstreams: [{ dial: `127.0.0.1:${d.port}` }] });
    expect(server.automatic_https).toEqual({ disable_redirects: true });
    const policy = cfg.apps.tls.automation.policies[0];
    expect(policy.subjects).toEqual(["lyrica.example.net"]);
    expect(policy.issuers[0]).toMatchObject({ module: "acme", ca: expect.stringContaining("staging"), challenges: { dns: { provider: { name: "cloudflare", api_token: TOKEN } } } });

    // The token never comes back, and saving the same provider again without it keeps it.
    expect(put.body.builtin!.credentials).toEqual({ api_token: { set: true } });
    expect(JSON.stringify((await li.get(url)).body)).not.toContain(TOKEN);
    expect((await li.put(url, { ...builtin, builtin: { ...builtin.builtin, credentials: {} } })).status).toBe(200);
    expect(JSON.stringify(caddy.state.config)).toContain(TOKEN);

    const status = (await li.get<WebAccessStatus>(`${url}/status`)).body;
    expect(status).toMatchObject({ mode: "builtin", caddy: { answers: true, applied: true } });
    expect(JSON.stringify(status)).not.toContain(TOKEN);

    // Encrypted at rest with the rest of self.db, and never logged.
    for (const f of readdirSync(rt.home).filter((x) => x.startsWith("self.db"))) expect(readFileSync(join(rt.home, f)).includes(TOKEN)).toBe(false);
    expect(logs.join("\n")).not.toContain(TOKEN);

    // Sandboxes: the front door's port on this machine and wherever the name resolves.
    expect(d.services!.web.frontDoor()).toEqual({ ports: [httpsPort], hosts: ["lyrica.example.net"], exclude: [] });
  });

  it("keeps the previous config when Caddy refuses the new one, or doesn't serve it", async () => {
    const { caddy, httpsPort, li, url, logs } = await setup();
    // Refused: nothing changes, and the reason comes back without the token.
    caddy.state.refuse = true;
    const refused = await li.put<{ error: string }>(url, builtin);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("appears invalid");
    expect(refused.body.error).not.toContain(TOKEN);
    expect((await li.get<WebAccess>(url)).body.mode).toBe("off");
    caddy.state.refuse = false;

    // Loaded, but nothing serves on the address: the old config goes back.
    const before = caddy.state.config;
    const unserved = await li.put<{ error: string }>(url, builtin);
    expect(unserved.status).toBe(400);
    expect(unserved.body.error).toMatch(/didn't start serving/);
    expect(caddy.state.config).toEqual(before);
    expect((await li.get<WebAccess>(url)).body.mode).toBe("off");
    expect(logs.join("\n")).not.toContain(TOKEN);

    await caddyListening(httpsPort);
    expect((await li.put(url, builtin)).status).toBe(200);
  });

  it("is for administrators only", async () => {
    const { base, rt, url } = await setup();
    const sam = await login(base, "sam", "pw2");
    const samUrl = url.replace(rt.li.id, rt.sam.id);
    for (const p of [samUrl, `${samUrl}/status`, `${samUrl}/snippet`]) expect((await sam.get(p)).status).toBe(403);
    expect((await sam.put(samUrl, builtin)).status).toBe(403);
    expect((await sam.get(url)).status).toBe(401);
  });
});

// The external listener needs an address other than loopback, as on a LAN.
const lan = Object.values(networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address;

/** One request to the extra listener: status, or the error. */
function call(o: { https: boolean; port: number; path: string; method?: string; ca?: string; headers?: Record<string, string>; body?: string }): Promise<number | string> {
  return new Promise((resolve) => {
    const make = o.https ? httpsRequest : httpRequest;
    const req = make({ host: lan, port: o.port, path: o.path, method: o.method ?? "GET", headers: o.headers, timeout: 5000, ...(o.https ? { ca: o.ca } : {}) }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", (err) => resolve(err.message));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(o.body);
  });
}

describe.skipIf(!lan)("web access, external proxy", () => {
  it("listens for the listed proxies only, over HTTPS the proxy pins, and believes only their forwarded addresses", async () => {
    const { d, li, url } = await setup([{ address: lan!, kind: "lan", interface: "eth0" }]);
    const port = await freePort();
    const put = await li.put<WebAccess>(url, { mode: "external", name: "lyrica.example.net", external: { address: lan, port, proxies: ["192.0.2.250"] } });
    expect(put.status).toBe(200);
    const ext = put.body.external!;
    expect(ext).toMatchObject({ address: lan, port, https: true, fingerprint: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/) });

    // From an address that isn't a listed proxy (this machine's own): refused.
    expect(typeof await call({ https: true, port, path: "/api/state", ca: ext.pem })).toBe("string");

    // Listed: HTTPS with the pinned certificate works; plain HTTP on a LAN address doesn't.
    await li.put(url, { mode: "external", name: "lyrica.example.net", external: { address: lan, port, proxies: [lan] } });
    expect(await call({ https: true, port, path: "/api/state", ca: ext.pem })).toBe(200);
    expect(await call({ https: false, port, path: "/api/state" })).not.toBe(200);
    // A certificate the proxy didn't pin is refused by the client.
    expect(typeof await call({ https: true, port, path: "/api/state" })).toBe("string");

    // X-Forwarded-For from the proxy names the client: each forwarded address is limited on its own.
    const attempt = (ip: string, loginName: string) => call({
      https: true, port, path: "/api/login", method: "POST", ca: ext.pem, body: JSON.stringify({ login: loginName, password: "x" }),
      headers: { "content-type": "application/json", host: "lyrica.example.net", origin: "https://lyrica.example.net", "x-forwarded-for": ip },
    });
    expect(await attempt("203.0.113.1", "nobody-1")).toBe(401);
    expect(await attempt("203.0.113.2", "nobody-2")).toBe(401);
    expect(await attempt("203.0.113.1", "nobody-3")).toBe(429);

    // The proxy's site, and the front door for sandboxes: the proxy, the name, and the extra port everywhere.
    const snippet = (await li.get<{ caddyfile: string }>(`${url}/snippet`)).body.caddyfile;
    expect(snippet).toContain("lyrica.example.net {");
    expect(snippet).toContain(`reverse_proxy https://${lan}:${port}`);
    expect(snippet).toContain("tls_trust_pool file");
    expect(d.services!.web.frontDoor()).toEqual({ ports: [443], hosts: ["lyrica.example.net", lan], exclude: [port] });

    // Back to off: the extra listener closes.
    expect((await li.put(url, { mode: "off" })).status).toBe(200);
    expect(typeof await call({ https: true, port, path: "/api/state", ca: ext.pem })).toBe("string");
  });

  it("refuses an address that isn't this machine's, or a taken port, and keeps the previous setup", async () => {
    const { d, li, url } = await setup([{ address: lan!, kind: "lan", interface: "eth0" }]);
    expect((await li.put(url, { mode: "external", name: "lyrica.example.net", external: { address: "192.0.2.99", port: 7999, proxies: ["192.0.2.1"] } })).status).toBe(400);
    expect((await li.put(url, { mode: "external", name: "lyrica.example.net", external: { address: lan, port: d.port, proxies: ["192.0.2.1"] } })).status).toBe(400);
    const busy = createTcp();
    servers.push(busy as unknown as Server);
    await new Promise<void>((r) => busy.listen(0, lan, r));
    const taken = (busy.address() as AddressInfo).port;
    const r = await li.put<{ error: string }>(url, { mode: "external", name: "lyrica.example.net", external: { address: lan, port: taken, proxies: ["192.0.2.1"] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/couldn't listen/);
    expect((await li.get<WebAccess>(url)).body.mode).toBe("off");
  });
});
