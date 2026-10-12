import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keyring, SCHEMA } from "@lyrica/core";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { Drain, Health, ThreadSummary, Updates } from "../src/api.ts";
import { smokeTest } from "../src/smoke.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

function sock<T>(path: string, method: string, url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: path, method, path: url }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(JSON.parse(body) as T));
    });
    req.on("error", reject);
    req.end();
  });
}

async function setup() {
  const rt = await runtime();
  const state = mkdtempSync(join(tmpdir(), "lyrica-update-state-"));
  const dm = await daemon(rt, { update: { socket: join(rt.home, "update.sock"), state } });
  return { rt, state, socket: join(rt.home, "update.sock"), ...dm };
}

describe("the update socket", () => {
  it("is owner-only, reports health once unlocked with check names only, and drains new sends with 409 updating", async () => {
    const { rt, socket, base } = await setup();
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(await sock<Health>(socket, "GET", "/health")).toMatchObject({ locked: true, checks: [] });
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const health = await sock<Health>(socket, "GET", "/health");
    expect(health.locked).toBe(false);
    expect(health.checks.map((c) => c.name)).toEqual(["databases", "workspace", "models", "web"]);
    // The test runtime has no built web UI.
    expect(health.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["web"]);

    const ada = await login(base, "ada", "pw");
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "a turn" })).body;
    const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    model.reply({ text: "A slow answer that takes a while.", slowMs: 1500 });
    await ada.post(`${path}/messages`, { text: "something slow" });

    // A drain while the turn runs: it waits for that thread, and new sends are refused.
    const busy = await sock<Drain>(socket, "POST", "/drain");
    expect(busy.busy).toEqual([{ kind: "turn", userId: rt.ada.id, pool: "general", threadId: thread.id }]);
    const refused = await ada.post(`${path}/messages`, { text: "one more" });
    expect(refused).toMatchObject({ status: 409, body: { updating: true } });
    expect((await ada.post(`/api/u/${rt.ada.id}/sleep/general`, {})).status).toBe(409);
    await stream.until((e) => e.type === "turn_end", 0, 20_000);
    expect((await sock<Drain>(socket, "POST", "/drain")).busy).toEqual([]);

    // Giving up: undrain, and sends go through again.
    await sock(socket, "POST", "/undrain");
    model.reply({ text: "Back." });
    expect((await ada.post(`${path}/messages`, { text: "after" })).status).toBe(200);
    stream.close();
  });

  it("fails its databases check when self.db is newer than this release, never only staying locked", async () => {
    const rt = await runtime();
    const keyring = new Keyring(rt.home, { memoryCost: 1024, timeCost: 1, parallelism: 1 });
    await keyring.unlockSelf("passphrase");
    keyring.self().prepare("UPDATE meta SET value = ? WHERE key = 'min_reader'").run(String(SCHEMA.self + 1));
    keyring.self().close();
    const { base, d } = await daemon(rt, { update: { socket: join(rt.home, "update.sock") } });
    expect((await browser(base).post("/api/unlock", { passphrase: "passphrase" })).status).toBe(409);
    const health = await sock<Health>(join(rt.home, "update.sock"), "GET", "/health");
    expect(health).toMatchObject({ locked: true, checks: [{ name: "databases", ok: false, error: expect.stringContaining("SchemaTooNew") }] });
    expect(d.locked).toBe(true);
  });
});

describe("Administration's updates API", () => {
  it("shows kept releases, what a rollback would restore, and writes requests only lyricad writes", async () => {
    const { rt, state, base } = await setup();
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const u = `/api/u/${rt.ada.id}/admin/updates`;
    expect((await sam.get(`/api/u/${rt.sam.id}/admin/updates`)).status).toBe(403);
    expect((await ada.get<Updates>(u)).body).toMatchObject({ available: false, releases: [], note: null, state: { state: "idle" } });

    const one = { self: 1, user: 1, pool: 1 };
    writeFileSync(join(state, "releases.json"), JSON.stringify({
      current: "ccccccc", previous: "bbbbbbb",
      releases: [
        { commit: "aaaaaaa", builtAt: "2026-10-01T00:00:00Z", schema: one, minReader: one },
        { commit: "bbbbbbb", builtAt: "2026-10-05T00:00:00Z", schema: { ...one, pool: 2 }, minReader: one },
        { commit: "ccccccc", builtAt: "2026-10-09T00:00:00Z", tag: "update/2026-10-09", schema: { ...one, pool: 3 }, minReader: { ...one, pool: 3 } },
      ],
      // ccc contracted the pool schema: bbb and aaa can read again only with the snapshot from before it.
      minReader: { ...one, pool: 3 },
      snapshots: [{ dir: "x", at: "2026-10-09T14:02:00Z", commit: "bbbbbbb", minReader: one }],
    }));
    mkdirSync(join(state, "notes"));
    writeFileSync(join(state, "notes", "ccccccc.txt"), `\n${"Releases and rollback ".repeat(6)}\n\nMerged PRs…`);
    writeFileSync(join(state, "state.json"), JSON.stringify({
      state: "idle", since: "2026-10-09T14:12:00Z", note: { tag: "update/2026-10-12", commit: "ddddddd", message: "Releases and rollback" },
    }));
    const got = (await ada.get<Updates>(u)).body;
    expect(got.available).toBe(true);
    expect(got.note).toEqual({ tag: "update/2026-10-12", commit: "ddddddd", message: "Releases and rollback" });
    expect(got.releases.map((r) => [r.commit, r.running, r.previous, r.rollback])).toEqual([
      ["ccccccc", true, false, { possible: true }],
      ["bbbbbbb", false, true, { possible: true, restores: "2026-10-09T14:02:00Z" }],
      ["aaaaaaa", false, false, { possible: true, restores: "2026-10-09T14:02:00Z" }],
    ]);

    expect(got.releases.map((r) => r.summary)).toEqual(["Releases and rollback ".repeat(6).trim(), undefined, undefined]);

    expect((await ada.post(u, { tag: "main" })).status).toBe(400);
    expect((await ada.post(u, { tag: "update/2026-10-12" })).status).toBe(200);
    const request = join(rt.home, "updates", "request.json");
    expect(JSON.parse(readFileSync(request, "utf8"))).toEqual({ action: "update", tag: "update/2026-10-12" });
    expect(statSync(request).mode & 0o777).toBe(0o600);
    expect((await ada.post(`${u}/rollback`, { commit: "bbbbbbb" })).status).toBe(409);
    rmSync(request);
    // While an update runs, only a rollback during probation is taken.
    writeFileSync(join(state, "state.json"), JSON.stringify({ state: "building", since: "2026-10-12T00:00:00Z" }));
    expect((await ada.post(u, { tag: "update/2026-10-12" })).status).toBe(409);
    expect(existsSync(request)).toBe(false);
    writeFileSync(join(state, "state.json"), JSON.stringify({ state: "probation", since: "2026-10-12T00:00:00Z" }));
    expect((await ada.post(`${u}/rollback`, { commit: "bbbbbbb" })).status).toBe(200);
    expect(JSON.parse(readFileSync(request, "utf8"))).toEqual({ action: "rollback", commit: "bbbbbbb" });
  });
});

describe("the smoke test", () => {
  it("starts a release in an empty scratch home with test data, unlocks, logs in and reads its health", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "lyrica-smoke-")), "scratch");
    const web = mkdtempSync(join(tmpdir(), "lyrica-web-"));
    writeFileSync(join(web, "index.html"), "<!doctype html><html><body></body></html>");
    const results = await smokeTest(dir, { selfTest: false, webDir: web });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(["start", "unlock", "login", "health databases", "health workspace", "health models", "health web", "web index"]);
    mkdirSync(join(web, "x"));
    await expect(smokeTest(web)).rejects.toThrow("not empty");
    rmSync(dir, { recursive: true, force: true });
    rmSync(web, { recursive: true, force: true });
  });
});
