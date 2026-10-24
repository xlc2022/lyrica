import { describe, expect, it } from "vitest";
import { addressesOutside, CloudModelForbidden, Forbidden, NoModel, baseName, type Db } from "../src/index.ts";
import { deadUrl, fakeOpenAI } from "./fake-openai.ts";
import { beforeVersions, freshKeyring, profile, withModels } from "./helpers.ts";
import { Models, Users } from "../src/index.ts";
import { ENDPOINT_SCHEMA, migrate, MODEL_CHOICE_SCHEMA, PRESET_SCHEMA, REDIRECT_SCHEMA } from "../src/models/schema.ts";

const UUID = /^[0-9a-f-]{36}$/;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const set = (db: Db, sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);

/** Ada plus Bob (not an administrator), and a shared local endpoint "lan" serving qwen3.8-27b and a second copy "lan2". */
async function withShared() {
  const m = await withModels();
  const bob = await m.users.createUser("bob", "pw", profile("Bob"), { admin: false });
  await m.users.authenticate("bob", "pw");
  const lanModels = [{ id: "qwen3.8-27b" }, { id: "qwen3.8-flash" }];
  const lanServer = await fakeOpenAI({ models: lanModels });
  const lan = m.models.addEndpoint(m.ada, { name: "lan", kind: "local", baseUrl: lanServer.baseUrl }, { shared: true });
  const lan2 = m.models.addEndpoint(m.ada, { name: "lan2", kind: "local", baseUrl: (await fakeOpenAI({ models: [{ id: "Qwen3.8-27B-Q4_K_M.gguf" }] })).baseUrl }, { shared: true });
  const [qwen, flash] = await m.models.discover(m.ada, lan.id);
  const [copy] = await m.models.discover(m.ada, lan2.id);
  return { ...m, bob, lan, lan2, lanModels, qwen: { offeringId: qwen!.id }, flash: { offeringId: flash!.id }, copy: { offeringId: copy!.id } };
}

describe("endpoints", () => {
  it("gives endpoints and their models permanent IDs, with capabilities from discovery or by hand", async () => {
    const { models, ada, gpu, openrouter } = await withModels();
    expect(openrouter.id).toMatch(UUID);
    expect(models.offerings(ada.id, openrouter.id)).toEqual([
      { id: expect.stringMatching(UUID), endpointId: openrouter.id, modelId: "deepseek/deepseek-4.1-flash", contextWindow: 128000, tools: true, manual: false, status: "listed" },
    ]);
    const [qwen] = models.offerings(ada.id, gpu.id);
    expect(qwen).toMatchObject({ modelId: "qwen3.8-27b", contextWindow: 32768, manual: false });
    const flash = models.addModel(ada, gpu.id, { modelId: "qwen3.8-flash", contextWindow: 8192, tools: true });
    expect(models.setCapabilities(ada, qwen!.id, { tools: true, vision: false })).toMatchObject({ tools: true, vision: false, contextWindow: 32768 });
    // Rediscovering keeps every ID, and hand-set capabilities win.
    await models.discover(ada, gpu.id);
    expect(models.offerings(ada.id, gpu.id).map((o) => [o.id, o.modelId, o.manual, o.tools])).toEqual([[qwen!.id, "qwen3.8-27b", false, true], [flash.id, "qwen3.8-flash", true, true]]);
    expect(models.label(ada.id, qwen!.id)).toBe("gpu/qwen3.8-27b");
    expect(models.find(ada.id, "gpu/qwen3.8-27b")).toEqual({ offeringId: qwen!.id });
  });

  it("reads every endpoint's list again once a day, unless the user turned it off", async () => {
    const { models, ada } = await withModels();
    const list: Record<string, unknown>[] = [{ id: "flint:free" }, { id: "dropped:free" }];
    const router = await fakeOpenAI({ models: list });
    const ep = models.addEndpoint(ada, { name: "router", kind: "cloud", baseUrl: router.baseUrl, apiKey: "k" });
    await models.discover(ada, ep.id);
    const status = (id: string) => models.offerings(ada.id, ep.id).find((o) => o.modelId === id)?.status;
    // The endpoint drops one model: it waits for the day to pass, then is marked missing, as by Refresh.
    list.splice(1, 1, { id: "new:free" });
    const day = 86_400_000;
    await models.rereadDaily(Date.now() + day / 2);
    expect(status("dropped:free")).toBe("listed");
    expect(models.readDaily(ada.id)).toBe(true);
    await models.rereadDaily(Date.now() + day + 1000);
    expect(status("dropped:free")).toBe("missing");
    expect(status("new:free")).toBe("listed");
    // Off, nothing is read.
    models.setReadDaily(ada.id, false);
    list.push({ id: "later:free" });
    await models.rereadDaily(Date.now() + 3 * day);
    expect(status("later:free")).toBeUndefined();
  });

  it("reads OpenRouter's thinking, prices, retirement and reply limit", async () => {
    const { models, ada, gpu, localRef } = await withModels();
    const router = await fakeOpenAI({ models: [
      { id: "minimax/minimax-m3.1-flash:free", context_length: 1048576, supported_parameters: ["tools", "reasoning"],
        reasoning: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "max" },
        pricing: { prompt: "0", completion: "0" }, top_provider: { max_completion_tokens: 524288 }, expiration_date: "2026-11-30" },
      { id: "paid/thinker", supported_parameters: ["reasoning"], reasoning: { mandatory: false, supported_efforts: ["none", "minimal", "high"] },
        pricing: { prompt: "0.0000003", completion: "0.0000012", internal_reasoning: "0.0000012", input_cache_read: "0" } },
      { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" }, expiration_date: "soon" },
    ] });
    const ep = models.addEndpoint(ada, { name: "router", kind: "cloud", baseUrl: router.baseUrl, apiKey: "k" });
    const found = await models.discover(ada, ep.id);
    const [free, paid, auto] = ["minimax/minimax-m3.1-flash:free", "paid/thinker", "openrouter/auto"].map((id) => found.find((o) => o.modelId === id));
    expect(free).toMatchObject({ reasoning: ["low", "medium", "high"], alwaysThinks: true, maxOutput: 524288, retiresAt: "2026-11-30", price: { input: 0, output: 0, free: true } });
    expect(paid).toMatchObject({ reasoning: ["low", "high"], price: { input: 0.3, output: 1.2, reasoning: 1.2, free: false } });
    expect(paid!.alwaysThinks).toBeUndefined();
    expect(paid!.price!.cacheRead).toBeUndefined();
    expect(auto!.price).toBeUndefined();
    expect(auto!.retiresAt).toBeUndefined();
    // A model that must think thinks at medium when asked for off.
    expect(models.thinkingFor({ offering: free!, label: "free" }, "off").level).toBe("medium");
    // Free models only skips a priced model, never one with no known price.
    const ref = (o: typeof free) => ({ offeringId: o!.id });
    models.setColumnTask(ada.id, "general", "chat", [ref(paid), ref(free)]);
    const ctx = () => models.callContext(ada.id, "general", "web/a");
    expect(models.freeOnly(ada.id)).toBe(false);
    expect(models.resolve("chat", ctx()).ref).toEqual(ref(paid));
    models.setFreeOnly(ada.id, true);
    const r = models.resolve("chat", ctx());
    expect(r.ref).toEqual(ref(free));
    expect(r.skipped).toEqual([{ label: "router/paid/thinker", reason: "it costs money, and Free models only is on" }]);
    models.setColumnTask(ada.id, "general", "chat", [ref(paid), ref(auto)]);
    expect(models.resolve("chat", ctx()).ref).toEqual(ref(auto));
    models.setColumnTask(ada.id, "general", "chat", [ref(paid)]);
    expect(() => models.resolve("chat", ctx())).toThrow(/Free models only is on/);
    // With it off, a paid model answering in place of a free one says which free one was passed over.
    models.setFreeOnly(ada.id, false);
    models.setColumnTask(ada.id, "general", "chat", [localRef, ref(paid)]);
    expect(models.resolve("chat", ctx()).paidAfter).toBeUndefined();
    models.reportDown(gpu.id);
    expect(models.resolve("chat", ctx()).paidAfter).toEqual({ label: "gpu/qwen3.8-27b", reason: expect.any(String) });
    models.setColumnTask(ada.id, "general", "chat", [localRef, ref(auto)]);
    expect(models.resolve("chat", ctx()).paidAfter).toBeUndefined();
  });

  it("reads a plain llama-server's /props: the template's thinking switch and tools, vision and slots", async () => {
    const { models, ada } = await withModels();
    const template = "{%- if tools %}...{%- endif %}{%- if enable_thinking is defined and enable_thinking is false %}<think>\n\n</think>{%- endif %}";
    const facts = { chat_template: template, default_generation_settings: { n_ctx: 131072 }, total_slots: 2, modalities: { vision: false } };
    // A router: asked only about the model it has loaded, since it may load one it's asked about.
    const qwenListing = { id: "qwen.gguf", meta: { n_ctx: 131072 }, status: { value: "loaded" } };
    const router = await fakeOpenAI({ models: [qwenListing, { id: "other.gguf", status: { value: "unloaded" } }],
      props: { "qwen.gguf": facts, "other.gguf": facts } });
    const ep = models.addEndpoint(ada, { name: "direct", kind: "local", baseUrl: router.baseUrl });
    const found = await models.discover(ada, ep.id);
    const qwen = found.find((o) => o.modelId === "qwen.gguf")!;
    expect(qwen).toMatchObject({ llamaServer: true, reasoning: ["medium"], tools: true, vision: false, parallel: 2, opensThinking: true, contextWindow: 131072 });
    expect(found.find((o) => o.modelId === "other.gguf")!.llamaServer).toBeUndefined();
    expect(router.propsAsked).toEqual(["qwen.gguf"]);
    // Unloaded at the next discovery, it isn't asked again and keeps what /props said.
    qwenListing.status.value = "unloaded";
    const again = (await models.discover(ada, ep.id)).find((o) => o.modelId === "qwen.gguf")!;
    expect(again).toMatchObject({ llamaServer: true, reasoning: ["medium"], tools: true, parallel: 2, opensThinking: true });
    expect(router.propsAsked).toEqual(["qwen.gguf"]);
    // Its one level is the template's switch: on at any level asked, with no note, and off when asked.
    expect(models.thinkingFor({ offering: qwen, label: "direct/qwen.gguf" }, "high")).toEqual({ level: "medium" });
    expect(models.thinkingFor({ offering: qwen, label: "direct/qwen.gguf" }, "off")).toEqual({ level: "off" });
    // A server that lists several models without states isn't one llama-server: /props isn't asked.
    const many = await fakeOpenAI({ models: [{ id: "a" }, { id: "b" }], props: { "": facts } });
    await models.discover(ada, models.addEndpoint(ada, { name: "many", kind: "local", baseUrl: many.baseUrl }).id);
    expect(many.propsAsked).toEqual([]);
  });

  it("keeps a model the endpoint stops listing, marked missing, and its ID when it comes back", async () => {
    const m = await withShared();
    m.lanModels.pop();
    await m.models.discover(m.ada, m.lan.id);
    expect(m.models.offering(m.ada.id, m.flash.offeringId)!.offering).toMatchObject({ status: "missing", missingSince: expect.any(String) });
    m.lanModels.push({ id: "qwen3.8-flash" });
    await m.models.discover(m.ada, m.lan.id);
    expect(m.models.offering(m.ada.id, m.flash.offeringId)!.offering.status).toBe("listed");
  });

  it("never changes IDs when an endpoint is renamed or moved", async () => {
    const { models, ada, gpu, localRef, local } = await withModels();
    models.setColumnTask(ada.id, "private", "chat", localRef);
    const moved = models.editEndpoint(ada, gpu.id, { name: "blackwell", baseUrl: `${local.baseUrl}/`, apiKey: "k" });
    expect(moved).toMatchObject({ id: gpu.id, name: "blackwell", apiKey: "k" });
    expect(models.resolveModel("chat", { userId: ada.id, pool: "private", localOnly: true })).toEqual(localRef);
    expect(models.label(ada.id, localRef.offeringId)).toBe("blackwell/qwen3.8-27b");
    expect(models.editEndpoint(ada, gpu.id, { apiKey: null }).apiKey).toBeUndefined();
  });

  it("fills in a base URL given as a bare address, and refuses one that isn't a URL", async () => {
    const { models, ada, gpu } = await withModels();
    const url = (baseUrl: string) => models.editEndpoint(ada, gpu.id, { baseUrl }).baseUrl;
    expect(url("10.0.0.5:1234")).toBe("http://10.0.0.5:1234/v1");
    expect(url("http://10.0.0.5:1234/")).toBe("http://10.0.0.5:1234/v1");
    expect(url("localhost:1234")).toBe("http://localhost:1234/v1");
    expect(url("http://10.0.0.5:1234/api/v1")).toBe("http://10.0.0.5:1234/api/v1");
    expect(url("http://10.0.0.5:1234?key=k")).toBe("http://10.0.0.5:1234/v1?key=k");
    expect(() => url("10.0.0.5:99999")).toThrow("the base URL isn't a valid URL");
    expect(() => url("ftp://10.0.0.5")).toThrow("the base URL must be http or https");
    const cloud = models.addEndpoint(ada, { name: "openai", kind: "cloud", baseUrl: "api.openai.com" });
    expect(cloud.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("skips a paused endpoint until it is resumed, and keeps it paused across edits", async () => {
    const { models, ada, gpu, localRef } = await withModels();
    models.setColumnTask(ada.id, "private", "chat", localRef);
    const priv = { userId: ada.id, pool: "private" as const, localOnly: true };
    expect(models.editEndpoint(ada, gpu.id, { paused: true }).pausedAt).toEqual(expect.any(String));
    expect(models.editEndpoint(ada, gpu.id, { name: "gpu2" }).pausedAt).toEqual(expect.any(String));
    expect(() => models.resolveModel("chat", priv)).toThrow(/paused/);
    expect(models.editEndpoint(ada, gpu.id, { paused: false }).pausedAt).toBeUndefined();
    expect(models.resolveModel("chat", priv)).toEqual(localRef);
  });

  it("probe reports up and down, and an endpoint down for 14 days is stale", async () => {
    const { models, ada, gpu, keyring, users } = await withModels();
    expect(await models.probe(ada.id, gpu.id)).toEqual({ state: "up" });
    const off = models.addEndpoint(ada, { name: "off", kind: "local", baseUrl: await deadUrl() });
    expect(await models.probe(ada.id, off.id)).toEqual({ state: "down" });
    expect(models.endpoint(ada.id, off.id)).toMatchObject({ downSince: expect.any(String), stale: false });
    const db = users.openUserDb(ada.id);
    set(db, "UPDATE endpoints SET down_since = ? WHERE id = ?", daysAgo(15), off.id);
    db.close();
    expect(models.endpoint(ada.id, off.id)!.stale).toBe(true);
    void keyring;
  });

  it("never lets a working endpoint go stale: a successful call clears its down time", async () => {
    const { models, ada, gpu, users } = await withModels();
    const db = users.openUserDb(ada.id);
    set(db, "UPDATE endpoints SET down_since = ? WHERE id = ?", daysAgo(20), gpu.id);
    db.close();
    expect(models.endpoint(ada.id, gpu.id)!.stale).toBe(true);
    models.reportUp(ada.id, gpu.id);
    expect(models.endpoint(ada.id, gpu.id)).toMatchObject({ stale: false });
    expect(models.endpoint(ada.id, gpu.id)!.downSince).toBeUndefined();
  });

  it("marks a local endpoint over plain HTTP outside this machine and the tailnet as unencrypted", async () => {
    const { models, ada } = await withModels();
    const add = (name: string, baseUrl: string, kind: "local" | "cloud" = "local") => models.addEndpoint(ada, { name, kind, baseUrl }).unencrypted;
    expect(add("a", "http://127.0.0.1:1234/v1")).toBe(false);
    expect(add("b", "http://lyrica-blackwell.tail1234.ts.net:7236/v1")).toBe(false);
    expect(add("c", "http://100.101.102.103:8080/v1")).toBe(false);
    expect(add("d", "https://192.168.1.20/v1")).toBe(false);
    expect(add("e", "http://192.168.1.20:1234/v1")).toBe(true);
    expect(add("f", "http://gpu.lan:1234/v1")).toBe(true);
    expect(add("g", "http://203.0.113.7/v1", "cloud")).toBe(false);
  });

  it("warns when a local endpoint is outside Ada's network, and only then", async () => {
    for (const url of ["http://localhost:1234/v1", "http://192.168.1.20:1234/v1", "http://10.1.2.3/v1", "http://172.20.0.5/v1",
      "http://100.101.102.103:8080/v1", "http://[fd7a:115c:a1e0::1]:8080/v1", "http://[::1]:8080/v1"]) {
      expect(await addressesOutside(url)).toEqual([]);
    }
    expect(await addressesOutside("http://8.8.8.8/v1")).toEqual(["8.8.8.8"]);
    expect(await addressesOutside("http://[2001:db8::1]/v1")).toEqual(["2001:db8::1"]);
    expect(await addressesOutside("http://172.32.0.1/v1")).toEqual(["172.32.0.1"]);

    const { models, ada } = await withModels();
    const odd = models.addEndpoint(ada, { name: "odd", kind: "local", baseUrl: "http://203.0.113.7:9/v1" });
    expect((await models.probe(ada.id, odd.id)).warning).toContain("odd is declared local, but 203.0.113.7 resolves to 203.0.113.7");
    const router = models.addEndpoint(ada, { name: "router", kind: "cloud", baseUrl: "http://203.0.113.7:9/v1" });
    expect((await models.probe(ada.id, router.id)).warning).toBeUndefined();
  });

  it("shares administrator endpoints with every user, and only administrators change them", async () => {
    const { models, ada, bob, lan, qwen, local } = await withShared();
    expect(models.endpoints(bob.id).map((e) => e.name)).toEqual(["lan", "lan2"]);
    expect(models.label(bob.id, qwen.offeringId)).toBe("shared.lan/qwen3.8-27b");
    models.setColumnTask(bob.id, "private", "chat", qwen);
    expect(models.resolveModel("chat", { userId: bob.id, pool: "private", localOnly: true })).toEqual(qwen);
    expect(() => models.addEndpoint(bob, { name: "x", kind: "local", baseUrl: local.baseUrl }, { shared: true })).toThrow(Forbidden);
    expect(() => models.removeEndpoint(bob, lan.id)).toThrow(Forbidden);
    expect(() => models.editEndpoint(bob, lan.id, { name: "mine" })).toThrow(Forbidden);
    expect(() => models.removeOffering(bob, qwen.offeringId)).toThrow(Forbidden);
    expect(() => models.resetIds(bob, lan.id)).toThrow(Forbidden);
    // Ada's own endpoints stay hers.
    expect(models.endpoints(bob.id).some((e) => e.name === "gpu")).toBe(false);
    expect(models.offering(bob.id, models.offerings(ada.id, models.findEndpoint(ada.id, "gpu")!.id)[0]!.id)).toBeUndefined();
  });

  it("suggests the same model on another endpoint of the same kind, by name", async () => {
    const { models, ada, qwen, copy, localRef } = await withShared();
    expect(baseName("deepseek/DeepSeek-4.1-Flash")).toBe("deepseek-4.1-flash");
    expect(baseName("deepseek-4.1-flash-Q4_K_M.gguf")).toBe("deepseek-4.1-flash");
    expect(baseName("Qwen3.8-27B-FP8")).toBe("qwen3.8-27b");
    expect(models.sameModel(ada.id, qwen.offeringId).map((r) => r.offeringId).sort()).toEqual([copy.offeringId, localRef.offeringId].sort());
  });
});

describe("migrating to permanent IDs", () => {
  it("leaves the old tables as they were when a migration is interrupted", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const db = users.openUserDb(ada.id);
    beforeVersions(db, ENDPOINT_SCHEMA, MODEL_CHOICE_SCHEMA, PRESET_SCHEMA);
    db.exec(`
      CREATE TABLE endpoints (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, api TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT, created_at TEXT NOT NULL);
      CREATE TABLE endpoint_models (endpoint TEXT NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE, model TEXT NOT NULL, context_window INTEGER, tools INTEGER, manual INTEGER NOT NULL, PRIMARY KEY (endpoint, model));
      CREATE TABLE model_profiles (profile TEXT NOT NULL, task TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (profile, task));
      CREATE TABLE thread_models (pool TEXT NOT NULL, thread TEXT NOT NULL, task TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (pool, thread, task));
      CREATE TABLE offerings (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, model TEXT NOT NULL, found TEXT NOT NULL DEFAULT '{}', hand TEXT NOT NULL DEFAULT '{}', manual INTEGER NOT NULL, missing_since TEXT, created_at TEXT NOT NULL, UNIQUE (endpoint, model));
      INSERT INTO endpoints VALUES ('gpu', 'gpu', 'local', 'openai-compatible', 'http://127.0.0.1:9/v1', NULL, '2026-01-01');
      INSERT INTO endpoint_models VALUES ('gpu', 'qwen', NULL, NULL, 0);
      INSERT INTO model_profiles VALUES ('local', 'chat', 'gpu', 'qwen');
      INSERT INTO model_profiles VALUES ('local', 'title', 'shared.lan', 'qwen');`);
    expect(() => migrate(db, { shared: () => { throw new Error("stopped"); } })).toThrow("stopped");
    expect(db.prepare("SELECT id FROM endpoints").all()).toEqual([{ id: "gpu" }]);
    expect(db.prepare("SELECT count(*) AS n FROM endpoint_models").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT endpoint, model FROM model_profiles WHERE task = 'chat'").get()).toEqual({ endpoint: "gpu", model: "qwen" });
    db.close();
    // Run again, it completes.
    const models = new Models(keyring, new Users(keyring));
    expect(models.preset(ada.id, "builtin.local")!.entries.chat).toEqual([models.find(ada.id, "gpu/qwen")]);
  });

  it("moves endpoints, models and every user's choices, shared ones included, to offerings", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    const bob = await users.createUser("bob", "pw", profile("Bob"), { admin: false });
    await users.authenticate("ada", "pw");
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
    beforeVersions(self, ENDPOINT_SCHEMA, REDIRECT_SCHEMA);
    self.exec(OLD);
    set(self, "INSERT INTO endpoints VALUES ('shared.lan', 'lan', 'local', 'openai-compatible', 'http://127.0.0.1:9/v1', NULL, ?)", now);
    set(self, "INSERT INTO endpoint_models VALUES ('shared.lan', 'qwen3.8-27b', 32768, 1, 0)");
    // Unlocking again migrates self.db, keeping the old pairs for users still to migrate.
    await keyring.unlockSelf("passphrase");
    const adaDb = users.openUserDb(ada.id);
    beforeVersions(adaDb, ENDPOINT_SCHEMA, MODEL_CHOICE_SCHEMA, PRESET_SCHEMA);
    adaDb.exec(OLD + CHOICES);
    set(adaDb, "INSERT INTO endpoints VALUES ('openrouter', 'openrouter', 'cloud', 'openai-compatible', 'http://127.0.0.1:9/v1', 'sk', ?)", now);
    set(adaDb, "INSERT INTO endpoint_models VALUES ('openrouter', 'deepseek/deepseek-4.1-flash', NULL, NULL, 1)");
    set(adaDb, "INSERT INTO model_profiles VALUES ('cloud', 'chat', 'openrouter', 'deepseek/deepseek-4.1-flash')");
    set(adaDb, "INSERT INTO model_profiles VALUES ('local', 'chat', 'shared.lan', 'qwen3.8-27b')");
    set(adaDb, "INSERT INTO model_profiles VALUES ('local', 'title', 'shared.lan', 'long-gone')");
    set(adaDb, "INSERT INTO thread_models VALUES ('private', 'web/p', 'chat', 'shared.lan', 'qwen3.8-27b')");
    adaDb.close();
    const bobDb = users.openUserDb(bob.id);
    beforeVersions(bobDb, ENDPOINT_SCHEMA, MODEL_CHOICE_SCHEMA, PRESET_SCHEMA);
    bobDb.exec(CHOICES);
    set(bobDb, "INSERT INTO model_profiles VALUES ('local', 'chat', 'shared.lan', 'qwen3.8-27b')");
    bobDb.close();
    keyring.lockUser(bob.id);

    const models = new Models(keyring, new Users(keyring));
    const lan = models.findEndpoint(ada.id, "shared.lan")!;
    expect(lan.id).toMatch(UUID);
    const [qwen] = models.offerings(ada.id, lan.id);
    const deepseek = models.find(ada.id, "openrouter/deepseek/deepseek-4.1-flash") as { offeringId: string };
    expect(models.offering(ada.id, deepseek.offeringId)!.offering).toMatchObject({ manual: true });
    expect(qwen).toMatchObject({ modelId: "qwen3.8-27b", contextWindow: 32768, tools: true });
    // Watching, a task added later, follows cheap subagents in a stored profile.
    const later = { watching: { same: "subagent.cheap" }, code: { same: "subagent.strong" } };
    expect(models.preset(ada.id, "builtin.cloud")!.entries).toEqual({ chat: [deepseek], ...later });
    expect(models.preset(ada.id, "builtin.local")!.entries).toEqual({ chat: [{ offeringId: qwen!.id }], ...later });
    expect(models.callContext(ada.id, "private", "web/p").overrides).toEqual({ chat: [{ offeringId: qwen!.id }] });
    expect(models.notice(ada.id)).toEqual(["Models that no longer existed were taken out of your lists: shared.lan/long-gone."]);
    // Bob was locked; his shared reference migrates when he next opens.
    await users.authenticate("bob", "pw");
    expect(models.preset(bob.id, "builtin.local")!.entries).toEqual({ chat: [{ offeringId: qwen!.id }], ...later });
  });
});

describe("redirects, tombstones and Clean up", () => {
  it("refuses replacing a model with itself", async () => {
    const { models, ada, qwen } = await withShared();
    expect(() => models.replace(ada, qwen.offeringId, qwen.offeringId)).toThrow(/itself/);
  });

  it("keeps redirect chains one hop long: twenty Reset IDs while a user is locked break nothing", async () => {
    const m = await withShared();
    const { models, ada, bob, lan, qwen } = m;
    models.setColumnTask(bob.id, "private", "chat", qwen);
    m.keyring.lockUser(bob.id);
    let id = lan.id;
    for (let i = 0; i < 20; i++) id = models.resetIds(ada, id);
    const current = models.offerings(ada.id, id).find((o) => o.modelId === "qwen3.8-27b")!.id;
    const targets = m.keyring.self().prepare("SELECT DISTINCT to_id FROM offering_redirects").all() as { to_id: string }[];
    expect(targets.every((t) => models.offering(ada.id, t.to_id))).toBe(true);
    await m.users.authenticate("bob", "pw");
    expect(models.resolveModel("chat", { userId: bob.id, pool: "private", localOnly: true })).toEqual({ offeringId: current });
  });

  it("removing a shared endpoint while a user is locked: their calls skip it, and their next unlock rewrites their lists with a notice", async () => {
    const m = await withShared();
    const { models, ada, bob, lan, qwen, copy } = m;
    models.setColumnTask(bob.id, "private", "chat", qwen);
    models.setColumnTask(bob.id, "private", "title", copy);
    models.setThreadModel(bob.id, "general", "web/b", "chat", qwen);
    m.keyring.lockUser(bob.id);

    models.removeEndpoint(ada, lan.id);
    expect(models.endpoints(ada.id).some((e) => e.id === lan.id)).toBe(false);
    // A context built before the rewrite, naming the removed model: it is skipped, so the profile applies.
    expect(() => models.resolveModel("chat", { userId: ada.id, pool: "private", localOnly: true, overrides: { chat: [qwen] } })).toThrow(NoModel);
    models.setColumnTask(ada.id, "private", "chat", copy);
    expect(models.resolveModel("chat", { userId: ada.id, pool: "private", localOnly: true, overrides: { chat: [qwen] } })).toEqual(copy);

    await m.users.authenticate("bob", "pw");
    expect(models.column(bob.id, "private").entries).toMatchObject({ title: [copy] });
    expect(models.column(bob.id, "private").entries.chat).toBeUndefined();
    expect(models.callContext(bob.id, "general", "web/b").overrides).toEqual({});
    expect(models.notice(bob.id)).toEqual(["shared.lan/qwen3.8-27b was removed in the private column's chat, one thread."]);
    models.dismissNotice(bob.id);
    expect(models.notice(bob.id)).toEqual([]);
    // Once every user has rewritten their lists, the tombstones go.
    models.column(ada.id, "private");
    expect(m.keyring.self().prepare("SELECT count(*) AS n FROM offering_redirects").get()).toEqual({ n: 0 });
  });

  it("routes a replacement at once, and refuses one that crosses the local/cloud line", async () => {
    const m = await withShared();
    const { models, ada, bob, qwen, copy, flash, cloudRef } = m;
    models.setColumnTask(bob.id, "private", "chat", qwen);
    m.keyring.lockUser(bob.id);
    expect(() => models.replace(ada, qwen.offeringId, cloudRef.offeringId)).toThrow(CloudModelForbidden);
    expect(() => models.replace(ada, qwen.offeringId, m.localRef.offeringId)).toThrow(/shared/);
    models.replace(ada, qwen.offeringId, copy.offeringId);
    // A context still naming the old ID routes to the replacement.
    expect(models.resolveModel("chat", { userId: ada.id, pool: "private", localOnly: true, overrides: { chat: [qwen] } })).toEqual(copy);
    // A chain of replacements is followed too.
    models.replace(ada, copy.offeringId, flash.offeringId);
    await m.users.authenticate("bob", "pw");
    expect(models.column(bob.id, "private").entries.chat).toEqual([flash]);
    expect(models.notice(bob.id)).toEqual([
      "shared.lan/qwen3.8-27b was replaced by shared.lan/qwen3.8-flash in the private column's chat.",
    ]);
  });

  it("Reset IDs gives fresh IDs and breaks nothing", async () => {
    const m = await withShared();
    const { models, ada, bob, lan, qwen, flash } = m;
    models.setColumnTask(bob.id, "private", "chat", qwen);
    models.setThreadModel(ada.id, "private", "web/p", "chat", flash);
    m.keyring.lockUser(bob.id);
    const fresh = models.resetIds(ada, lan.id);
    expect(fresh).not.toBe(lan.id);
    const now = models.offerings(ada.id, fresh);
    expect(now.map((o) => o.modelId)).toEqual(["qwen3.8-27b", "qwen3.8-flash"]);
    expect(now.some((o) => o.id === qwen.offeringId)).toBe(false);
    const adaCtx = models.callContext(ada.id, "private", "web/p");
    expect(models.resolveModel("chat", adaCtx)).toEqual({ offeringId: now[1]!.id });
    await m.users.authenticate("bob", "pw");
    expect(models.resolveModel("chat", { userId: bob.id, pool: "private", localOnly: true })).toEqual({ offeringId: now[0]!.id });
  });

  it("merges two endpoints that are the same server", async () => {
    const { models, ada, gpu, localRef, local } = await withModels();
    const again = models.addEndpoint(ada, { name: "gpu-again", kind: "local", baseUrl: local.baseUrl });
    const [dup] = await models.discover(ada, again.id);
    const extra = models.addModel(ada, again.id, { modelId: "only-here" });
    models.setColumnTask(ada.id, "private", "chat", { offeringId: dup!.id });
    models.merge(ada, again.id, gpu.id);
    expect(models.column(ada.id, "private").entries.chat).toEqual([localRef]);
    expect(models.offerings(ada.id, gpu.id).map((o) => o.id)).toEqual([extra.id, localRef.offeringId]);
    expect(models.endpoint(ada.id, again.id)).toBeUndefined();
    // A personal endpoint's redirects are applied at once, by its owner, so there's nothing to tell them later.
    expect(models.notice(ada.id)).toEqual([]);
  });

  it("lists stale endpoints and gone models with where they're used, and prunes gone models nothing names", async () => {
    const m = await withShared();
    const { models, ada, bob, lan, lan2, qwen, flash, copy } = m;
    const self = m.keyring.self();
    set(self, "UPDATE offerings SET missing_since = ? WHERE id IN (?, ?)", daysAgo(31), qwen.offeringId, flash.offeringId);
    set(self, "UPDATE endpoints SET down_since = ? WHERE id = ?", daysAgo(20), lan2.id);
    models.setColumnTask(ada.id, "private", "chat", qwen);
    models.setColumnTask(bob.id, "private", "chat", qwen);
    models.setThreadModel(bob.id, "private", "web/b", "title", copy);
    expect(models.offering(ada.id, qwen.offeringId)!.offering.status).toBe("gone");
    // Fallbacks skip gone models and stale endpoints.
    expect(() => models.resolveModel("chat", { userId: ada.id, pool: "private", localOnly: true })).toThrow(/missing/);
    expect(() => models.resolveModel("title", { userId: bob.id, pool: "private", localOnly: true, overrides: { title: [copy] } })).toThrow(/hasn't answered/);

    const items = models.cleanup(bob.id);
    expect(items.map((i) => i.label)).toEqual(["shared.lan2", "shared.lan/qwen3.8-27b", "shared.lan/qwen3.8-flash"]);
    expect(items[0]).toMatchObject({ usedIn: [{ where: "thread", pool: "private", threadId: "web/b", task: "title" }], otherUsers: 0 });
    expect(items[1]).toMatchObject({ usedIn: [{ where: "column", column: "private", task: "chat" }], otherUsers: 1 });
    // The same model elsewhere is suggested, but never a stale endpoint's.
    expect(items[1]!.suggestion).toBeUndefined();
    m.keyring.lockUser(bob.id);
    models.prune();
    // Only the gone model nobody names is removed.
    expect(models.offerings(ada.id, lan.id).map((o) => o.modelId)).toEqual(["qwen3.8-27b"]);
  });

  it("removes a gone shared model 7 days after it went, even while lists name it", async () => {
    const m = await withShared();
    const { models, ada, bob, lan, qwen } = m;
    const self = m.keyring.self();
    models.setColumnTask(ada.id, "private", "chat", qwen);
    models.setColumnTask(bob.id, "private", "chat", qwen);
    m.keyring.lockUser(bob.id);
    // Gone for 6 days: still there, since lists name it.
    set(self, "UPDATE offerings SET missing_since = ? WHERE id = ?", daysAgo(36), qwen.offeringId);
    models.prune();
    expect(models.offerings(ada.id, lan.id).map((o) => o.modelId)).toContain("qwen3.8-27b");
    // Gone for 7 days: removed, and each user's list drops it, a locked one's at their next unlock.
    set(self, "UPDATE offerings SET missing_since = ? WHERE id = ?", daysAgo(37), qwen.offeringId);
    models.prune();
    expect(models.offerings(ada.id, lan.id).map((o) => o.modelId)).not.toContain("qwen3.8-27b");
    expect(models.column(ada.id, "private").entries.chat).toBeUndefined();
    await m.users.authenticate("bob", "pw");
    expect(models.column(bob.id, "private").entries.chat).toBeUndefined();
  });
});

describe("the router", () => {
  it("lets a thread's override beat the column", async () => {
    const { models, ada, cloudRef, localRef, ctx } = await withModels();
    models.setColumnTask(ada.id, "general", "chat", cloudRef);
    expect(models.resolveModel("chat", ctx())).toEqual(cloudRef);
    models.setThreadModel(ada.id, "general", "web/t1", "chat", localRef);
    expect(models.resolveModel("chat", models.callContext(ada.id, "general", "web/t1"))).toEqual(localRef);
    expect(models.resolveModel("chat", models.callContext(ada.id, "general", "web/t2"))).toEqual(cloudRef);
  });

  it("falls back to the chat model within the same column, except for embeddings", async () => {
    const { models, ada, cloudRef, localRef, ctx } = await withModels();
    models.setColumnTask(ada.id, "general", "chat", cloudRef);
    models.setColumnTask(ada.id, "private", "chat", localRef);
    expect(models.resolveModel("compaction", ctx())).toEqual(cloudRef);
    expect(models.resolveModel("subagent.cheap", ctx({ pool: "private", localOnly: true }))).toEqual(localRef);
    expect(() => models.resolveModel("embedding", ctx())).toThrow(NoModel);
  });

  it("never gives a private or local-only thread a cloud model, and never falls back across the line", async () => {
    const { models, ada, cloudRef, localRef, ctx, gpu } = await withModels();
    models.setColumnTask(ada.id, "general", "chat", cloudRef);
    // No local chat model: a private thread gets an error, not the cloud one.
    expect(() => models.resolveModel("chat", ctx({ pool: "private", localOnly: true }))).toThrow(NoModel);
    // A cloud override in a local-only context throws, even if handed in directly.
    expect(() => models.resolveModel("chat", ctx({ localOnly: true, overrides: { chat: [cloudRef] } }))).toThrow(CloudModelForbidden);
    expect(() => models.resolveModel("subagent.strong", ctx({ pool: "private", localOnly: true, overrides: { "subagent.strong": [cloudRef] } }))).toThrow(CloudModelForbidden);
    // Settings refuse cloud models where they can't be used.
    expect(() => models.setColumnTask(ada.id, "private", "chat", cloudRef)).toThrow(CloudModelForbidden);
    expect(() => models.setThreadModel(ada.id, "private", "web/p", "chat", cloudRef)).toThrow(CloudModelForbidden);
    models.setLocalOnly(ada.id, "general", "web/g", true);
    expect(models.callContext(ada.id, "general", "web/g").localOnly).toBe(true);
    expect(() => models.setThreadModel(ada.id, "general", "web/g", "chat", cloudRef)).toThrow(CloudModelForbidden);
    expect(() => models.setLocalOnly(ada.id, "private", "web/p", false)).toThrow(CloudModelForbidden);
    expect(models.callContext(ada.id, "private", "web/p").localOnly).toBe(true);
    // Only local endpoints are offered there at all.
    expect(models.allowed(ctx({ pool: "private", localOnly: true })).map((a) => a.endpoint.id)).toEqual([gpu.id]);
    models.setColumnTask(ada.id, "private", "chat", localRef);
    expect(models.resolveModel("chat", ctx({ pool: "private", localOnly: true }))).toEqual(localRef);
  });

  it("refuses models that don't exist", async () => {
    const { models, ada } = await withModels();
    expect(() => models.setColumnTask(ada.id, "general", "chat", { offeringId: "nope" })).toThrow(NoModel);
  });

  it("gives a child thread its parent's limits and the tier's model", async () => {
    const { models, ada, cloudRef, localRef, ctx } = await withModels();
    models.setColumnTask(ada.id, "general", "subagent.cheap", localRef);
    models.setColumnTask(ada.id, "general", "subagent.strong", cloudRef);
    models.setColumnTask(ada.id, "private", "chat", localRef);
    models.setThreadModel(ada.id, "general", "web/p", "title", localRef);
    const parent = models.callContext(ada.id, "general", "web/p");

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
    expect(models.callContext(ada.id, "private", "web/c5").overrides).toEqual({});

    // A local-only parent's children are local-only.
    models.setLocalOnly(ada.id, "general", "web/lo", true);
    const lo = models.childContext(models.callContext(ada.id, "general", "web/lo"), "web/c6", { tier: "cheap" });
    expect(lo.localOnly).toBe(true);
    // It uses the private column, where strong falls back to the local chat model.
    expect(models.resolveModel("chat", models.childContext(models.callContext(ada.id, "general", "web/lo"), "web/c7", { tier: "strong" }))).toEqual(localRef);
  });
});

describe("presets", () => {
  it("the Private column can Save to only a private preset", async () => {
    const { models, ada, cloudRef, localRef } = await withModels();
    models.setColumnTask(ada.id, "general", "chat", cloudRef);
    const general = models.addPreset(ada.id, { name: "night", scope: "general" }, "general");
    expect(() => models.savePreset(ada.id, general.id, "private")).toThrow("the Private column can use only private presets");
    // A private preset accepts the Private column's table.
    models.setColumnTask(ada.id, "private", "chat", localRef);
    const localSetup = models.addPreset(ada.id, { name: "local-setup", scope: "private" }, "private");
    models.savePreset(ada.id, localSetup.id, "private");
    expect(models.column(ada.id, "private").preset?.id).toBe(localSetup.id);
  });

  it("keeps the legacy profile mirror in step with a thread's preset, and clears it when the preset goes", async () => {
    const { models, ada, users, cloudRef } = await withModels();
    models.setColumnTask(ada.id, "general", "chat", cloudRef);
    const mixed = models.addPreset(ada.id, { name: "mixed", scope: "general" }, "general");
    const other = models.addPreset(ada.id, { name: "other", scope: "general" }, "general");
    // Mark `mixed` as the migrated Mixed preset, as migration step 8 records it.
    const db = users.openUserDb(ada.id);
    set(db, "INSERT INTO settings (key, value) VALUES ('presets.mixed', ?)", mixed.id);
    db.close();
    const profile = (thread: string) => {
      const d = users.openUserDb(ada.id);
      const row = d.prepare("SELECT profile FROM thread_choices WHERE thread = ?").get(thread) as { profile: string | null } | undefined;
      d.close();
      return row?.profile ?? null;
    };
    models.setThreadPreset(ada.id, "general", "web/cloud", "builtin.cloud");
    models.setThreadPreset(ada.id, "general", "web/mixed", mixed.id);
    models.setThreadPreset(ada.id, "general", "web/other", other.id);
    expect(profile("web/cloud")).toBe("cloud");
    expect(profile("web/mixed")).toBe("custom");
    expect(profile("web/other")).toBeNull();
    models.removePreset(ada.id, mixed.id);
    expect([models.threadPreset(ada.id, "web/mixed"), profile("web/mixed")]).toEqual([null, null]);
  });
});



describe("coding task", () => {
  it("defaults new and saved presets to strong subagents, with an independent thread override", async () => {
    const { models, ada, localRef, cloudRef } = await withModels();
    models.setColumnTask(ada.id, "private", "chat", localRef);
    models.setColumnTask(ada.id, "private", "subagent.strong", localRef);
    const preset = models.addPreset(ada.id, { name: "Coding setup", scope: "private" }, "private");
    expect(preset.entries.code).toEqual({ same: "subagent.strong" });
    const ctx = models.callContext(ada.id, "private", "web/code");
    expect(models.resolveModel("code", ctx)).toEqual(models.resolveModel("subagent.strong", ctx));
    models.setThreadModel(ada.id, "general", "web/code", "chat", cloudRef);
    models.setColumnTask(ada.id, "general", "chat", localRef);
    expect(models.resolveModel("code", models.callContext(ada.id, "general", "web/code"))).toEqual(localRef);
    models.setColumnTask(ada.id, "general", "subagent.strong", localRef);
    const general = models.callContext(ada.id, "general", "web/code");
    expect(models.resolveModel("code", general)).toEqual(localRef);
    models.setThreadModel(ada.id, "general", "web/code", "code", cloudRef);
    expect(models.resolveModel("code", models.callContext(ada.id, "general", "web/code"))).toEqual(cloudRef);
  });
});
