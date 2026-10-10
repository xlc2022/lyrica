import { describe, expect, it } from "vitest";
import { CloudModelForbidden, NoModel, type CallContext } from "../src/index.ts";
import { deadUrl, fakeOpenAI } from "./fake-openai.ts";
import { profile, withModels } from "./helpers.ts";

/**
 * Li with: her own cloud endpoint (openrouter) and local one (gpu), a local
 * "blackwell" and a local "spare" serving the same model, and a cloud
 * "router2" serving it too. Bob is a second, non-administrator user.
 */
async function setup() {
  const m = await withModels();
  const { models, li } = m;
  const bob = await m.users.createUser("bob", "pw", profile("Bob"), { admin: false });
  await m.users.authenticate("bob", "pw");
  const add = async (name: string, kind: "local" | "cloud", list: Record<string, unknown>[], opts: { shared?: boolean } = {}) => {
    const server = await fakeOpenAI({ label: name, models: list });
    const ep = models.addEndpoint(li, { name, kind, baseUrl: server.baseUrl }, opts);
    const found = await models.discover(li, ep.id);
    return { server, ep, ref: { offeringId: found[0]!.id } };
  };
  const blackwell = await add("blackwell", "local", [{ id: "qwen3.8-27b", meta: { n_ctx: 131072 } }]);
  const spare = await add("spare", "local", [{ id: "Qwen3.8-27B-Q4_K_M.gguf", meta: { n_ctx: 8192 } }]);
  const router2 = await add("router2", "cloud", [{ id: "qwen/qwen3.8-27b", context_length: 131072, supported_parameters: ["tools", "reasoning"] }]);
  const ctx = (c: Partial<CallContext> = {}): CallContext => ({ userId: li.id, pool: "general", localOnly: false, ...c });
  return { ...m, bob, blackwell, spare, router2, ctx };
}

describe("ordered fallbacks", () => {
  it("uses the next model when the first one's machine is off, and records which answered and why", async () => {
    const s = await setup();
    const off = s.models.addEndpoint(s.li, { name: "off", kind: "local", baseUrl: await deadUrl() });
    const gone = { offeringId: s.models.addModel(s.li, off.id, { modelId: "qwen3.8-27b" }).id };
    s.models.setProfile(s.li.id, "local", "chat", [gone, s.blackwell.ref]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    // Without a probe, the first is tried; resolveLive probes it first because a fallback exists.
    expect(s.models.resolve("chat", priv).ref).toEqual(gone);
    const r = await s.models.resolveLive("chat", priv);
    expect(r.ref).toEqual(s.blackwell.ref);
    expect(r.skipped).toEqual([{ label: "off/qwen3.8-27b", reason: "off is down" }]);
    // The health cache now skips it without probing.
    expect(s.models.resolve("chat", priv).ref).toEqual(s.blackwell.ref);
    s.models.recordCall(s.li.id, { pool: "private", threadId: "web/p", task: "chat", resolution: r });
    const [call] = s.models.recentCalls(s.li.id);
    expect(call).toEqual({
      at: expect.any(String), pool: "private", threadId: "web/p", task: "chat", offeringId: s.blackwell.ref.offeringId,
      label: "blackwell/qwen3.8-27b", endpointName: "blackwell", kind: "local", fallback: "off/qwen3.8-27b was skipped (off is down), so blackwell/qwen3.8-27b answered",
    });
    // A call record holds labels and reasons, never text from the conversation.
    expect(Object.keys(call!).sort()).toEqual(["at", "endpointName", "fallback", "kind", "label", "offeringId", "pool", "task", "threadId"]);
  });

  it("refuses local and cloud lists that mix kinds; only Custom may, and only Custom falls back across the line", async () => {
    const s = await setup();
    expect(() => s.models.setProfile(s.li.id, "local", "chat", [s.blackwell.ref, s.router2.ref])).toThrow(CloudModelForbidden);
    expect(() => s.models.setProfile(s.li.id, "cloud", "chat", [s.router2.ref, s.blackwell.ref])).toThrow(/cloud models only/);
    s.models.setProfile(s.li.id, "custom", "chat", [s.blackwell.ref, s.router2.ref]);
    s.models.setProfile(s.li.id, "cloud", "chat", [s.router2.ref]);
    s.models.reportDown(s.blackwell.ep.id);
    // Custom crosses to cloud when the local model is away, and says so.
    const r = s.models.resolve("chat", s.ctx({ profile: "custom" }));
    expect(r.ref).toEqual(s.router2.ref);
    s.models.recordCall(s.li.id, { pool: "general", threadId: "web/g", task: "chat", resolution: r });
    expect(s.models.recentCalls(s.li.id)[0]!.fallback).toMatch(/so router2\/qwen\/qwen3.8-27b answered, a cloud model$/);
    // A thread's own list outside Custom keeps to one kind.
    expect(() => s.models.setThreadModel(s.li.id, "general", "web/t", "chat", [s.blackwell.ref, s.router2.ref])).toThrow(/can't mix/);
    // A group in a one-kind list needs a copy of that kind.
    const cloudGroup = s.models.addGroup(s.li, { name: "cloud qwen", members: [s.router2.ref.offeringId] });
    expect(() => s.models.setThreadModel(s.li.id, "general", "web/t", "chat", [s.blackwell.ref, { groupId: cloudGroup.id }])).toThrow(/no local copy/);
    s.models.setThreadModel(s.li.id, "general", "web/t", "chat", [s.blackwell.ref, s.spare.ref]);
    expect(s.models.resolveModel("chat", s.models.callContext(s.li.id, "general", "web/t"))).toEqual(s.spare.ref);
  });

  it("lets a task use another task's list, one level deep, and starts new profiles with titles and sleep following subagents", async () => {
    const s = await setup();
    s.models.setProfile(s.li.id, "local", "subagent.cheap", [s.spare.ref]);
    expect(s.models.profile(s.li.id, "local")).toMatchObject({
      "subagent.cheap": [s.spare.ref], title: { same: "subagent.cheap" }, compaction: { same: "subagent.cheap" }, "sleep.dream": { same: "subagent.strong" },
    });
    const priv = s.ctx({ pool: "private", localOnly: true });
    expect(s.models.resolveModel("title", priv)).toEqual(s.spare.ref);
    // strong has no list, so sleep follows chat, as before.
    s.models.setProfile(s.li.id, "local", "chat", [s.blackwell.ref]);
    expect(s.models.resolveModel("sleep.dream", priv)).toEqual(s.blackwell.ref);
    expect(() => s.models.setProfile(s.li.id, "local", "subagent.cheap", { same: "subagent.strong" })).toThrow(/one level deep/);
    expect(() => s.models.setProfile(s.li.id, "local", "chat", { same: "title" })).toThrow(/one level deep/);
    expect(() => s.models.setProfile(s.li.id, "local", "embedding", { same: "chat" })).toThrow(/same kind of model/);
    expect(() => s.models.setProfile(s.li.id, "local", "chat", { same: "chat" })).toThrow(/itself/);
  });

  it("keeps image tasks resolvable, to models that make or edit images, with no chat fallback", async () => {
    const s = await setup();
    s.models.setProfile(s.li.id, "local", "chat", [s.blackwell.ref]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    expect(() => s.models.resolveModel("image.create", priv)).toThrow(NoModel);
    const comfy = s.models.addModel(s.li, s.blackwell.ep.id, { modelId: "z-image", image: true });
    expect(() => s.models.setProfile(s.li.id, "local", "image.create", [s.blackwell.ref])).toThrow(/can't do image.create/);
    s.models.setProfile(s.li.id, "local", "image.create", [{ offeringId: comfy.id }]);
    expect(s.models.resolveModel("image.create", priv)).toEqual({ offeringId: comfy.id });
  });

  it("moves a cloud profile that named local models to Custom, once", async () => {
    const s = await setup();
    const db = s.users.openUserDb(s.bob.id);
    db.exec("CREATE TABLE IF NOT EXISTS model_profiles (profile TEXT NOT NULL, task TEXT NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (profile, task))");
    db.prepare("INSERT INTO model_profiles VALUES ('cloud', 'chat', ?)").run(JSON.stringify([s.blackwell.ref]));
    db.close();
    const lan = s.models.addEndpoint(s.li, { name: "lan", kind: "local", baseUrl: s.blackwell.ep.baseUrl }, { shared: true });
    const [shared] = await s.models.discover(s.li, lan.id);
    const db2 = s.users.openUserDb(s.bob.id);
    db2.prepare("UPDATE model_profiles SET entry = ? WHERE profile = 'cloud'").run(JSON.stringify([{ offeringId: shared!.id }]));
    db2.close();
    // A fresh Models, as after an upgrade.
    const { Models } = await import("../src/index.ts");
    const models = new Models(s.keyring, s.users);
    expect(models.profile(s.bob.id, "cloud")).toEqual({});
    expect(models.profile(s.bob.id, "custom")).toEqual({ chat: [{ offeringId: shared!.id }] });
    expect(models.defaultProfile(s.bob.id)).toBe("custom");
    expect(models.notice(s.bob.id)[0]).toMatch(/copied to the new custom profile/);
  });
});

describe("moving a cloud profile to Custom after a redirect", () => {
  it("follows a replacement made while the user was locked before deciding a model's kind", async () => {
    const s = await setup();
    const lan = s.models.addEndpoint(s.li, { name: "lan", kind: "local", baseUrl: s.blackwell.ep.baseUrl }, { shared: true });
    const lan2 = s.models.addEndpoint(s.li, { name: "lan2", kind: "local", baseUrl: s.spare.ep.baseUrl }, { shared: true });
    const [a] = await s.models.discover(s.li, lan.id);
    const [b] = await s.models.discover(s.li, lan2.id);
    const db = s.users.openUserDb(s.bob.id);
    db.exec("CREATE TABLE IF NOT EXISTS model_profiles (profile TEXT NOT NULL, task TEXT NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (profile, task))");
    db.prepare("INSERT OR REPLACE INTO model_profiles (profile, task, entry) VALUES ('cloud', 'chat', ?)").run(JSON.stringify([{ offeringId: a!.id }]));
    db.prepare("DELETE FROM settings WHERE key = 'profiles_v2'").run();
    db.close();
    s.keyring.lockUser(s.bob.id);
    s.models.replace(s.li, a!.id, b!.id);
    await s.users.authenticate("bob", "pw");
    const { Models } = await import("../src/index.ts");
    const fresh = new Models(s.keyring, s.users);
    expect(fresh.profile(s.bob.id, "custom").chat).toEqual([{ offeringId: b!.id }]);
    expect(fresh.profile(s.bob.id, "cloud").chat).toBeUndefined();
  });
});

describe("the custom profile", () => {
  it("is never used by a private or local-only thread, even as the user's default", async () => {
    const s = await setup();
    s.models.setDefaultProfile(s.li.id, "custom");
    s.models.setProfile(s.li.id, "custom", "chat", [s.router2.ref, s.blackwell.ref]);
    expect(s.models.resolveModel("chat", s.models.callContext(s.li.id, "general", "web/g"))).toEqual(s.router2.ref);
    for (const call of [s.models.callContext(s.li.id, "private", "web/p"), (s.models.setLocalOnly(s.li.id, "general", "web/lo", true), s.models.callContext(s.li.id, "general", "web/lo"))]) {
      expect(() => s.models.resolve("chat", call)).toThrow(/no model is set for chat in the local profile/);
      // Even handed a custom profile directly, the context is local.
      expect(() => s.models.resolve("chat", { ...call, profile: "custom" })).toThrow(/local profile/);
    }
    expect(() => s.models.setThreadProfile(s.li.id, "private", "web/p", "custom")).toThrow(CloudModelForbidden);
    // A general thread can switch back to cloud.
    s.models.setProfile(s.li.id, "cloud", "chat", [s.router2.ref]);
    s.models.setThreadProfile(s.li.id, "general", "web/c", "cloud");
    expect(s.models.callContext(s.li.id, "general", "web/c").profile).toBe("cloud");
  });
});

describe("model groups", () => {
  it("expands in place, in order, and fails over through its members", async () => {
    const s = await setup();
    const g = s.models.addGroup(s.li, { name: "Qwen 3.8 27B", members: [s.blackwell.ref.offeringId, s.spare.ref.offeringId, s.localRef.offeringId] });
    s.models.setProfile(s.li.id, "local", "chat", [{ groupId: g.id }]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    expect(s.models.resolveModel("chat", priv)).toEqual(s.blackwell.ref);
    s.models.reportDown(s.blackwell.ep.id);
    expect(s.models.resolveModel("chat", priv)).toEqual(s.spare.ref);
    s.models.reportDown(s.spare.ep.id);
    expect(s.models.resolveModel("chat", priv)).toEqual(s.localRef);
    expect(() => s.models.addGroup(s.li, { name: "x", members: [s.blackwell.ref.offeringId, s.models.addModel(s.li, s.blackwell.ep.id, { modelId: "other" }).id] })).toThrow(/one copy per endpoint/);
  });

  it("skips a member that can't handle the call", async () => {
    const s = await setup();
    s.models.setCapabilities(s.li, s.blackwell.ref.offeringId, { tools: false });
    const g = s.models.addGroup(s.li, { name: "Qwen", members: [s.blackwell.ref.offeringId, s.spare.ref.offeringId, s.localRef.offeringId] });
    s.models.setProfile(s.li.id, "local", "chat", [{ groupId: g.id }]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    const r = s.models.resolve("chat", priv, { tools: true, tokens: 20_000 });
    expect(r.ref).toEqual(s.localRef);
    expect(r.skipped.map((x) => x.reason)).toEqual(["it can't use tools", "its context window (8192 tokens) is smaller than the conversation"]);
  });

  it("never gives a private thread a group's cloud member", async () => {
    const s = await setup();
    const g = s.models.addGroup(s.li, { name: "Qwen anywhere", members: [s.router2.ref.offeringId, s.blackwell.ref.offeringId] });
    s.models.setProfile(s.li.id, "local", "chat", [{ groupId: g.id }]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    expect(s.models.resolveModel("chat", priv)).toEqual(s.blackwell.ref);
    s.models.reportDown(s.blackwell.ep.id);
    expect(() => s.models.resolveModel("chat", priv)).toThrow(NoModel);
    // Handed in as an override, the same.
    expect(() => s.models.resolveModel("chat", { ...priv, overrides: { chat: [{ groupId: g.id }] } })).toThrow(NoModel);
    // A group with no local copy can't go in a local list at all.
    const cloudOnly = s.models.addGroup(s.li, { name: "cloud only", members: [s.router2.ref.offeringId] });
    expect(() => s.models.setProfile(s.li.id, "local", "chat", [{ groupId: cloudOnly.id }])).toThrow(CloudModelForbidden);
    expect(() => s.models.setThreadModel(s.li.id, "private", "web/p", "chat", [{ groupId: cloudOnly.id }])).toThrow(CloudModelForbidden);
    // Its detail warns that it mixes kinds.
    expect(s.models.groupDetail(s.li.id, g.id).warnings).toContain("It mixes local and cloud copies, so as a whole it can only be used in the Custom profile; elsewhere only the copies of the right kind are used.");
  });

  it("drops a member removed while its user was locked, when they unlock; an empty group is flagged in Clean up", async () => {
    const s = await setup();
    const lan = s.models.addEndpoint(s.li, { name: "lan", kind: "local", baseUrl: s.blackwell.ep.baseUrl }, { shared: true });
    const lan2 = s.models.addEndpoint(s.li, { name: "lan2", kind: "local", baseUrl: s.spare.ep.baseUrl }, { shared: true });
    const [a] = await s.models.discover(s.li, lan.id);
    const [b] = await s.models.discover(s.li, lan2.id);
    const mine = s.models.addGroup(s.bob, { name: "Qwen", members: [a!.id, b!.id] });
    const shared = s.models.addGroup(s.li, { name: "Shared Qwen", members: [a!.id] }, { shared: true });
    expect(() => s.models.addGroup(s.bob, { name: "nope", members: [a!.id] }, { shared: true })).toThrow(/administrator/);
    expect(() => s.models.addGroup(s.li, { name: "nope", members: [s.localRef.offeringId] }, { shared: true })).toThrow(/shared models only/);
    s.keyring.lockUser(s.bob.id);
    s.models.removeEndpoint(s.li, lan.id);
    // Shared groups change at once.
    expect(s.models.group(s.li.id, shared.id)!.members).toEqual([]);
    expect(s.models.cleanup(s.li.id).map((c) => c.label)).toContain("shared.Shared Qwen");
    await s.users.authenticate("bob", "pw");
    expect(s.models.group(s.bob.id, mine.id)!.members).toEqual([b!.id]);
    expect(s.models.notice(s.bob.id)).toEqual(["shared.lan/qwen3.8-27b was removed in the group Qwen."]);
  });

  it("suggests groups but never makes them, and removing one tidies lists", async () => {
    const s = await setup();
    const suggested = s.models.groupSuggestions(s.li.id);
    expect(suggested).toContainEqual({ name: "qwen3.8-27b", members: expect.arrayContaining([s.blackwell.ref.offeringId, s.spare.ref.offeringId, s.localRef.offeringId]), strength: "weak" });
    // The cloud copy is never suggested with the local ones.
    expect(suggested.some((x) => x.members.includes(s.router2.ref.offeringId) && x.members.includes(s.blackwell.ref.offeringId))).toBe(false);
    expect(s.models.groups(s.li.id)).toEqual([]);
    const g = s.models.addGroup(s.li, { name: "Qwen", members: [s.blackwell.ref.offeringId, s.spare.ref.offeringId, s.localRef.offeringId] });
    expect(s.models.groupSuggestions(s.li.id).some((x) => x.members.includes(s.blackwell.ref.offeringId))).toBe(false);
    expect(s.models.groupDetail(s.li.id, g.id).warnings).toContain("Its copies differ in context window.");
    s.models.setProfile(s.li.id, "local", "chat", [{ groupId: g.id }, s.localRef]);
    s.models.removeGroup(s.li, g.id);
    expect(s.models.profile(s.li.id, "local").chat).toEqual([s.localRef]);
  });
});

describe("thinking", () => {
  it("runs a model at the level asked when it offers it, and says so when it can't", async () => {
    const s = await setup();
    const think = s.models.resolve("chat", { ...s.ctx(), overrides: { chat: [s.router2.ref] } });
    expect(think.offering.reasoning).toEqual(["low", "medium", "high"]);
    expect(s.models.thinkingFor(think, "high")).toEqual({ level: "high" });
    const plain = s.models.resolve("chat", { ...s.ctx(), overrides: { chat: [s.blackwell.ref] } });
    expect(s.models.thinkingFor(plain, "medium")).toEqual({ level: "off", note: "blackwell/qwen3.8-27b can't think, so it answered without thinking" });
    s.models.setCapabilities(s.li, s.blackwell.ref.offeringId, { reasoning: ["high"] });
    const some = s.models.resolve("chat", { ...s.ctx(), overrides: { chat: [s.blackwell.ref] } });
    expect(s.models.thinkingFor(some, "low")).toEqual({ level: "high", note: "blackwell/qwen3.8-27b doesn't think at low, so it thought at high" });
    // Per thread, with a per-user default.
    s.models.setDefaultThinking(s.li.id, "medium");
    expect(s.models.callContext(s.li.id, "general", "web/t").thinking).toBe("medium");
    s.models.setThinking(s.li.id, "web/t", "off");
    expect(s.models.callContext(s.li.id, "general", "web/t").thinking).toBe("off");
  });
});
