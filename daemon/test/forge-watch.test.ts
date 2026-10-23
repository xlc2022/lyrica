// CI wakes (docs/briefs/ci-wakes.md part B): the poller and the tailnet
// webhook. Each forge is a local fake that answers recorded fixtures (no
// network, no real data); the watch store, wake-ups and child guards are real
// encrypted stores with a stub turn host, as in routines.test.ts.

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { inOwnNetwork, Memory, Models, Users, WAKEUP_LIMITS, Workspace, type ForgeKind, type Pool, type PoolStore } from "@lyrica/core";
import type { Delegation } from "@lyrica/extension";
import { freshKeyring, profile } from "../../core/test/helpers.ts";
import { ChildThreads } from "../src/children.ts";
import { ForgeWatcher } from "../src/forge-watch.ts";
import type { ThreadHost } from "../src/hosted.ts";
import { Wakeups } from "../src/wakeups.ts";
import { browser, daemon, login, runtime } from "./helpers.ts";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const START = Date.parse("2026-01-01T00:00:00Z");
const at = (minutes: number) => new Date(START + minutes * 60_000);
const FORGEJO_PREFIX = "/api/v1";
const GITHUB_PREFIX = "/api/v3";

/** One forged answer, keyed by method and pathname (the query string is ignored, so paging stops on a short page). */
type FakeReply = { status: number; body?: unknown; headers?: Record<string, string> };
type FakeRoute = FakeReply | ((req: { url: URL; headers: Record<string, string> }) => FakeReply);

class FakeForge {
  readonly asked: { method: string; path: string; headers: Record<string, string> }[] = [];
  private routes = new Map<string, FakeRoute>();
  route(method: string, path: string, reply: FakeRoute): void { this.routes.set(`${method} ${path}`, reply); }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = { ...(init?.headers as Record<string, string> | undefined ?? {}) };
    this.asked.push({ method, path: url.pathname, headers });
    const reply = this.routes.get(`${method} ${url.pathname}`);
    if (!reply) return new Response("{}", { status: 404 });
    const out = typeof reply === "function" ? reply({ url, headers }) : reply;
    return new Response(out.body === undefined ? undefined : JSON.stringify(out.body), { status: out.status, headers: out.headers });
  };
}

/** Ticks a watcher and waits for its poll round to finish. */
async function pump(forge: ForgeWatcher, when: Date): Promise<void> {
  forge.tick(when);
  await expect.poll(() => (forge as unknown as { running: boolean }).running, { interval: 5, timeout: 5000 }).toBe(false);
}

/** A forgejo/gitea pull body with a made-up head. */
const pullBody = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ number: 12, state: "open", merged: false, merged_at: null, head: { sha: HEAD_A }, ...over });
/** A forgejo combined status: `success` when a status list is given, otherwise unknown ("") — never thrown over. */
const statusBody = (statuses: unknown[]): Record<string, unknown> => ({ state: statuses.length ? "success" : "", statuses });
const finishedChecks = () => [{ id: 1, context: "build", status: "success" }, { id: 2, context: "e2e", status: "failure" }];
const runningChecks = () => [{ id: 1, context: "build", status: "success" }, { id: 2, context: "e2e", status: "pending" }];

const forgejoPaths = (prefix: string, sha = HEAD_A) => ({
  pull: `${prefix}/repos/ada/lyrica/pulls/12`,
  status: `${prefix}/repos/ada/lyrica/commits/${sha}/status`,
  reviews: `${prefix}/repos/ada/lyrica/pulls/12/reviews`,
  comments: `${prefix}/repos/ada/lyrica/issues/12/comments`,
});

/** Routes the four forgejo/gitea endpoints for one watch's poll. */
function routeForgejo(fake: FakeForge, over: { pull?: unknown; status?: unknown; reviews?: unknown; comments?: unknown } = {}, sha = HEAD_A): void {
  const p = forgejoPaths(FORGEJO_PREFIX, sha);
  fake.route("GET", p.pull, { status: 200, body: over.pull ?? pullBody() });
  fake.route("GET", p.status, { status: 200, body: over.status ?? statusBody([]) });
  fake.route("GET", p.reviews, { status: 200, body: over.reviews ?? [] });
  fake.route("GET", p.comments, { status: 200, body: over.comments ?? [] });
}

const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });

/** Real encrypted stores and child guards with an in-memory turn host, and a fake forge. */
async function setupForge(kind: ForgeKind = "forgejo", opts: { project?: boolean } = {}) {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const user = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const memory = new Memory(keyring, users);
  const models = new Models(keyring, users);
  const fake = new FakeForge();
  const workspace = new Workspace(keyring, users, { excludePorts: [], forgeFetch: fake.fetch });
  close.push(() => workspace.settings(user.id).close());
  const settings = workspace.settings(user.id);
  const host = "127.0.0.1";
  const accountName = kind === "github" ? "gh" : "forge";
  settings.addGitAccount({ name: accountName, kind, host, account: "lyrica-bot", token: "made-up-token", pool: "general", offNetwork: false });

  const own = <T>(fn: (s: PoolStore) => T) => { const v = memory.openThreadView(user.id, "general"); try { return fn(v.own); } finally { v.close(); } };
  const project = opts.project ? own(s => s.createThread({ interface: "web", title: "Build", project: true })) : undefined;
  const thread = project
    ? (() => {
      const child = own(s => s.createThread({ interface: "web", parent: project.id, child: true, title: "Checks" }));
      const db = users.openUserDb(user.id);
      try { db.prepare("INSERT INTO child_threads (pool, thread, parent, started_at, queued) VALUES ('general', ?, ?, ?, 0)").run(child.id, project.id, new Date().toISOString()); } finally { db.close(); }
      return child;
    })()
    : own(s => s.createThread({ interface: "web", title: "Checks" }));
  settings.setThread(thread.id, "general", { repositories: [{ name: "ada/lyrica", account: accountName }] });

  const busy = new Set<string>();
  const sent: { thread: string; text: string; opts: { wakeup?: string } }[] = [];
  const hostStub = {
    busy: (_user: string, _pool: Pool, id: string) => busy.has(id),
    get: (_user: string, _pool: Pool, id: string) => ({ send: async (text: string, opts: { wakeup?: string }) => { busy.add(id); sent.push({ thread: id, text, opts }); } }),
    peek: () => undefined,
    changed: () => {},
  } as unknown as ThreadHost;
  let paused = false;
  const children = new ChildThreads({ users, memory, models, workspace, delegation: {} as Delegation, host: () => hostStub, paused: () => paused, limits: { concurrency: 2 } });
  const logs: string[] = [];
  const wakeups = new Wakeups({ memory, host: () => hostStub, children, log: (line) => logs.push(line) });
  const forge = new ForgeWatcher({ memory, workspace, wakeups, log: (line) => logs.push(line) });
  forge.load(user.id);

  const watch = (number = 12) => own(s => s.addWatch(thread.id, { repo: "ada/lyrica", kind, host, account: accountName, number }));
  return { keyring, user, users, memory, workspace, settings, fake, sent, busy, wakeups, forge, own, thread, project, accountName, host,
    watch,
    watches: () => own(s => s.watches()),
    wakeupsOf: () => own(s => s.wakeups(thread.id)),
    tick: (minutes: number) => pump(forge, at(minutes)),
    pause: (value: boolean) => { paused = value; },
    logs };
}

describe("the forge watcher", () => {
  it("supplies cached open PR checks to code turns without fetching, and clears on close or Lock", async () => {
    const s = await setupForge();
    routeForgejo(s.fake, { status: statusBody(runningChecks()) });
    s.watch();
    await s.tick(0);
    const calls = s.fake.asked.length;
    expect(s.forge.codePulls(s.user.id, "general", s.thread.id)).toEqual(["ada/lyrica PR #12: build: passed, e2e: pending"]);
    expect(s.fake.asked).toHaveLength(calls);
    expect(s.forge.codePulls(s.user.id, "private", s.thread.id)).toEqual([]);
    routeForgejo(s.fake, { pull: pullBody({ state: "closed" }) });
    await s.tick(2);
    expect(s.forge.codePulls(s.user.id, "general", s.thread.id)).toEqual([]);
    routeForgejo(s.fake, { status: statusBody(runningChecks()) });
    s.watch();
    await s.tick(4);
    expect(s.forge.codePulls(s.user.id, "general", s.thread.id)).toHaveLength(1);
    s.forge.drop(s.user.id);
    expect(s.forge.codePulls(s.user.id, "general", s.thread.id)).toEqual([]);
  });

  it("wakes once when the checks finish, not again for the same head, and waits again on a new head", async () => {
    const s = await setupForge();
    routeForgejo(s.fake, { status: statusBody(finishedChecks()) });
    s.watch();
    await s.tick(0);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.text).toBe("PR #12 (aaaaaaa): checks finished — build: passed, e2e: failed.");
    expect(typeof s.sent[0]!.opts.wakeup).toBe("string");

    // The same finished head re-polled: nothing new.
    await s.tick(2);
    expect(s.sent).toHaveLength(1);

    // A new head whose checks still run waits again.
    routeForgejo(s.fake, { pull: pullBody({ head: { sha: HEAD_B } }), status: statusBody(runningChecks()) }, HEAD_B);
    await s.tick(4);
    expect(s.sent).toHaveLength(1);

    routeForgejo(s.fake, { pull: pullBody({ head: { sha: HEAD_B } }), status: statusBody(finishedChecks()) }, HEAD_B);
    await s.tick(6);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.text).toBe("PR #12 (bbbbbbb): checks finished — build: passed, e2e: failed.");
  });

  it("still running gives no turn; a review from another account gives one, and her own gives none", async () => {
    const s = await setupForge();
    routeForgejo(s.fake, { status: statusBody(runningChecks()) });
    s.watch();
    await s.tick(0);
    expect(s.sent).toHaveLength(0); // a check still pending: wait

    routeForgejo(s.fake, { status: statusBody(finishedChecks()), reviews: [{ id: 1, reviewer: { login: "lyrica-bot" }, state: "APPROVED", submitted_at: "2026-01-01T00:01:00Z" }] });
    await s.tick(2);
    expect(s.sent).toHaveLength(1); // the checks finished; her own review adds nothing

    routeForgejo(s.fake, { status: statusBody(finishedChecks()), reviews: [
      { id: 1, reviewer: { login: "lyrica-bot" }, state: "APPROVED", submitted_at: "2026-01-01T00:01:00Z" },
      { id: 2, reviewer: { login: "sam" }, state: "APPROVED", submitted_at: "2026-01-01T00:03:00Z" },
    ] });
    await s.tick(4);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.text).toBe("PR #12 (aaaaaaa): sam approved.");
  });

  it("shares one wake between a finished check and a new review in the same poll", async () => {
    const s = await setupForge();
    routeForgejo(s.fake, { status: statusBody(finishedChecks()), reviews: [{ id: 1, reviewer: { login: "sam" }, state: "APPROVED", submitted_at: "2026-01-01T00:01:00Z" }] });
    s.watch();
    await s.tick(0);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.text).toBe("PR #12 (aaaaaaa): checks finished — build: passed, e2e: failed; sam approved.");
  });

  it("polls the five GitHub endpoints and caches unchanged answers by ETag", async () => {
    const s = await setupForge("github");
    const p = forgejoPaths(GITHUB_PREFIX);
    const head = HEAD_A;
    s.fake.route("GET", p.pull, (req) => req.headers["If-None-Match"] === "abc"
      ? { status: 304 }
      : { status: 200, body: pullBody(), headers: { etag: "abc" } });
    s.fake.route("GET", `${GITHUB_PREFIX}/repos/ada/lyrica/commits/${head}/check-runs`, { status: 200, body: { check_runs: [
      { id: 11, name: "build", status: "completed", conclusion: "success" },
      { id: 12, name: "e2e", status: "completed", conclusion: "failure" },
    ] } });
    s.fake.route("GET", `${GITHUB_PREFIX}/repos/ada/lyrica/commits/${head}/status`, { status: 200, body: { state: "success", statuses: [] } });
    s.fake.route("GET", `${GITHUB_PREFIX}/repos/ada/lyrica/pulls/12/reviews`, { status: 200, body: [] });
    s.fake.route("GET", `${GITHUB_PREFIX}/repos/ada/lyrica/pulls/12/comments`, { status: 200, body: [] });
    s.fake.route("GET", `${GITHUB_PREFIX}/repos/ada/lyrica/issues/12/comments`, { status: 200, body: [] });
    s.watch();
    await s.tick(0);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.text).toBe("PR #12 (aaaaaaa): checks finished — build: passed, e2e: failed.");
    expect(s.fake.asked.map((a) => a.path)).toEqual(expect.arrayContaining([
      `${GITHUB_PREFIX}/repos/ada/lyrica/pulls/12`,
      `${GITHUB_PREFIX}/repos/ada/lyrica/commits/${head}/check-runs`,
      `${GITHUB_PREFIX}/repos/ada/lyrica/commits/${head}/status`,
      `${GITHUB_PREFIX}/repos/ada/lyrica/pulls/12/reviews`,
      `${GITHUB_PREFIX}/repos/ada/lyrica/pulls/12/comments`,
      `${GITHUB_PREFIX}/repos/ada/lyrica/issues/12/comments`,
    ]));
    // The second poll asks with the remembered ETag; an unchanged answer costs no note and no extra rate limit.
    await s.tick(2);
    expect(s.sent).toHaveLength(1);
    expect(s.fake.asked.filter((a) => a.path === p.pull)[1]!.headers["If-None-Match"]).toBe("abc");
  });

  it("honours Retry-After: a 429 pauses that token's next request", async () => {
    const s = await setupForge();
    const p = forgejoPaths(FORGEJO_PREFIX);
    s.fake.route("GET", p.pull, { status: 429, body: {}, headers: { "retry-after": "120" } });
    s.watch();
    await pump(s.forge, new Date());
    expect(s.fake.asked).toHaveLength(1);
    await pump(s.forge, new Date());
    expect(s.fake.asked).toHaveLength(1); // Retry-After holds the next request
  });

  it("pauses a token whose remaining requests hit zero until its reset", async () => {
    const s = await setupForge();
    const p = forgejoPaths(FORGEJO_PREFIX);
    const reset = Math.floor(Date.now() / 1000) + 300;
    s.fake.route("GET", p.pull, { status: 200, body: pullBody(), headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "100", "x-ratelimit-reset": String(reset) } });
    s.watch();
    await pump(s.forge, new Date());
    expect(s.fake.asked).toHaveLength(1); // the pull, then the reset stops the rest
    await pump(s.forge, new Date());
    expect(s.fake.asked).toHaveLength(1);
  });

  it("slows to ten minutes once fewer than a fifth of a token's requests remain", async () => {
    const s = await setupForge();
    const p = forgejoPaths(FORGEJO_PREFIX);
    s.fake.route("GET", p.pull, { status: 200, body: pullBody(), headers: { "x-ratelimit-remaining": "3", "x-ratelimit-limit": "100" } });
    s.fake.route("GET", p.status, { status: 200, body: statusBody([]) });
    s.fake.route("GET", p.reviews, { status: 200, body: [] });
    s.fake.route("GET", p.comments, { status: 200, body: [] });
    s.watch();
    await s.tick(0);
    expect(s.fake.asked).toHaveLength(4);
    await s.tick(1);
    await s.tick(9);
    expect(s.fake.asked).toHaveLength(4); // ten-minute polling, not two
    await s.tick(10);
    expect(s.fake.asked).toHaveLength(8);
  });

  it("a signed webhook polls that repository at once and eases it to ten minutes", async () => {
    const s = await setupForge();
    routeForgejo(s.fake, { status: statusBody(finishedChecks()) });
    s.watch();
    await s.forge.webhook(s.user.id, s.accountName, "ada/lyrica", at(0));
    expect(s.sent).toHaveLength(1);
    expect(s.watches()[0]!.webhookAt).toBe(at(0).toISOString());
    const asked = s.fake.asked.length;
    await s.tick(1);
    expect(s.fake.asked).toHaveLength(asked); // within the ten-minute ease
  });

  it("ends the watch with one note when the pull is merged or closed, silently when she merged it, and with one note on a 403", async () => {
    const ends: [object, string | undefined][] = [
      [{ state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z", merged_by: { login: "sam" } }, `PR #12 (${HEAD_A.slice(0, 7)}): merged, so I've stopped watching.`],
      [{ state: "closed", merged: false, merged_at: null }, `PR #12 (${HEAD_A.slice(0, 7)}): closed without merging, so I've stopped watching.`],
      [{ state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z", merged_by: { login: "lyrica-bot" } }, undefined],
    ];
    for (const [over, text] of ends) {
      const s = await setupForge();
      routeForgejo(s.fake, { pull: pullBody(over) });
      s.watch();
      await s.tick(0);
      expect(s.sent.map((m) => m.text)).toEqual(text ? [text] : []);
      expect(s.watches()).toEqual([]);
    }

    const s = await setupForge();
    const p = forgejoPaths(FORGEJO_PREFIX);
    s.fake.route("GET", p.pull, { status: 403, body: { message: "forbidden" } });
    s.watch();
    await s.tick(0);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.text).toBe("PR #12: the account's token can't read the checks, so I've stopped watching.");
    expect(s.watches()).toEqual([]);
  });

  it("holds the wake while the project is paused, and fires it once the project resumes", async () => {
    const s = await setupForge("forgejo", { project: true });
    routeForgejo(s.fake, { status: statusBody(finishedChecks()) });
    s.watch();
    s.pause(true);
    await s.tick(0);
    expect(s.sent).toEqual([]);
    expect(s.wakeupsOf()).toHaveLength(1); // stored, waiting
    s.pause(false);
    s.wakeups.tick(at(0));
    await new Promise((r) => setImmediate(r));
    expect(s.sent).toHaveLength(1);
  });

  it("holds the wake when the shared daily cap is already spent", async () => {
    const s = await setupForge();
    s.own(o => {
      for (let n = 0; n < WAKEUP_LIMITS.perDay; n++) o.fireWakeup(o.addWakeup(s.thread.id, at(0).toISOString(), "", at(0).toISOString()), at(0).toISOString());
    });
    routeForgejo(s.fake, { status: statusBody(finishedChecks()) });
    s.watch();
    await s.tick(0);
    expect(s.sent).toEqual([]);
    expect(s.wakeupsOf()).toHaveLength(1);
  });

  it("keeps watches across a restart and doesn't poll them while their user is locked", async () => {
    const s = await setupForge();
    routeForgejo(s.fake, { status: statusBody(finishedChecks()) });
    s.watch();
    s.forge.drop(s.user.id); // Lock: their watches leave memory
    await s.tick(0);
    expect(s.fake.asked).toHaveLength(0);
    expect(s.watches()).toHaveLength(1); // the pool keeps them

    const restarted = new ForgeWatcher({ memory: s.memory, workspace: s.workspace, wakeups: s.wakeups, log: (line) => s.logs.push(line) });
    restarted.load(s.user.id);
    await pump(restarted, at(0));
    expect(s.sent).toHaveLength(1);
  });
});

describe("forgeHostPrivate", () => {
  it("offers the Webhook row for every private IPv4 range and not for a public address", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    for (const host of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "100.64.0.1"]) {
      expect(await workspace.forgeHostPrivate({ host }), host).toBe(true);
    }
    expect(await workspace.forgeHostPrivate({ host: "8.8.8.8" })).toBe(false);
  });

  it("treats loopback and the locally-assigned ULA half of fc00::/7 as her own network", () => {
    expect(inOwnNetwork("127.0.0.1")).toBe(true);
    expect(inOwnNetwork("fd00::1")).toBe(true); // fd00::/8, the assigned half of fc00::/7
    expect(inOwnNetwork("8.8.8.8")).toBe(false);
  });
});

describe("the tailnet webhook route", () => {
  it("answers only on the tailnet listener and only to a correctly signed request, and drops the body", async () => {
    const rt = await runtime();
    const dm = await daemon(rt);
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    await login(dm.base, "ada", "pw");
    const settings = dm.d.services!.workspace.settings(rt.ada.id);
    settings.addGitAccount({ name: "forge", kind: "forgejo", host: "127.0.0.1", account: "lyrica-bot", token: "made-up-token", pool: "general", offNetwork: false });
    const secret = settings.gitAccount("forge")!.webhookSecret!;
    const body = JSON.stringify({ repository: { full_name: "ada/never-logged-marker" } });
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    const post = (port: number, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}/hooks/forge/forge`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

    // On the loopback API listener the route does not exist.
    expect((await post(dm.d.port, { "x-forgejo-signature": sig })).status).toBe(404);
    // On the tailnet listener, a missing or wrong signature is refused and polls nothing.
    expect((await post(dm.d.servePort)).status).toBe(401);
    expect((await post(dm.d.servePort, { "x-forgejo-signature": "deadbeef" })).status).toBe(401);
    // Forgejo sends the bare hex, so the GitHub-style "sha256=" form is refused too.
    expect((await post(dm.d.servePort, { "x-forgejo-signature": `sha256=${sig}` })).status).toBe(401);
    // A correct bare-hex signature answers ok (no watches, so nothing else happens).
    const ok = await post(dm.d.servePort, { "x-forgejo-signature": sig });
    expect(ok.status).toBe(200);
    expect(JSON.parse(await ok.text())).toEqual({ ok: true });
    // The body is read for the repository name and then dropped, never logged.
    expect(dm.logs.join("\n")).not.toContain("never-logged-marker");
  });
});
