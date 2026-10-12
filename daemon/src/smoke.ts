import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { Keyring, PersonaStore, PRONOUN_PRESETS, Users, type CredentialStore } from "@lyrica/core";
import type { Health } from "./api.ts";
import { Lyricad } from "./lyricad.ts";

/** No saved credentials in a scratch home. */
const NONE: CredentialStore = { unavailable: () => "not in a smoke test", saved: () => false, load: () => undefined, save: async () => {}, remove: async () => {} };

function call(o: { port?: number; socketPath?: string; method: string; path: string; body?: unknown; cookie?: string }): Promise<{ status: number; body: string; cookie?: string }> {
  return new Promise((resolve, reject) => {
    const data = o.body === undefined ? undefined : JSON.stringify(o.body);
    const host = o.port ? `127.0.0.1:${o.port}` : "update";
    const req = request({
      ...(o.port ? { host: "127.0.0.1", port: o.port } : { socketPath: o.socketPath }), method: o.method, path: o.path, timeout: 30_000,
      headers: {
        host, ...(data ? { "content-type": "application/json", origin: `http://${host}` } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * The updater's smoke test of a release, before anything real is touched: in
 * an empty scratch home, with a random passphrase and a test user that never
 * leave this process, it starts lyricad on a spare port, unlocks it, logs in,
 * reads /health over the update socket, and loads the web UI's index.
 * Returns each check's name and whether it passed.
 */
export async function smokeTest(dir: string, opts: { port?: number; webDir?: string; selfTest?: boolean } = {}): Promise<{ name: string; ok: boolean; error?: string }[]> {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const passphrase = randomBytes(24).toString("base64url");
  const password = randomBytes(24).toString("base64url");
  const keyring = new Keyring(dir, { memoryCost: 1024, timeCost: 1, parallelism: 1 });
  await keyring.initSelf(passphrase);
  new PersonaStore(keyring.self()).importSeed(join(import.meta.dirname, "../../persona"));
  await new Users(keyring).createUser("smoke", password, { displayName: "Smoke test", pronouns: PRONOUN_PRESETS.they }, { admin: true });
  keyring.self().close();

  const socket = join(dir, "update.sock");
  const daemon = new Lyricad({
    home: dir, port: opts.port ?? 0, credentials: NONE, webDir: opts.webDir, selfTest: opts.selfTest,
    argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 }, web: { caddySocket: join(dir, "no-caddy.sock") },
    update: { socket, state: join(dir, "update-state"), requests: join(dir, "updates") }, log: () => {},
  });
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const check = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, error: (err as Error).message.split("\n")[0] }); }
  };
  try {
    await check("start", () => daemon.start());
    const port = daemon.port;
    await check("unlock", async () => {
      const r = await call({ port, method: "POST", path: "/api/unlock", body: { passphrase } });
      if (r.status !== 200) throw new Error(`unlock answered ${r.status}`);
    });
    let cookie: string | undefined;
    await check("login", async () => {
      const r = await call({ port, method: "POST", path: "/api/login", body: { login: "smoke", password } });
      if (r.status !== 200 || !r.cookie) throw new Error(`login answered ${r.status}`);
      cookie = r.cookie;
      const state = await call({ port, method: "GET", path: "/api/state", cookie });
      if (!(JSON.parse(state.body) as { users: unknown[] }).users.length) throw new Error("the session holds no user");
    });
    const health = await call({ socketPath: socket, method: "GET", path: "/health" }).then((r) => JSON.parse(r.body) as Health).catch((err: Error) => err);
    if (health instanceof Error) results.push({ name: "health", ok: false, error: health.message });
    else if (health.locked) results.push({ name: "health", ok: false, error: "still locked" });
    else for (const c of health.checks) results.push({ name: `health ${c.name}`, ok: c.ok, ...(c.error ? { error: c.error } : {}) });
    await check("web index", async () => {
      const r = await call({ port, method: "GET", path: "/" });
      if (r.status !== 200 || !r.body.includes("<html")) throw new Error(`the web UI's index answered ${r.status}`);
    });
  } finally {
    await daemon.stop();
  }
  return results;
}
