import { describe, expect, it } from "vitest";
import { addressesOutside, CloudModelForbidden, Forbidden, NoModel, baseName, type Db } from "../src/index.ts";
import { deadUrl, fakeOpenAI } from "./fake-openai.ts";
import { freshKeyring, profile, withModels } from "./helpers.ts";
import { Models, Users } from "../src/index.ts";

const UUID = /^[0-9a-f-]{36}$/;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const set = (db: Db, sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);

/** Li plus Bob (not an administrator), and a shared local endpoint "lan" serving qwen3.8-27b and a second copy "lan2". */
async function withShared() {
  const m = await withModels();
  const bob = await m.users.createUser("bob", "pw", profile("Bob"), { admin: false });
  await m.users.authenticate("bob", "pw");
  const lanModels = [{ id: "qwen3.8-27b" }, { id: "qwen3.8-flash" }];
  const lanServer = await fakeOpenAI({ models: lanModels });
  const lan = m.models.addEndpoint(m.li, { name: "lan", kind: "local", baseUrl: lanServer.baseUrl }, { shared: true });
  const lan2 = m.models.addEndpoint(m.li, { name: "lan2", kind: "local", baseUrl: (await fakeOpenAI({ models: [{ id: "Qwen3.8-27B-Q4_K_M.gguf" }] })).baseUrl }, { shared: true });
  const [qwen, flash] = await m.models.discover(m.li, lan.id);
  const [copy] = await m.models.discover(m.li, lan2.id);
  return { ...m, bob, lan, lan2, lanModels, qwen: { offeringId: qwen!.id }, flash: { offeringId: flash!.id }, copy: { offeringId: copy!.id } };
}

describe("endpoints", () => {
  it("gives endpoints and their models permanent IDs, with capabilities from discovery or by hand", async () => {
    const { models, li, gpu, openrouter } = await withModels();
    expect(openrouter.id).toMatch(UUID);
    expect(models.offerings(li.id, openrouter.id)).toEqual([
      { id: expect.stringMatching(UUID), endpointId: openrouter.id, modelId: "deepseek/deepseek-4.1-flash", contextWindow: 128000, tools: true, manual: false, status: "listed" },
    ]);
    const [qwen] = models.offerings(li.id, gpu.id);
    expect(qwen).toMatchObject({ modelId: "qwen3.8-27b", contextWindow: 32768, manual: false });
    const flash = models.addModel(li, gpu.id, { modelId: "qwen3.8-flash", contextWindow: 8192, tools: true });
    expect(models.setCapabilities(li, qwen!.id, { tools: true, vision: false })).toMatchObject({ tools: true, vision: false, contextWindow: 32768 });
    // Rediscovering keeps every ID, and hand-set capabilities win.
    await models.discover(li, gpu.id);
    expect(models.offerings(li.id, gpu.id).map((o) => [o.id, o.modelId, o.manual, o.tools])).toEqual([[qwen!.id, "qwen3.8-27b", false, true], [flash.id, "qwen3.8-flash", true, true]]);
    expect(models.label(li.id, qwen!.id)).toBe("gpu/qwen3.8-27b");
    expect(models.find(li.id, "gpu/qwen3.8-27b")).toEqual({ offeringId: qwen!.id });
  });

  it("keeps a model the endpoint stops listing, marked missing, and its ID when it comes back", async () => {
    const m = await withShared();
    m.lanModels.pop();
    await m.models.discover(m.li, m.lan.id);
    expect(m.models.offering(m.li.id, m.flash.offeringId)!.offering).toMatchObject({ status: "missing", missingSince: expect.any(String) });
    m.lanModels.push({ id: "qwen3.8-flash" });
    await m.models.discover(m.li, m.lan.id);
    expect(m.models.offering(m.li.id, m.flash.offeringId)!.offering.status).toBe("listed");
  });

  it("never changes IDs when an endpoint is renamed or moved", async () => {
    const { models, li, gpu, localRef, local } = await withModels();
    models.setProfile(li.id, "local", "chat", localRef);
    const moved = models.editEndpoint(li, gpu.id, { name: "blackwell", baseUrl: `${local.baseUrl}/`, apiKey: "k" });
    expect(moved).toMatchObject({ id: gpu.id, name: "blackwell", apiKey: "k" });
    expect(models.resolveModel("chat", { userId: li.id, pool: "private", localOnly: true })).toEqual(localRef);
    expect(models.label(li.id, localRef.offeringId)).toBe("blackwell/qwen3.8-27b");
    expect(models.editEndpoint(li, gpu.id, { apiKey: null }).apiKey).toBeUndefined();
  });

  it("probe reports up and down, and an endpoint down for 14 days is stale", async () => {
    const { models, li, gpu, keyring, users } = await withModels();
    expect(await models.probe(li.id, gpu.id)).toEqual({ state: "up" });
    const off = models.addEndpoint(li, { name: "off", kind: "local", baseUrl: await deadUrl() });
    expect(await models.probe(li.id, off.id)).toEqual({ state: "down" });
    expect(models.endpoint(li.id, off.id)).toMatchObject({ downSince: expect.any(String), stale: false });
    const db = users.openUserDb(li.id);
    set(db, "UPDATE endpoints SET down_since = ? WHERE id = ?", daysAgo(15), off.id);
    db.close();
    expect(models.endpoint(li.id, off.id)!.stale).toBe(true);
    void keyring;
  });

  it("marks a local endpoint over plain HTTP outside this machine and the tailnet as unencrypted", async () => {
    const { models, li } = await withModels();
    const add = (name: string, baseUrl: string, kind: "local" | "cloud" = "local") => models.addEndpoint(li, { name, kind, baseUrl }).unencrypted;
    expect(add("a", "http://127.0.0.1:1234/v1")).toBe(false);
    expect(add("b", "http://lyrica-blackwell.tail1234.ts.net:7236/v1")).toBe(false);
    expect(add("c", "http://100.101.102.103:8080/v1")).toBe(false);
    expect(add("d", "https://192.168.1.20/v1")).toBe(false);
    expect(add("e", "http://192.168.1.20:1234/v1")).toBe(true);
    expect(add("f", "http://gpu.lan:1234/v1")).toBe(true);
    expect(add("g", "http://203.0.113.7/v1", "cloud")).toBe(false);
  });

  it("warns when a local endpoint is outside Li's network, and only then", async () => {
    for (const url of ["http://localhost:1234/v1", "http://192.168.1.20:1234/v1", "http://10.1.2.3/v1", "http://172.20.0.5/v1",
      "http://100.101.102.103:8080/v1", "http://[fd7a:115c:a1e0::1]:8080/v1", "http://[::1]:8080/v1"]) {
      expect(await addressesOutside(url)).toEqual([]);
    }
    expect(await addressesOutside("http://8.8.8.8/v1")).toEqual(["8.8.8.8"]);
    expect(await addressesOutside("http://[2001:db8::1]/v1")).toEqual(["2001:db8::1"]);
    expect(await addressesOutside("http://172.32.0.1/v1")).toEqual(["172.32.0.1"]);

    const { models, li } = await withModels();
    const odd = models.addEndpoint(li, { name: "odd", kind: "local", baseUrl: "http://203.0.113.7:9/v1" });
    expect((await models.probe(li.id, odd.id)).warning).toContain("odd is declared local, but 203.0.113.7 resolves to 203.0.113.7");
    const router = models.addEndpoint(li, { name: "router", kind: "cloud", baseUrl: "http://203.0.113.7:9/v1" });
    expect((await models.probe(li.id, router.id)).warning).toBeUndefined();
  });

  it("shares administrator endpoints with every user, and only administrators change them", async () => {
    const { models, li, bob, lan, qwen, local } = await withShared();
    expect(models.endpoints(bob.id).map((e) => e.name)).toEqual(["lan", "lan2"]);
    expect(models.label(bob.id, qwen.offeringId)).toBe("shared.lan/qwen3.8-27b");
    models.setProfile(bob.id, "local", "chat", qwen);
    expect(models.resolveModel("chat", { userId: bob.id, pool: "private", localOnly: true })).toEqual(qwen);
    expect(() => models.addEndpoint(bob, { name: "x", kind: "local", baseUrl: local.baseUrl }, { shared: true })).toThrow(Forbidden);
    expect(() => models.removeEndpoint(bob, lan.id)).toThrow(Forbidden);
    expect(() => models.editEndpoint(bob, lan.id, { name: "mine" })).toThrow(Forbidden);
    expect(() => models.removeOffering(bob, qwen.offeringId)).toThrow(Forbidden);
    expect(() => models.resetIds(bob, lan.id)).toThrow(Forbidden);
    // Li's own endpoints stay hers.
    expect(models.endpoints(bob.id).some((e) => e.name === "gpu")).toBe(false);
    expect(models.offering(bob.id, models.offerings(li.id, models.findEndpoint(li.id, "gpu")!.id)[0]!.id)).toBeUndefined();
  });

  it("suggests the same model on another endpoint of the same kind, by name", async () => {
    const { models, li, qwen, copy, localRef } = await withShared();
    expect(baseName("deepseek/DeepSeek-4.1-Flash")).toBe("deepseek-4.1-flash");
    expect(baseName("deepseek-4.1-flash-Q4_K_M.gguf")).toBe("deepseek-4.1-flash");
    expect(baseName("Qwen3.8-27B-FP8")).toBe("qwen3.8-27b");
    expect(models.sameModel(li.id, qwen.offeringId).map((r) => r.offeringId).sort()).toEqual([copy.offeringId, localRef.offeringId].sort());
  });
});

describe("migrating to permanent IDs", () => {
  it("moves endpoints, models and every user's choices, shared ones included, to offerings", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const li = await users.createUser("li", "pw", profile("Li"), { admin: true });
    const bob = await users.createUser("bob", "pw", profile("Bob"), { admin: false });
    await users.authenticate("li", "pw");
    await users.authenticate("bob", "pw");
    const OLD = `
      CREATE TABLE endpoints (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, api TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT, created_at TEXT NOT NULL);
      CREATE TABLE endpoint_models (endpoint TEXT NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE, model TEXT NOT NULL, context_window INTEGER, tools INTEGER, manual INTEGER NOT NULL, PRIMARY KEY (endpoint, model));`;
    const CHOICES = `
      CREATE TABLE model_profiles (profile TEXT NOT NULL, task TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (profile, task));
      CREATE TABLE thread_models (pool TEXT NOT NULL, thread TEXT NOT NULL, task TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (pool, thread, task));
      CREATE TABLE local_only_threads (thread TEXT PRIMARY KEY);`;
    const now = new Date().toISOString();
    const self = keyring.self();
    self.exec(OLD);
    set(self, "INSERT INTO endpoints VALUES ('shared.lan', 'lan', 'local', 'openai-compatible', 'http://127.0.0.1:9/v1', NULL, ?)", now);
    set(self, "INSERT INTO endpoint_models VALUES ('shared.lan', 'qwen3.8-27b', 32768, 1, 0)");
    const liDb = users.openUserDb(li.id);
    liDb.exec(OLD + CHOICES);
    set(liDb, "INSERT INTO endpoints VALUES ('openrouter', 'openrouter', 'cloud', 'openai-compatible', 'http://127.0.0.1:9/v1', 'sk', ?)", now);
    set(liDb, "INSERT INTO endpoint_models VALUES ('openrouter', 'deepseek/deepseek-4.1-flash', NULL, NULL, 1)");
    set(liDb, "INSERT INTO model_profiles VALUES ('cloud', 'chat', 'openrouter', 'deepseek/deepseek-4.1-flash')");
    set(liDb, "INSERT INTO model_profiles VALUES ('local', 'chat', 'shared.lan', 'qwen3.8-27b')");
    set(liDb, "INSERT INTO model_profiles VALUES ('local', 'title', 'shared.lan', 'long-gone')");
    set(liDb, "INSERT INTO thread_models VALUES ('private', 'web/p', 'chat', 'shared.lan', 'qwen3.8-27b')");
    liDb.close();
    const bobDb = users.openUserDb(bob.id);
    bobDb.exec(CHOICES);
    set(bobDb, "INSERT INTO model_profiles VALUES ('local', 'chat', 'shared.lan', 'qwen3.8-27b')");
    bobDb.close();
    keyring.lockUser(bob.id);

    const models = new Models(keyring, users);
    const lan = models.findEndpoint(li.id, "shared.lan")!;
    expect(lan.id).toMatch(UUID);
    const [qwen] = models.offerings(li.id, lan.id);
    const deepseek = models.find(li.id, "openrouter/deepseek/deepseek-4.1-flash") as { offeringId: string };
    expect(models.offering(li.id, deepseek.offeringId)!.offering).toMatchObject({ manual: true });
    expect(qwen).toMatchObject({ modelId: "qwen3.8-27b", contextWindow: 32768, tools: true });
    expect(models.profile(li.id, "cloud")).toEqual({ chat: [deepseek] });
    expect(models.profile(li.id, "local")).toEqual({ chat: [{ offeringId: qwen!.id }] });
    expect(models.callContext(li.id, "private", "web/p").overrides).toEqual({ chat: [{ offeringId: qwen!.id }] });
    expect(models.notice(li.id)).toEqual(["Models that no longer existed were taken out of your lists: shared.lan/long-gone."]);
    // Bob was locked; his shared reference migrates when he next opens.
    await users.authenticate("bob", "pw");
    expect(models.profile(bob.id, "local")).toEqual({ chat: [{ offeringId: qwen!.id }] });
  });
});

describe("redirects, tombstones and Clean up", () => {
  it("removing a shared endpoint while a user is locked: their calls skip it, and their next unlock rewrites their lists with a notice", async () => {
    const m = await withShared();
    const { models, li, bob, lan, qwen, copy } = m;
    models.setProfile(bob.id, "local", "chat", qwen);
    models.setProfile(bob.id, "local", "title", copy);
    models.setThreadModel(bob.id, "general", "web/b", "chat", qwen);
    m.keyring.lockUser(bob.id);

    models.removeEndpoint(li, lan.id);
    expect(models.endpoints(li.id).some((e) => e.id === lan.id)).toBe(false);
    // A context built before the rewrite, naming the removed model: it is skipped, so the profile applies.
    expect(() => models.resolveModel("chat", { userId: li.id, pool: "private", localOnly: true, overrides: { chat: [qwen] } })).toThrow(NoModel);
    models.setProfile(li.id, "local", "chat", copy);
    expect(models.resolveModel("chat", { userId: li.id, pool: "private", localOnly: true, overrides: { chat: [qwen] } })).toEqual(copy);

    await m.users.authenticate("bob", "pw");
    expect(models.profile(bob.id, "local")).toMatchObject({ title: [copy] });
    expect(models.profile(bob.id, "local").chat).toBeUndefined();
    expect(models.callContext(bob.id, "general", "web/b").overrides).toEqual({});
    expect(models.notice(bob.id)).toEqual(["shared.lan/qwen3.8-27b was removed in the local profile's chat, one thread."]);
    models.dismissNotice(bob.id);
    expect(models.notice(bob.id)).toEqual([]);
    // Once every user has rewritten their lists, the tombstones go.
    models.profile(li.id, "local");
    expect(m.keyring.self().prepare("SELECT count(*) AS n FROM offering_redirects").get()).toEqual({ n: 0 });
  });

  it("routes a replacement at once, and refuses one that crosses the local/cloud line", async () => {
    const m = await withShared();
    const { models, li, bob, qwen, copy, flash, cloudRef } = m;
    models.setProfile(bob.id, "local", "chat", qwen);
    m.keyring.lockUser(bob.id);
    expect(() => models.replace(li, qwen.offeringId, cloudRef.offeringId)).toThrow(CloudModelForbidden);
    expect(() => models.replace(li, qwen.offeringId, m.localRef.offeringId)).toThrow(/shared/);
    models.replace(li, qwen.offeringId, copy.offeringId);
    // A context still naming the old ID routes to the replacement.
    expect(models.resolveModel("chat", { userId: li.id, pool: "private", localOnly: true, overrides: { chat: [qwen] } })).toEqual(copy);
    // A chain of replacements is followed too.
    models.replace(li, copy.offeringId, flash.offeringId);
    await m.users.authenticate("bob", "pw");
    expect(models.profile(bob.id, "local").chat).toEqual([flash]);
    expect(models.notice(bob.id)).toEqual([
      "shared.lan/qwen3.8-27b was replaced by shared.lan/qwen3.8-flash in the local profile's chat.",
    ]);
  });

  it("Reset IDs gives fresh IDs and breaks nothing", async () => {
    const m = await withShared();
    const { models, li, bob, lan, qwen, flash } = m;
    models.setProfile(bob.id, "local", "chat", qwen);
    models.setThreadModel(li.id, "private", "web/p", "chat", flash);
    m.keyring.lockUser(bob.id);
    const fresh = models.resetIds(li, lan.id);
    expect(fresh).not.toBe(lan.id);
    const now = models.offerings(li.id, fresh);
    expect(now.map((o) => o.modelId)).toEqual(["qwen3.8-27b", "qwen3.8-flash"]);
    expect(now.some((o) => o.id === qwen.offeringId)).toBe(false);
    const liCtx = models.callContext(li.id, "private", "web/p");
    expect(models.resolveModel("chat", liCtx)).toEqual({ offeringId: now[1]!.id });
    await m.users.authenticate("bob", "pw");
    expect(models.resolveModel("chat", { userId: bob.id, pool: "private", localOnly: true })).toEqual({ offeringId: now[0]!.id });
  });

  it("merges two endpoints that are the same server", async () => {
    const { models, li, gpu, localRef, local } = await withModels();
    const again = models.addEndpoint(li, { name: "gpu-again", kind: "local", baseUrl: local.baseUrl });
    const [dup] = await models.discover(li, again.id);
    const extra = models.addModel(li, again.id, { modelId: "only-here" });
    models.setProfile(li.id, "local", "chat", { offeringId: dup!.id });
    models.merge(li, again.id, gpu.id);
    expect(models.profile(li.id, "local").chat).toEqual([localRef]);
    expect(models.offerings(li.id, gpu.id).map((o) => o.id)).toEqual([extra.id, localRef.offeringId]);
    expect(models.endpoint(li.id, again.id)).toBeUndefined();
    // A personal endpoint's redirects are applied at once, by its owner, so there's nothing to tell them later.
    expect(models.notice(li.id)).toEqual([]);
  });

  it("lists stale endpoints and gone models with where they're used, and prunes gone models nothing names", async () => {
    const m = await withShared();
    const { models, li, bob, lan, lan2, qwen, flash, copy } = m;
    const self = m.keyring.self();
    set(self, "UPDATE offerings SET missing_since = ? WHERE id IN (?, ?)", daysAgo(31), qwen.offeringId, flash.offeringId);
    set(self, "UPDATE endpoints SET down_since = ? WHERE id = ?", daysAgo(20), lan2.id);
    models.setProfile(li.id, "local", "chat", qwen);
    models.setProfile(bob.id, "local", "chat", qwen);
    models.setThreadModel(bob.id, "private", "web/b", "title", copy);
    expect(models.offering(li.id, qwen.offeringId)!.offering.status).toBe("gone");
    // Fallbacks skip gone models and stale endpoints.
    expect(() => models.resolveModel("chat", { userId: li.id, pool: "private", localOnly: true })).toThrow(/missing/);
    expect(() => models.resolveModel("title", { userId: bob.id, pool: "private", localOnly: true, overrides: { title: [copy] } })).toThrow(/hasn't answered/);

    const items = models.cleanup(bob.id);
    expect(items.map((i) => i.label)).toEqual(["shared.lan2", "shared.lan/qwen3.8-27b", "shared.lan/qwen3.8-flash"]);
    expect(items[0]).toMatchObject({ usedIn: [{ where: "thread", pool: "private", threadId: "web/b", task: "title" }], otherUsers: 0 });
    expect(items[1]).toMatchObject({ usedIn: [{ where: "profile", profile: "local", task: "chat" }], otherUsers: 1 });
    // The same model elsewhere is suggested, but never a stale endpoint's.
    expect(items[1]!.suggestion).toBeUndefined();
    m.keyring.lockUser(bob.id);
    models.prune();
    // Only the gone model nobody names is removed.
    expect(models.offerings(li.id, lan.id).map((o) => o.modelId)).toEqual(["qwen3.8-27b"]);
  });
});

describe("the router", () => {
  it("lets a thread's override beat the profile", async () => {
    const { models, li, cloudRef, localRef, ctx } = await withModels();
    models.setProfile(li.id, "cloud", "chat", cloudRef);
    expect(models.resolveModel("chat", ctx())).toEqual(cloudRef);
    models.setThreadModel(li.id, "general", "web/t1", "chat", localRef);
    expect(models.resolveModel("chat", models.callContext(li.id, "general", "web/t1"))).toEqual(localRef);
    expect(models.resolveModel("chat", models.callContext(li.id, "general", "web/t2"))).toEqual(cloudRef);
  });

  it("falls back to the chat model within the same profile, except for embeddings", async () => {
    const { models, li, cloudRef, localRef, ctx } = await withModels();
    models.setProfile(li.id, "cloud", "chat", cloudRef);
    models.setProfile(li.id, "local", "chat", localRef);
    expect(models.resolveModel("compaction", ctx())).toEqual(cloudRef);
    expect(models.resolveModel("subagent.cheap", ctx({ pool: "private", localOnly: true }))).toEqual(localRef);
    expect(() => models.resolveModel("embedding", ctx())).toThrow(NoModel);
  });

  it("never gives a private or local-only thread a cloud model, and never falls back across the line", async () => {
    const { models, li, cloudRef, localRef, ctx, gpu } = await withModels();
    models.setProfile(li.id, "cloud", "chat", cloudRef);
    // No local chat model: a private thread gets an error, not the cloud one.
    expect(() => models.resolveModel("chat", ctx({ pool: "private", localOnly: true }))).toThrow(NoModel);
    // A cloud override in a local-only context throws, even if handed in directly.
    expect(() => models.resolveModel("chat", ctx({ localOnly: true, overrides: { chat: [cloudRef] } }))).toThrow(CloudModelForbidden);
    expect(() => models.resolveModel("subagent.strong", ctx({ pool: "private", localOnly: true, overrides: { "subagent.strong": [cloudRef] } }))).toThrow(CloudModelForbidden);
    // Settings refuse cloud models where they can't be used.
    expect(() => models.setProfile(li.id, "local", "chat", cloudRef)).toThrow(CloudModelForbidden);
    expect(() => models.setThreadModel(li.id, "private", "web/p", "chat", cloudRef)).toThrow(CloudModelForbidden);
    models.setLocalOnly(li.id, "general", "web/g", true);
    expect(models.callContext(li.id, "general", "web/g").localOnly).toBe(true);
    expect(() => models.setThreadModel(li.id, "general", "web/g", "chat", cloudRef)).toThrow(CloudModelForbidden);
    expect(() => models.setLocalOnly(li.id, "private", "web/p", false)).toThrow(CloudModelForbidden);
    expect(models.callContext(li.id, "private", "web/p").localOnly).toBe(true);
    // Only local endpoints are offered there at all.
    expect(models.allowed(ctx({ pool: "private", localOnly: true })).map((a) => a.endpoint.id)).toEqual([gpu.id]);
    models.setProfile(li.id, "local", "chat", localRef);
    expect(models.resolveModel("chat", ctx({ pool: "private", localOnly: true }))).toEqual(localRef);
  });

  it("refuses models that don't exist", async () => {
    const { models, li } = await withModels();
    expect(() => models.setProfile(li.id, "cloud", "chat", { offeringId: "nope" })).toThrow(NoModel);
  });

  it("gives a child thread its parent's limits and the tier's model", async () => {
    const { models, li, cloudRef, localRef, ctx } = await withModels();
    models.setDefaultProfile(li.id, "custom");
    models.setProfile(li.id, "custom", "subagent.cheap", localRef);
    models.setProfile(li.id, "custom", "subagent.strong", cloudRef);
    models.setProfile(li.id, "local", "chat", localRef);
    models.setThreadModel(li.id, "general", "web/p", "title", localRef);
    const parent = models.callContext(li.id, "general", "web/p");

    const cheap = models.childContext(parent, "web/c1", { tier: "cheap" });
    expect(models.resolveModel("chat", cheap)).toEqual(localRef);
    expect(cheap.overrides?.title).toEqual([localRef]);
    expect(models.resolveModel("chat", models.childContext(parent, "web/c2", { tier: "strong" }))).toEqual(cloudRef);
    expect(models.resolveModel("chat", models.childContext(parent, "web/c3", { model: cloudRef }))).toEqual(cloudRef);

    // A private parent: only local, by tier or by name, and nothing is written when refused.
    const priv = ctx({ pool: "private", localOnly: true });
    const child = models.childContext(priv, "web/c4", { tier: "strong" });
    expect(child.localOnly).toBe(true);
    expect(models.resolveModel("chat", child)).toEqual(localRef);
    expect(() => models.childContext(priv, "web/c5", { model: cloudRef })).toThrow(CloudModelForbidden);
    expect(() => models.childContext({ ...priv, overrides: { "subagent.cheap": [cloudRef] } }, "web/c5", { tier: "cheap" })).toThrow(CloudModelForbidden);
    expect(models.callContext(li.id, "private", "web/c5").overrides).toEqual({});

    // A local-only parent's children are local-only.
    models.setLocalOnly(li.id, "general", "web/lo", true);
    const lo = models.childContext(models.callContext(li.id, "general", "web/lo"), "web/c6", { tier: "cheap" });
    expect(lo.localOnly).toBe(true);
    // It uses the local profile, where strong falls back to the local chat model.
    expect(models.resolveModel("chat", models.childContext(models.callContext(li.id, "general", "web/lo"), "web/c7", { tier: "strong" }))).toEqual(localRef);
  });
});
