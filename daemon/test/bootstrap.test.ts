import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, Keyring, PersonaStore, PRONOUN_PRESETS, SystemdCredentials } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import type { LoginResponse, State, Tailnet, WebAccess } from "../src/api.ts";
import { Lyricad, type LyricadOptions } from "../src/lyricad.ts";
import { browser, login } from "./helpers.ts";

const ARGON2 = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const KDF_ITER = 1;
const SEED = fileURLToPath(new URL("../../persona", import.meta.url));
const KEY = "tskey-auth-kQ4yS9cNTRL-7d1e5b0a9c2f4e6b8a1d3c5e7f9b0a2c";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

// A free port below Linux's ephemeral range (32768 and up), so a server another
// test opens on port 0 can't take it before lyricad binds it.
const freePort = async (): Promise<number> => {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const s = createTcp();
    const free = await new Promise<boolean>((r) => { s.once("error", () => r(false)); s.listen(port, "127.0.0.1", () => r(true)); });
    if (free) { await new Promise((r) => s.close(r)); return port; }
  }
};

const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * A fake `tailscale` that records its arguments in `calls` (one JSON array a
 * line) and keeps her device's state in `status.json`. `fail-login` makes
 * login fail quoting the key, as a CLI error might.
 */
function fakeTailscale() {
  const dir = tmp("lyrica-ts-");
  const bin = join(dir, "tailscale");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const args = process.argv.slice(2);
const st = () => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
const save = (s) => fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(s));
const rec = { args };
const cmd = args[2];
if (cmd === "login") {
  const file = args.find((a) => a.startsWith("--auth-key=file:")).slice("--auth-key=file:".length);
  rec.keyFileMode = (fs.statSync(file).mode & 0o777).toString(8);
  rec.keyFileHoldsKey = fs.readFileSync(file, "utf8") === ${JSON.stringify(KEY)};
}
fs.appendFileSync(path.join(dir, "calls"), JSON.stringify(rec) + "\\n");
const s = st();
switch (cmd) {
  case "status": process.stdout.write(JSON.stringify(s)); break;
  case "login":
    if (fs.existsSync(path.join(dir, "fail-login"))) { process.stderr.write("backend error: invalid key: " + ${JSON.stringify(KEY)} + "\\n"); process.exit(1); }
    save({ ...s, BackendState: "Running", Self: { ...s.Self, DNSName: "lyrica.example.ts.net.", TailscaleIPs: ["100.101.102.103", "fd7a::1"] },
      CurrentTailnet: { Name: "example.ts.net", MagicDNSSuffix: "example.ts.net", MagicDNSEnabled: true }, CertDomains: ["lyrica.example.ts.net"] });
    break;
  case "set": save({ ...s, Self: { ...s.Self, HostName: args[3].split("=")[1] } }); break;
  case "up": save({ ...s, BackendState: "Running" }); break;
  case "down": save({ ...s, BackendState: "Stopped" }); break;
  case "logout": save({ Version: s.Version, BackendState: "NeedsLogin", Self: { HostName: s.Self.HostName } }); break;
}
`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "status.json"), JSON.stringify({ Version: "1.90.1-t123", BackendState: "NeedsLogin", Self: { HostName: "lyrica-host" } }));
  return {
    bin,
    calls: (): { args: string[]; keyFileMode?: string; keyFileHoldsKey?: boolean }[] =>
      existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [],
    failLogin: (on: boolean) => (on ? writeFileSync(join(dir, "fail-login"), "") : rmSync(join(dir, "fail-login"), { force: true })),
  };
}

/** A lyricad with no self.db: it starts setting up. */
async function fresh(opts: Partial<LyricadOptions> & { home?: string; secrets?: Map<string, Buffer> } = {}) {
  const home = opts.home ?? tmp("lyricad-setup-");
  const sealed = join(home, "credentials");
  const secrets = opts.secrets ?? new Map<string, Buffer>();
  const logs: string[] = [];
  const ts = fakeTailscale();
  const directPort = await freePort();
  const d = new Lyricad({
    home, port: 0, argon2: ARGON2, kdfIter: KDF_ITER, selfTest: false, webDir: join(home, "no-web"),
    credentials: new SystemdCredentials(sealed, async (id, secret, out) => { secrets.set(id, Buffer.from(secret)); writeFileSync(out, "sealed"); }, async (id) => Buffer.from(secrets.get(id) ?? []), (line) => logs.push(line)),
    web: { addresses: () => [{ address: "127.0.0.1", kind: "lan", interface: "eth0" }], directPort, caddySocket: join(home, "no-caddy.sock"), certWaitMs: 300 },
    tailnet: { binary: ts.bin, socket: join(home, "tailscaled.sock") },
    rateLimit: { free: 1, baseMs: 60_000, maxMs: 600_000 },
    log: (l) => logs.push(l), ...opts,
  });
  await d.start();
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await d.stop(); } };
  cleanup.push(stop);
  const code = existsSync(join(home, "setup-code")) ? readFileSync(join(home, "setup-code"), "utf8").trim() : "";
  return { d, home, secrets, logs, ts, directPort, code, base: `http://127.0.0.1:${d.port}`, stop };
}

const ADMIN = { login: "ada", password: "pw", displayName: "Ada", pronouns: PRONOUN_PRESETS.she };

/** GET over HTTPS on 127.0.0.1, trusting only the given certificate. */
function getTls(port: number, path: string, ca: string): Promise<number | string> {
  return new Promise((resolve) => {
    const req = httpsRequest({ host: "127.0.0.1", port, path, ca, timeout: 5000, agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", (err) => resolve(err.message));
    req.end();
  });
}

describe("setting up", () => {
  it("answers only state and setup, behind a one-time code, and signs the first administrator in", async () => {
    const { d, home, base, code, logs } = await fresh();
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(statSync(join(home, "setup-code")).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toContain(`with the code in ${join(home, "setup-code")}`);
    expect(logs.join("\n")).not.toContain(code);

    const b = browser(base);
    expect((await b.get<State>("/api/state")).body).toEqual({ locked: true, setup: true, name: "Lyrica", users: [], credentials: { available: true } });
    expect((await b.post("/api/unlock", { passphrase: "x" })).status).toBe(503);
    expect((await b.post("/api/login", { login: "ada", password: "pw" })).status).toBe(503);
    expect((await b.get("/api/u/x/me")).status).toBe(503);

    // A wrong code: refused, no self.db, and counted with wrong passphrases.
    const wrong = await b.post("/api/setup", { code: "AAAA-AAAA", passphrase: "passphrase", admin: ADMIN });
    expect(wrong.status).toBe(403);
    expect(existsSync(join(home, "self.db"))).toBe(false);
    expect((await b.post("/api/setup", { code, passphrase: "passphrase", admin: ADMIN })).status).toBe(429);
    d.limiter.succeed([`unlock:127.0.0.1`]);

    // The code works whatever its case or dashes.
    const done = await b.post<LoginResponse>("/api/setup", { code: code.toLowerCase().replace("-", " "), passphrase: "passphrase", name: "Aria", admin: ADMIN });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ login: "ada", displayName: "Ada", admin: true });
    expect(b.cookie).toBeTruthy();
    const state = (await b.get<State>("/api/state")).body;
    expect(state).toMatchObject({ locked: false, name: "Aria", users: [{ login: "ada" }] });
    expect(state.setup).toBeUndefined();
    expect(readdirSync(home)).not.toContain("setup-code");
    expect((await b.get(`/api/u/${done.body.user.id}/me`)).status).toBe(200);
    expect((await b.post("/api/setup", { code, passphrase: "passphrase", admin: ADMIN })).status).toBe(409);
    // No log line holds the passphrase or the password.
    expect(logs.join("\n")).not.toMatch(/passphrase"|"pw"/);
  });

  it("leaves no self.db when setup fails after creating it, so the next attempt starts clean", async () => {
    const { home, base, code } = await fresh();
    const b = browser(base);
    const bad = await b.post<{ error: string }>("/api/setup", { code, passphrase: "passphrase", admin: { ...ADMIN, login: "not a login!" } });
    expect(bad.status).toBe(400);
    expect(readdirSync(home).filter((f) => f.startsWith("self.db") || f === "users")).toEqual([]);
    expect((await b.get<State>("/api/state")).body.setup).toBe(true);
    expect((await b.post("/api/setup", { code, passphrase: "passphrase", admin: ADMIN })).status).toBe(200);
  });

  it("saves the passphrase when asked, so the next start is unlocked", async () => {
    const first = await fresh();
    expect((await browser(first.base).post("/api/setup", { code: first.code, passphrase: "passphrase", saveCredentials: true, admin: ADMIN })).status).toBe(200);
    await first.stop();
    const again = await fresh({ home: first.home, secrets: first.secrets });
    expect(again.d.locked).toBe(false);
  });

  it("makes the same self.db as lyrica admin init", async () => {
    const shape = (home: string, passphrase: string) => {
      const k = new Keyring(home, ARGON2, KDF_ITER);
      return k.unlockSelf(passphrase).then(() => {
        const db = k.self();
        const out = {
          tables: (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name),
          // The recovery key is random per install: only that it exists compares.
          settings: (db.prepare("SELECT key, value FROM settings ORDER BY key").all() as { key: string; value: string }[])
            .map((r) => (r.key === "recovery.key" ? { key: r.key, value: "(random)" } : r)),
          persona: [...new PersonaStore(db).files().keys()],
          users: (db.prepare("SELECT login, admin, profile FROM users").all()),
        };
        k.closeSelf();
        return out;
      });
    };
    const cli = tmp("lyrica-init-");
    const k = new Keyring(cli, ARGON2, KDF_ITER);
    await bootstrap(k, { passphrase: "passphrase", name: "Aria", seed: SEED, admin: { login: "ada", password: "pw", profile: { displayName: "Ada", pronouns: PRONOUN_PRESETS.she } } });
    k.closeSelf();
    // Then lyricad's first start, as after admin init.
    const started = await fresh({ home: cli });
    await browser(started.base).post("/api/unlock", { passphrase: "passphrase" });
    await started.stop();
    const web = await fresh();
    await browser(web.base).post("/api/setup", { code: web.code, passphrase: "passphrase", name: "Aria", admin: ADMIN });
    await web.stop();
    expect(await shape(web.home, "passphrase")).toEqual(await shape(cli, "passphrase"));
  });
});

describe("her name", () => {
  it("goes in her REGISTER's Name line and nowhere else in the persona, and answers while locked", async () => {
    const f = await fresh();
    const setup = await browser(f.base).post<LoginResponse>("/api/setup", { code: f.code, passphrase: "passphrase", admin: ADMIN });
    const ada = await login(f.base, "ada", "pw");
    const url = `/api/u/${setup.body.user.id}/admin/name`;
    expect((await ada.get(url)).body).toEqual({ name: "Lyrica" });
    const before = f.d.services!.persona.read();
    expect((await ada.put(url, { name: "  Aria " })).body).toEqual({ name: "Aria" });
    expect((await ada.put(url, { name: "" })).status).toBe(400);
    expect((await ada.put(url, { name: "x".repeat(41) })).status).toBe(400);
    const after = f.d.services!.persona.read();
    const register = (p: typeof after) => p.core.find((c) => c.path === "REGISTER.md")!.text;
    expect(register(after)).toMatch(/^Name: Aria$/m);
    expect(register(after).replace("Name: Aria", "Name: Lyrica")).toBe(register(before));
    expect(after.core.filter((c) => c.path !== "REGISTER.md")).toEqual(before.core.filter((c) => c.path !== "REGISTER.md"));
    expect(after.topics).toEqual(before.topics);
    // The stored file is the seed's, unchanged.
    expect(f.d.services!.persona.files().get("REGISTER.md")).toMatch(/^Name: Lyrica$/m);

    await f.stop();
    const again = await fresh({ home: f.home });
    expect((await browser(again.base).get<State>("/api/state")).body).toEqual({ locked: true, name: "Aria", users: [] });
  });
});

describe("Direct web access", () => {
  it("serves HTTPS on every address with its own certificate before setup, refusing nothing by address, and stays on after", async () => {
    const f = await fresh();
    const file = join(f.home, "web-external.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ direct: true, addresses: ["127.0.0.1"], port: f.directPort });
    expect(await getTls(f.directPort, "/api/state", saved.tls.cert)).toBe(200);
    expect(await getTls(f.directPort, "/api/u/x/me", saved.tls.cert)).toBe(503);

    // Setup over Direct: the Origin is the address itself.
    const origin = `https://127.0.0.1:${f.directPort}`;
    const res = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ code: f.code, passphrase: "passphrase", admin: ADMIN });
      const req = httpsRequest({ host: "127.0.0.1", port: f.directPort, path: "/api/setup", method: "POST", ca: saved.tls.cert,
        headers: { "content-type": "application/json", origin, host: `127.0.0.1:${f.directPort}`, "x-forwarded-for": "203.0.113.9" } }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode ?? 0)); });
      req.on("error", reject);
      req.end(body);
    });
    expect(res).toBe(200);

    const ada = await login(f.base, "ada", "pw");
    const id = f.d.services!.users.find("ada")!.id;
    const view = (await ada.get<WebAccess>(`/api/u/${id}/admin/web-access`)).body;
    expect(view.mode).toBe("direct");
    expect(view.direct).toMatchObject({ addresses: ["127.0.0.1"], port: f.directPort, pem: saved.tls.cert, fingerprint: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/) });
    expect(f.d.services!.web.frontDoor()).toEqual({ ports: [443, f.directPort], hosts: [], exclude: [] });
    expect(await getTls(f.directPort, "/api/state", saved.tls.cert)).toBe(200);

    // The client's own address counts, never X-Forwarded-For: the forwarded address wasn't limited, its own was.
    expect(f.d.limiter.wait(["unlock:203.0.113.9"])).toBe(0);

    // A restart keeps the certificate while the addresses are the same.
    await f.stop();
    const again = await fresh({ home: f.home, web: { addresses: () => [{ address: "127.0.0.1", kind: "lan", interface: "eth0" }], directPort: f.directPort } });
    expect(JSON.parse(readFileSync(file, "utf8")).tls.cert).toBe(saved.tls.cert);
    expect(await getTls(f.directPort, "/api/state", saved.tls.cert)).toBe(200);

    // Off closes it and its file goes.
    await browser(again.base).post("/api/unlock", { passphrase: "passphrase" });
    const li2 = await login(again.base, "ada", "pw");
    expect((await li2.put(`/api/u/${id}/admin/web-access`, { mode: "off" })).status).toBe(200);
    expect(existsSync(file)).toBe(false);
    // Off has no front door beyond 443 on this machine: no name to resolve, so sandboxes keep their network.
    expect(again.d.services!.web.frontDoor()).toEqual({ ports: [443], hosts: [], exclude: [] });
    expect(typeof await getTls(f.directPort, "/api/state", saved.tls.cert)).toBe("string");
  });

  it("listens on every address it finds, with one certificate naming them all", async () => {
    const two = [{ address: "127.0.0.1", kind: "lan" as const, interface: "eth0" }, { address: "127.0.0.2", kind: "tailscale" as const, interface: "tailscale0" }];
    const directPort = await freePort();
    const f = await fresh({ web: { addresses: () => two, directPort } });
    const saved = JSON.parse(readFileSync(join(f.home, "web-external.json"), "utf8"));
    expect(saved.addresses).toEqual(["127.0.0.1", "127.0.0.2"]);
    for (const host of ["127.0.0.1", "127.0.0.2"]) {
      const status = await new Promise<number | string>((resolve) => {
        const req = httpsRequest({ host, port: directPort, path: "/api/state", ca: saved.tls.cert, agent: false }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode ?? 0)); });
        req.on("error", (err) => resolve(err.message));
        req.end();
      });
      expect(status).toBe(200);
    }
  });

  it("leaves web access that was set before alone", async () => {
    const home = tmp("lyricad-setup-");
    const ext = { address: "127.0.0.1", port: await freePort(), proxies: ["192.0.2.1"], proxyPort: 443 };
    writeFileSync(join(home, "web-external.json"), JSON.stringify(ext), { mode: 0o600 });
    await fresh({ home });
    expect(JSON.parse(readFileSync(join(home, "web-external.json"), "utf8"))).toEqual(ext);
  });
});

describe("the tailnet", () => {
  async function joined() {
    const f = await fresh();
    const setup = await browser(f.base).post<LoginResponse>("/api/setup", { code: f.code, passphrase: "passphrase", admin: ADMIN });
    const ada = await login(f.base, "ada", "pw");
    return { ...f, ada, url: `/api/u/${setup.body.user.id}/admin/tailnet`, web: `/api/u/${setup.body.user.id}/admin/web-access` };
  }

  it("joins with a key that is spent from a 0600 file, gone after, and never logged or sent back", async () => {
    const { ada, url, ts, home, logs } = await joined();
    expect((await ada.get<Tailnet>(url)).body).toEqual({ state: "notJoined", version: "1.90.1", hostname: "lyrica-host" });

    ts.failLogin(true);
    const failed = await ada.put<{ error: string }>(url, { authKey: KEY });
    expect(failed.status).toBe(400);
    expect(failed.body.error).not.toContain(KEY);
    expect(failed.body.error).toContain("[hidden]");
    expect(readdirSync(home).filter((n) => n.startsWith("tailnet-key"))).toEqual([]);

    ts.failLogin(false);
    const ok = await ada.put<Tailnet>(url, { authKey: KEY });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: "connected", tailnet: "example.ts.net", address: "100.101.102.103", dnsName: "lyrica.example.ts.net", hostname: "lyrica-host" });
    expect(readdirSync(home).filter((n) => n.startsWith("tailnet-key"))).toEqual([]);

    const logins = ts.calls().filter((c) => c.args[2] === "login");
    expect(logins).toHaveLength(2);
    for (const c of logins) expect(c).toMatchObject({ keyFileMode: "600", keyFileHoldsKey: true });
    // No hostname given: no `set`.
    expect(ts.calls().some((c) => c.args[2] === "set")).toBe(false);
    for (const c of ts.calls()) expect(c.args.slice(0, 2)).toEqual(["--socket", join(home, "tailscaled.sock")]);
    expect(JSON.stringify(ts.calls())).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("is 409 when joined elsewhere unless it leaves first, and sets the hostname only when given", async () => {
    const { ada, url, ts } = await joined();
    await ada.put(url, { authKey: KEY });
    expect((await ada.put(url, { authKey: KEY })).status).toBe(409);
    const n = ts.calls().length;
    const again = await ada.put<Tailnet>(url, { authKey: KEY, leave: true, hostname: "aria", controlServer: "https://hs.example.net" });
    expect(again.status).toBe(200);
    expect(ts.calls().slice(n).map((c) => c.args.slice(2))).toEqual([
      ["status", "--json", "--peers=false"],
      ["logout"],
      expect.arrayContaining(["login", "--login-server=https://hs.example.net"]),
      ["status", "--json", "--peers=false"],
      ["set", "--hostname=aria"],
      ["status", "--json", "--peers=false"],
    ]);
    expect(again.body.hostname).toBe("aria");
    expect((await ada.put(url, { authKey: KEY, leave: true, hostname: "no spaces" })).status).toBe(400);
  });

  it("refuses to disconnect, leave or switch over her own tailnet address", async () => {
    const { d, ada, url } = await joined();
    await ada.put(url, { authKey: KEY });
    // Through `tailscale serve`: its own loopback port, with the browser's cookie.
    const viaTailnet = browser(`http://127.0.0.1:${d.servePort}`);
    viaTailnet.cookie = ada.cookie;
    expect((await viaTailnet.post(`${url}/disconnect`)).status).toBe(409);
    expect((await viaTailnet.del(url)).status).toBe(409);
    expect((await viaTailnet.put(url, { authKey: KEY, leave: true })).status).toBe(409);
    expect((await viaTailnet.get<Tailnet>(url)).body.state).toBe("connected");
    // Over the LAN (or on the machine), they work.
    expect((await ada.post<Tailnet>(`${url}/disconnect`)).body.state).toBe("disconnected");
    expect((await ada.post<Tailnet>(`${url}/connect`)).body.state).toBe("connected");
  });

  it("serves the Tailnet web mode through tailscale serve, adds her Tailscale address to the front door, and leaving turns it off", async () => {
    const { d, ada, url, web, ts } = await joined();
    await ada.put(url, { authKey: KEY });
    const on = await ada.put<WebAccess>(web, { mode: "tailnet" });
    expect(on.status).toBe(200);
    expect(on.body.mode).toBe("tailnet");
    expect(on.body.tailnet).toEqual({ dnsName: "lyrica.example.ts.net", certificates: false });
    expect(ts.calls().some((c) => c.args.slice(2).join(" ") === `serve --bg --https=443 http://127.0.0.1:${d.servePort}`)).toBe(true);
    // This machine couldn't check the name, so Direct stays on beside it.
    expect(on.body.direct).not.toBeNull();
    // Her Tailscale address stands for the MagicDNS name, which this machine's resolver may not know.
    expect(d.services!.web.frontDoor()).toEqual({ ports: [443, on.body.direct!.port], hosts: ["100.101.102.103"], exclude: [] });

    expect((await ada.del<Tailnet>(url)).body.state).toBe("notJoined");
    expect((await ada.get<WebAccess>(web)).body.mode).toBe("direct");
    // Out of Tailnet mode, her address is no longer a front door: sandboxes see only Direct's port on this machine.
    expect(d.services!.web.frontDoor()).toEqual({ ports: [443, on.body.direct!.port], hosts: [], exclude: [] });
    const tail = ts.calls().map((c) => c.args.slice(2).join(" "));
    expect(tail.indexOf("serve reset")).toBeGreaterThan(-1);
    expect(tail.indexOf("serve reset")).toBeLessThan(tail.lastIndexOf("logout"));

    // Never anything off the list.
    for (const c of ts.calls()) {
      expect(c.args.join(" ")).not.toMatch(/funnel|--ssh|--advertise-routes|--advertise-exit-node|--exit-node|--reset/);
    }
  });

  /** A plain request to a loopback port with its own headers (fetch won't send a Host of our choosing). */
  function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  it("sends a plain-HTTP request at her tailnet address to the HTTPS front door, and believes a proxy's forwarded host for the origin check", async () => {
    const { d, ada, url, web } = await joined();
    await ada.put(url, { authKey: KEY });
    const login = JSON.stringify({ login: "ada", password: "pw" });
    // Her userspace tailscaled hands <her address>:7340 and :7342 to the same loopback ports: Direct is on, but not at that address.
    const dir = (await ada.get<WebAccess>(web)).body.direct!;
    let r = await raw(d.port, "GET", "/", { host: "100.101.102.103:7340" });
    expect(r.status).toBe(403);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.text).toContain("Turn on Tailnet or Direct in Administration");
    r = await raw(d.servePort, "POST", "/api/login", { host: "lyrica.example.ts.net:7342", origin: "http://lyrica.example.ts.net:7342" }, login);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error).toMatch(/plain HTTP, so you can't log in here/);
    // This machine's own loopback name is fine, whatever the port.
    r = await raw(d.port, "GET", "/api/state", { host: `${dir.addresses[0]}:${d.port}` });
    expect(r.status).toBe(200);
    // With Tailnet on, the request is sent to her name.
    expect((await ada.put<WebAccess>(web, { mode: "tailnet" })).status).toBe(200);
    r = await raw(d.servePort, "GET", "/settings?x=1", { host: "lyrica.example.ts.net:7342" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("https://lyrica.example.ts.net/settings?x=1");
    r = await raw(d.port, "GET", "/", { host: "100.101.102.103:7340" });
    expect(r.headers.location).toBe("https://lyrica.example.ts.net/");
    r = await raw(d.servePort, "POST", "/api/login", { host: "100.101.102.103:7342", origin: "http://100.101.102.103:7342" }, login);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error).toContain("Use https://lyrica.example.ts.net/ instead.");
    // Through tailscale serve: X-Forwarded-Proto https, and the browser's host in X-Forwarded-Host when Host was rewritten.
    r = await raw(d.servePort, "GET", "/api/state", { host: "lyrica.example.ts.net", "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.9" });
    expect(r.status).toBe(200);
    r = await raw(d.servePort, "POST", "/api/login", { host: `127.0.0.1:${d.servePort}`, "x-forwarded-proto": "https", "x-forwarded-host": "lyrica.example.ts.net", origin: "https://lyrica.example.ts.net" }, login);
    expect(r.status).toBe(200);
    r = await raw(d.servePort, "POST", "/api/login", { host: `127.0.0.1:${d.servePort}`, "x-forwarded-proto": "https", origin: "https://lyrica.example.ts.net" }, login);
    expect(r.status).toBe(200); // a proxy that sends neither: the Tailnet mode's own name is allowed
    r = await raw(d.servePort, "POST", "/api/login", { host: `127.0.0.1:${d.servePort}`, "x-forwarded-proto": "https", "x-forwarded-host": "lyrica.example.ts.net", origin: "https://evil.example" }, login);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error).toBe("cross-origin requests are refused");
  });

  it("names MagicDNS or HTTPS certificates when the tailnet has them off", async () => {
    const { ada, url, web, ts } = await joined();
    await ada.put(url, { authKey: KEY });
    const statusFile = join(ts.bin, "..", "status.json");
    const s = JSON.parse(readFileSync(statusFile, "utf8"));
    writeFileSync(statusFile, JSON.stringify({ ...s, CertDomains: null }));
    const r = await ada.put<{ error: string }>(web, { mode: "tailnet" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/HTTPS certificates are off/);
    expect((await ada.get<WebAccess>(web)).body.mode).toBe("direct");
  });

  it("says when her tailscaled isn't installed", async () => {
    const f = await fresh({ tailnet: { binary: "/nonexistent/tailscale" } });
    const setup = await browser(f.base).post<LoginResponse>("/api/setup", { code: f.code, passphrase: "passphrase", admin: ADMIN });
    const ada = await login(f.base, "ada", "pw");
    expect((await ada.get<Tailnet>(`/api/u/${setup.body.user.id}/admin/tailnet`)).body).toEqual({ state: "notInstalled", reason: "the tailscale command isn't installed" });
  });
});
