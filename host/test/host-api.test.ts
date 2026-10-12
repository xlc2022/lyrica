import http from "node:http";
import https from "node:https";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Host, fingerprint, makeIdentity, type Identity } from "../src/index.ts";
import { HostIdentityChanged, call, lyrica, pair, startHost } from "./helpers.ts";

const open: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

async function host(overrides = {}) {
  const h = await startHost(overrides);
  open.push(h.host);
  return h;
}

/** A request to the local (plain HTTP) listener. */
function local(port: number, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: init.method ?? (init.body ? "POST" : "GET"), headers: { host: `127.0.0.1:7236`, "content-type": "application/json", ...init.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let body: any = text;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode!, body });
      });
    });
    req.on("error", reject);
    if (init.body) req.write(JSON.stringify(init.body));
    req.end();
  });
}

async function code(port: number): Promise<string> {
  const made = await local(port, "/dashboard/pairing", { method: "POST" });
  expect(made.status).toBe(200);
  return made.body.code;
}

describe("host identity", () => {
  it("makes certificates that always parse", () => {
    for (let i = 0; i < 600; i++) expect(fingerprint(makeIdentity("x").cert)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("makes its key once, readable only by its user", async () => {
    const { host: h, dataDir } = await host();
    expect(statSync(join(dataDir, "host.key")).mode & 0o777).toBe(0o600);
    const again = new Host({ ...h.opts });
    expect(again.identity.fingerprint).toBe(h.identity.fingerprint);
    expect(fingerprint(readFileSync(join(dataDir, "host.crt")))).toBe(h.identity.fingerprint);
  });
});

describe("pairing", () => {
  it("pairs with the right code, pins both sides, then serves over mutual TLS", async () => {
    const { host: h, tls, local: lp } = await host();
    const me = lyrica();
    const hostFp = await pair(tls, me, (await code(lp)).toLowerCase());
    expect(hostFp).toBe(h.identity.fingerprint);
    expect(h.state.client(fingerprint(me.cert))?.name).toBe("Lyrica test");
    const status = await call({ port: tls, path: "/host/v1/status", identity: me, pinned: hostFp });
    expect(status.status).toBe(200);
    expect(status.body.fingerprint).toBe(hostFp);
  });

  it("refuses a wrong code, and voids the code after five wrong tries", async () => {
    const { tls, local: lp } = await host();
    const right = await code(lp);
    const wrong = right.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    for (let i = 0; i < 5; i++) await expect(pair(tls, lyrica(), wrong)).rejects.toThrow("pairing_failed");
    await expect(pair(tls, lyrica(), right)).rejects.toThrow("no_code");
  });

  it("uses a code once, and refuses one that expired", async () => {
    let now = Date.now();
    const { tls, local: lp } = await host({ now: () => now });
    const c = await code(lp);
    await pair(tls, lyrica(), c);
    await expect(pair(tls, lyrica(), c)).rejects.toThrow("no_code");
    const later = await code(lp);
    now += 10 * 60_000 + 1;
    await expect(pair(tls, lyrica(), later)).rejects.toThrow("no_code");
  });

  it("needs a client certificate", async () => {
    const { tls, local: lp } = await host();
    await code(lp);
    const reply = await call({ port: tls, path: "/pair/v1", body: { name: "x", clientNonce: "A".repeat(43), proof: "A".repeat(43) } });
    expect(reply.body.error.code).toBe("client_certificate_required");
  });

  it("fails against a machine in the middle, which ends up pinned nowhere", async () => {
    const { host: h, tls, local: lp } = await host();
    const middle = makeIdentity("middle");
    // Terminates TLS with its own key on both sides and relays requests.
    const mitm = https.createServer({ key: middle.key, cert: middle.cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
      const out = https.request({ host: "127.0.0.1", port: tls, path: req.url, method: req.method, headers: req.headers, key: middle.key, cert: middle.cert, rejectUnauthorized: false }, (r) => {
        res.writeHead(r.statusCode!, r.headers);
        r.pipe(res);
      });
      req.pipe(out);
    });
    await new Promise<void>((r) => mitm.listen(0, "127.0.0.1", r));
    open.push({ close: () => new Promise<void>((r) => { mitm.closeAllConnections(); mitm.close(() => r()); }) });
    const port = (mitm.address() as any).port;
    await expect(pair(port, lyrica(), await code(lp))).rejects.toThrow("pairing_failed");
    expect(h.state.get().clients).toEqual([]);
  });

  it("is refused by the client when the host's key changed", async () => {
    const { tls, local: lp } = await host();
    const me = lyrica();
    const pinned = await pair(tls, me, await code(lp));
    // Another host answering at an address Lyrica knows.
    const impostor = await host();
    await expect(call({ port: impostor.tls, path: "/host/v1/status", identity: me, pinned })).rejects.toBeInstanceOf(HostIdentityChanged);
  });
});

describe("after pairing", () => {
  it("refuses an unpaired client", async () => {
    const { tls } = await host();
    const reply = await call({ port: tls, path: "/host/v1/status", identity: lyrica() });
    expect(reply.status).toBe(401);
    expect(reply.body.error.code).toBe("unpaired");
  });

  it("refuses a revoked client, even on a connection it already has open", async () => {
    const { tls, local: lp } = await host();
    const me = lyrica();
    const pinned = await pair(tls, me, await code(lp));
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    open.push({ close: () => agent.destroy() });
    expect((await call({ port: tls, path: "/host/v1/status", identity: me, pinned, agent })).status).toBe(200);
    const { body } = await local(lp, "/dashboard/clients");
    expect(body.clients).toHaveLength(1);
    expect(body.clients[0].lastSeen).not.toBeNull();
    expect((await local(lp, `/dashboard/clients/${fingerprint(me.cert)}`, { method: "DELETE" })).status).toBe(200);
    const after = await call({ port: tls, path: "/host/v1/status", identity: me, pinned, agent });
    expect(after.body.error.code).toBe("unpaired");
  });

  it("doesn't let a paired client make codes or revoke", async () => {
    const { tls, local: lp } = await host();
    const me = lyrica();
    const pinned = await pair(tls, me, await code(lp));
    for (const [method, path] of [["POST", "/dashboard/pairing"], ["GET", "/dashboard/clients"], ["DELETE", `/dashboard/clients/${fingerprint(me.cert)}`]] as const) {
      const reply = await call({ port: tls, path, method, identity: me, pinned });
      expect(reply.status).toBe(403);
    }
  });
});

describe("dashboard", () => {
  it("needs no login at the machine", async () => {
    const { local: lp } = await host();
    expect((await local(lp, "/host/v1/status")).status).toBe(200);
    expect((await local(lp, "/")).body).toContain("Lyrica model host");
  });

  it("accepts the local listener only from the published port's address", async () => {
    const { local: lp } = await host({ localPeers: ["172.31.0.1"] });
    await expect(local(lp, "/host/v1/status")).rejects.toThrow();
  });

  it("needs the password remotely, and rate-limits it", async () => {
    const { tls, local: lp } = await host();
    const headers = { host: "test-host:7236", origin: "https://test-host:7236" };
    expect((await call({ port: tls, path: "/host/v1/status", headers })).body.error.code).toBe("login");
    expect((await call({ port: tls, path: "/dashboard/login", headers, body: { password: "anything at all" } })).status).toBe(403);
    expect((await local(lp, "/dashboard/password", { body: { password: "correct horse" } })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await call({ port: tls, path: "/dashboard/login", headers, body: { password: "wrong" } })).status).toBe(401);
    expect((await call({ port: tls, path: "/dashboard/login", headers, body: { password: "correct horse" } })).status).toBe(429);
  });

  it("counts sign-in tries sent in parallel", async () => {
    const { tls, local: lp } = await host();
    const headers = { host: "test-host:7236", origin: "https://test-host:7236" };
    await local(lp, "/dashboard/password", { body: { password: "correct horse" } });
    const replies = await Promise.all(Array.from({ length: 12 }, () => call({ port: tls, path: "/dashboard/login", headers, body: { password: "wrong" } })));
    expect(replies.filter((r) => r.status === 401)).toHaveLength(5);
    expect(replies.filter((r) => r.status === 429)).toHaveLength(7);
  });

  it("signs in remotely with the password", async () => {
    const { tls, local: lp } = await host();
    const headers = { host: "test-host:7236", origin: "https://test-host:7236" };
    await local(lp, "/dashboard/password", { body: { password: "correct horse" } });
    const login = await call({ port: tls, path: "/dashboard/login", headers, body: { password: "correct horse" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    expect(String(login.headers["set-cookie"])).toMatch(/Secure; HttpOnly; SameSite=Strict/);
    const status = await call({ port: tls, path: "/host/v1/status", headers: { ...headers, cookie } });
    expect(status.status).toBe(200);
    // Making a code works signed in, but changing the password needs the current one.
    expect((await call({ port: tls, path: "/dashboard/pairing", method: "POST", headers: { ...headers, cookie } })).status).toBe(200);
    expect((await call({ port: tls, path: "/dashboard/password", headers: { ...headers, cookie }, body: { password: "something else" } })).status).toBe(401);
  });

  it("rejects a foreign Origin and an unknown Host", async () => {
    const { tls, local: lp } = await host();
    expect((await local(lp, "/dashboard/pairing", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await local(lp, "/dashboard/pairing", { method: "POST", headers: { origin: "http://127.0.0.1:7236", "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await local(lp, "/host/v1/status", { headers: { host: "evil.example:7236" } })).status).toBe(403);
    expect((await local(lp, "/dashboard/pairing", { method: "POST", headers: { origin: "http://127.0.0.1:7236", "sec-fetch-site": "same-origin" } })).status).toBe(200);
    expect((await call({ port: tls, path: "/dashboard/me", headers: { host: "rebound.example:7236" } })).status).toBe(403);
  });

  it("accepts the host's own tailnet name and no other", async () => {
    const { tls } = await host({ tailnetName: "test-host" });
    expect((await call({ port: tls, path: "/dashboard/me", headers: { host: "test-host.tail1234.ts.net" } })).status).toBe(200);
    expect((await call({ port: tls, path: "/dashboard/me", headers: { host: "other.tail1234.ts.net" } })).status).toBe(403);
    expect((await call({ port: tls, path: "/dashboard/me", headers: { host: "test-host.tail1234.ts.net.evil.example" } })).status).toBe(403);
  });

  it("logs no pairing secrets, not even the code, and no passwords", async () => {
    const lines: string[] = [];
    const { tls, local: lp } = await host({ log: (event: string, fields?: object) => lines.push(JSON.stringify({ event, ...fields })) });
    await local(lp, "/dashboard/password", { body: { password: "marker-password-123" } });
    const me: Identity = lyrica();
    await pair(tls, me, await code(lp));
    const log = lines.join("\n");
    expect(log).toContain("pairing code made");
    expect(log).not.toContain("marker-password-123");
    expect(log).not.toContain("proof");
  });
});
