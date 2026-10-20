import { describe, expect, it } from "vitest";
import { CloudModelForbidden, HostRefused, isUnreachable, NoModel, Offline, type CallContext } from "../src/index.ts";
import { deadUrl, fakeOpenAI } from "./fake-openai.ts";
import { profile, withModels } from "./helpers.ts";

/**
 * Ada with: her own cloud endpoint (openrouter) and local one (gpu), a local
 * "blackwell" and a local "spare" serving the same model, and a cloud
 * "router2" serving it too. Bob is a second, non-administrator user.
 */
async function setup() {
  const m = await withModels();
  const { models, ada } = m;
  const bob = await m.users.createUser("bob", "pw", profile("Bob"), { admin: false });
  await m.users.authenticate("bob", "pw");
  const add = async (name: string, kind: "local" | "cloud", list: Record<string, unknown>[], opts: { shared?: boolean } = {}) => {
    const server = await fakeOpenAI({ label: name, models: list });
    const ep = models.addEndpoint(ada, { name, kind, baseUrl: server.baseUrl }, opts);
    const found = await models.discover(ada, ep.id);
    return { server, ep, ref: { offeringId: found[0]!.id } };
  };
  const blackwell = await add("blackwell", "local", [{ id: "qwen3.8-27b", meta: { n_ctx: 131072 } }]);
  const spare = await add("spare", "local", [{ id: "Qwen3.8-27B-Q4_K_M.gguf", meta: { n_ctx: 8192 } }]);
  const router2 = await add("router2", "cloud", [{ id: "qwen/qwen3.8-27b", context_length: 131072, supported_parameters: ["tools", "reasoning"] }]);
  const ctx = (c: Partial<CallContext> = {}): CallContext => ({ userId: ada.id, pool: "general", localOnly: false, ...c });
  return { ...m, bob, blackwell, spare, router2, ctx };
}

describe("ordered fallbacks", () => {
  it("uses the next model when the first one's machine is off, and records which answered and why", async () => {
    const s = await setup();
    const off = s.models.addEndpoint(s.ada, { name: "off", kind: "local", baseUrl: await deadUrl() });
    const gone = { offeringId: s.models.addModel(s.ada, off.id, { modelId: "qwen3.8-27b" }).id };
    s.models.setColumnTask(s.ada.id, "private", "chat", [gone, s.blackwell.ref]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    // Without a probe, the first is tried; resolveLive probes it first because a fallback exists.
    expect(s.models.resolve("chat", priv).ref).toEqual(gone);
    const r = await s.models.resolveLive("chat", priv);
    expect(r.ref).toEqual(s.blackwell.ref);
    expect(r.skipped).toEqual([{ label: "off/qwen3.8-27b", reason: "off is down" }]);
    // The health cache now skips it without probing.
    expect(s.models.resolve("chat", priv).ref).toEqual(s.blackwell.ref);
    s.models.recordCall(s.ada.id, { pool: "private", threadId: "web/p", task: "chat", resolution: r });
    const [call] = s.models.recentCalls(s.ada.id);
    expect(call).toEqual({
      at: expect.any(String), pool: "private", threadId: "web/p", task: "chat", offeringId: s.blackwell.ref.offeringId,
      label: "blackwell/qwen3.8-27b", endpointName: "blackwell", kind: "local", fallback: "off/qwen3.8-27b was skipped (off is down), so blackwell/qwen3.8-27b answered",
    });
    // A call record holds labels and reasons, never text from the conversation.
    expect(Object.keys(call!).sort()).toEqual(["at", "endpointName", "fallback", "kind", "label", "offeringId", "pool", "task", "threadId"]);
  });

  it("refuses cloud models in the Private column; a general Custom table mixes kinds and falls back across the line", async () => {
    const s = await setup();
    expect(() => s.models.setColumnTask(s.ada.id, "private", "chat", [s.blackwell.ref, s.router2.ref])).toThrow(CloudModelForbidden);
    s.models.setColumnTask(s.ada.id, "general", "chat", [s.blackwell.ref, s.router2.ref]);
    s.models.reportDown(s.blackwell.ep.id);
    // A Custom general column crosses to cloud when the local model is away, and says so.
    const r = s.models.resolve("chat", s.ctx());
    expect(r.ref).toEqual(s.router2.ref);
    s.models.recordCall(s.ada.id, { pool: "general", threadId: "web/g", task: "chat", resolution: r });
    expect(s.models.recentCalls(s.ada.id)[0]!.fallback).toMatch(/so router2\/qwen\/qwen3.8-27b answered, a cloud model$/);
    // A private thread's own list refuses a cloud model, named or in a group.
    expect(() => s.models.setThreadModel(s.ada.id, "private", "web/t", "chat", [s.router2.ref])).toThrow(CloudModelForbidden);
    const cloudGroup = s.models.addGroup(s.ada, { name: "cloud qwen", members: [s.router2.ref.offeringId] });
    expect(() => s.models.setThreadModel(s.ada.id, "private", "web/t", "chat", [{ groupId: cloudGroup.id }])).toThrow(/no local copy/);
    // A general thread's own list mixes kinds freely.
    const localGroup = s.models.addGroup(s.ada, { name: "local qwen", members: [s.blackwell.ref.offeringId] });
    s.models.setThreadModel(s.ada.id, "general", "web/t", "chat", [{ groupId: localGroup.id }, { groupId: cloudGroup.id }]);
    s.models.setThreadModel(s.ada.id, "general", "web/t", "chat", [s.blackwell.ref, s.spare.ref]);
    expect(s.models.resolveModel("chat", s.models.callContext(s.ada.id, "general", "web/t"))).toEqual(s.spare.ref);
  });

  it("lets a task use another task's list, one level deep, and starts new columns with titles and sleep following subagents", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "private", "subagent.cheap", [s.spare.ref]);
    expect(s.models.column(s.ada.id, "private").entries).toMatchObject({
      "subagent.cheap": [s.spare.ref], title: { same: "subagent.cheap" }, compaction: { same: "subagent.cheap" }, "sleep.dream": { same: "subagent.strong" },
    });
    const priv = s.ctx({ pool: "private", localOnly: true });
    expect(s.models.resolveModel("title", priv)).toEqual(s.spare.ref);
    // strong has no list, so sleep follows chat, as before.
    s.models.setColumnTask(s.ada.id, "private", "chat", [s.blackwell.ref]);
    expect(s.models.resolveModel("sleep.dream", priv)).toEqual(s.blackwell.ref);
    expect(() => s.models.setColumnTask(s.ada.id, "private", "subagent.cheap", { same: "subagent.strong" })).toThrow(/one level deep/);
    expect(() => s.models.setColumnTask(s.ada.id, "private", "chat", { same: "title" })).toThrow(/one level deep/);
    expect(() => s.models.setColumnTask(s.ada.id, "private", "embedding", { same: "chat" })).toThrow(/same kind of model/);
    expect(() => s.models.setColumnTask(s.ada.id, "private", "chat", { same: "chat" })).toThrow(/itself/);
    expect(s.models.resolveModel("watching", priv)).toEqual(s.spare.ref);
  });

  it("has a column made before the Watching task follow cheap subagents for it, until it has a list of its own", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "private", "chat", [s.blackwell.ref]);
    s.models.setColumnTask(s.ada.id, "private", "subagent.cheap", [s.spare.ref]);
    // As a column stored by an older release: no entry for watching.
    const db = s.users.openUserDb(s.ada.id);
    const row = db.prepare("SELECT entries FROM model_columns WHERE column = 'private'").get() as { entries: string };
    const table = JSON.parse(row.entries) as Record<string, unknown>;
    delete table.watching;
    db.prepare("UPDATE model_columns SET entries = ? WHERE column = 'private'").run(JSON.stringify(table));
    db.close();
    const priv = s.ctx({ pool: "private", localOnly: true });
    expect(s.models.column(s.ada.id, "private").entries.watching).toEqual({ same: "subagent.cheap" });
    expect(s.models.resolveModel("watching", priv)).toEqual(s.spare.ref);
    s.models.setColumnTask(s.ada.id, "private", "watching", [s.blackwell.ref]);
    expect(s.models.resolveModel("watching", priv)).toEqual(s.blackwell.ref);
  });

  it("keeps image tasks resolvable, to models that make or edit images, with no chat fallback", async () => {
    const s = await setup();
    const other = { offeringId: s.models.addModel(s.ada, s.blackwell.ep.id, { modelId: "other-model" }).id };
    s.models.setColumnTask(s.ada.id, "private", "chat", [other]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    expect(() => s.models.resolveModel("image.create", priv)).toThrow(NoModel);
    const comfy = s.models.addModel(s.ada, s.blackwell.ep.id, { modelId: "z-image", image: true });
    expect(() => s.models.setColumnTask(s.ada.id, "private", "image.create", [s.blackwell.ref])).toThrow(/can't do image.create/);
    s.models.setColumnTask(s.ada.id, "private", "image.create", [{ offeringId: comfy.id }]);
    expect(s.models.resolveModel("image.create", priv)).toEqual({ offeringId: comfy.id });
  });
});

describe("a general column's table", () => {
  it("is never used by a private or local-only thread, even once the column is Custom", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "general", "chat", [s.router2.ref, s.blackwell.ref]);
    expect(s.models.resolveModel("chat", s.models.callContext(s.ada.id, "general", "web/g"))).toEqual(s.router2.ref);
    for (const call of [s.models.callContext(s.ada.id, "private", "web/p"), (s.models.setLocalOnly(s.ada.id, "general", "web/lo", true), s.models.callContext(s.ada.id, "general", "web/lo"))]) {
      expect(() => s.models.resolve("chat", call)).toThrow(/no model is set for Main conversation in Local/);
    }
    expect(() => s.models.setThreadPreset(s.ada.id, "private", "web/p", "builtin.cloud")).toThrow(CloudModelForbidden);
    // A general thread can switch back to the Cloud preset.
    s.models.setColumnTask(s.ada.id, "general", "chat", [s.router2.ref]);
    s.models.setThreadPreset(s.ada.id, "general", "web/c", "builtin.cloud");
    expect(s.models.callContext(s.ada.id, "general", "web/c").preset).toBe("builtin.cloud");
  });

  it("ignores a general preset a thread chose once it becomes local-only or moves to the private pool, using the Private column without throwing", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "private", "chat", [s.blackwell.ref]);
    s.models.setThreadPreset(s.ada.id, "general", "web/g", "builtin.cloud");
    expect(s.models.callContext(s.ada.id, "general", "web/g").preset).toBe("builtin.cloud");
    // Made local-only later: the choice is ignored, the Private column answers.
    s.models.setLocalOnly(s.ada.id, "general", "web/g", true);
    expect(s.models.resolveModel("chat", s.models.callContext(s.ada.id, "general", "web/g"))).toEqual(s.blackwell.ref);
    // Moved to the private pool: the stored choice is still ignored, the Private column answers.
    const moved = s.models.callContext(s.ada.id, "private", "web/g");
    expect(moved.preset).toBe("builtin.cloud");
    expect(s.models.resolveModel("chat", moved)).toEqual(s.blackwell.ref);
  });
});

describe("model groups", () => {
  it("expands in place, in order, and fails over through its members", async () => {
    const s = await setup();
    const g = s.models.addGroup(s.ada, { name: "Qwen 3.8 27B", members: [s.blackwell.ref.offeringId, s.spare.ref.offeringId, s.localRef.offeringId] });
    s.models.setColumnTask(s.ada.id, "private", "chat", [{ groupId: g.id }]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    expect(s.models.resolveModel("chat", priv)).toEqual(s.blackwell.ref);
    s.models.reportDown(s.blackwell.ep.id);
    expect(s.models.resolveModel("chat", priv)).toEqual(s.spare.ref);
    s.models.reportDown(s.spare.ep.id);
    expect(s.models.resolveModel("chat", priv)).toEqual(s.localRef);
    expect(() => s.models.addGroup(s.ada, { name: "x", members: [s.blackwell.ref.offeringId, s.models.addModel(s.ada, s.blackwell.ep.id, { modelId: "other" }).id] })).toThrow(/one copy per endpoint/);
  });

  it("skips a member that can't handle the call", async () => {
    const s = await setup();
    s.models.setCapabilities(s.ada, s.blackwell.ref.offeringId, { tools: false });
    const g = s.models.addGroup(s.ada, { name: "Qwen", members: [s.blackwell.ref.offeringId, s.spare.ref.offeringId, s.localRef.offeringId] });
    s.models.setColumnTask(s.ada.id, "private", "chat", [{ groupId: g.id }]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    const r = s.models.resolve("chat", priv, { tools: true, tokens: 20_000 });
    expect(r.ref).toEqual(s.localRef);
    expect(r.skipped.map((x) => x.reason)).toEqual(["it can't use tools", "its context window (8192 tokens) is smaller than the conversation"]);
  });

  it("never gives a private thread a group's cloud member", async () => {
    const s = await setup();
    const g = s.models.addGroup(s.ada, { name: "Qwen anywhere", members: [s.router2.ref.offeringId, s.blackwell.ref.offeringId] });
    s.models.setColumnTask(s.ada.id, "private", "chat", [{ groupId: g.id }]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    expect(s.models.resolveModel("chat", priv)).toEqual(s.blackwell.ref);
    s.models.reportDown(s.blackwell.ep.id);
    expect(() => s.models.resolveModel("chat", priv)).toThrow(NoModel);
    // Handed in as an override, the same.
    expect(() => s.models.resolveModel("chat", { ...priv, overrides: { chat: [{ groupId: g.id }] } })).toThrow(NoModel);
    // A group with no local copy can't go in a local list at all.
    const cloudOnly = s.models.addGroup(s.ada, { name: "cloud only", members: [s.router2.ref.offeringId] });
    expect(() => s.models.setColumnTask(s.ada.id, "private", "chat", [{ groupId: cloudOnly.id }])).toThrow(CloudModelForbidden);
    expect(() => s.models.setThreadModel(s.ada.id, "private", "web/p", "chat", [{ groupId: cloudOnly.id }])).toThrow(CloudModelForbidden);
    // Its detail warns that it mixes kinds.
    expect(s.models.groupDetail(s.ada.id, g.id).warnings).toContain("It mixes local and cloud copies, so as a whole it can only be used in a general preset or a Custom column; elsewhere only the copies of the right kind are used.");
  });

  it("drops a member removed while its user was locked, when they unlock; an empty group is flagged in Clean up", async () => {
    const s = await setup();
    const lan = s.models.addEndpoint(s.ada, { name: "lan", kind: "local", baseUrl: s.blackwell.ep.baseUrl }, { shared: true });
    const lan2 = s.models.addEndpoint(s.ada, { name: "lan2", kind: "local", baseUrl: s.spare.ep.baseUrl }, { shared: true });
    const [a] = await s.models.discover(s.ada, lan.id);
    const [b] = await s.models.discover(s.ada, lan2.id);
    const mine = s.models.addGroup(s.bob, { name: "Qwen", members: [a!.id, b!.id] });
    const shared = s.models.addGroup(s.ada, { name: "Shared Qwen", members: [a!.id] }, { shared: true });
    expect(() => s.models.addGroup(s.bob, { name: "nope", members: [a!.id] }, { shared: true })).toThrow(/administrator/);
    expect(() => s.models.addGroup(s.ada, { name: "nope", members: [s.localRef.offeringId] }, { shared: true })).toThrow(/shared models only/);
    s.keyring.lockUser(s.bob.id);
    s.models.removeEndpoint(s.ada, lan.id);
    // Shared groups change at once.
    expect(s.models.group(s.ada.id, shared.id)!.members).toEqual([]);
    expect(s.models.cleanup(s.ada.id).map((c) => c.label)).toContain("shared.Shared Qwen");
    await s.users.authenticate("bob", "pw");
    expect(s.models.group(s.bob.id, mine.id)!.members).toEqual([b!.id]);
    expect(s.models.notice(s.bob.id)).toEqual(["shared.lan/qwen3.8-27b was removed in the group Qwen."]);
  });

  it("suggests groups but never makes them, and removing one tidies lists", async () => {
    const s = await setup();
    const suggested = s.models.groupSuggestions(s.ada.id);
    expect(suggested).toContainEqual({ name: "qwen3.8-27b", members: expect.arrayContaining([s.blackwell.ref.offeringId, s.spare.ref.offeringId, s.localRef.offeringId]), strength: "weak" });
    // The cloud copy is never suggested with the local ones.
    expect(suggested.some((x) => x.members.includes(s.router2.ref.offeringId) && x.members.includes(s.blackwell.ref.offeringId))).toBe(false);
    expect(s.models.groups(s.ada.id)).toEqual([]);
    const g = s.models.addGroup(s.ada, { name: "Qwen", members: [s.blackwell.ref.offeringId, s.spare.ref.offeringId, s.localRef.offeringId] });
    expect(s.models.groupSuggestions(s.ada.id).some((x) => x.members.includes(s.blackwell.ref.offeringId))).toBe(false);
    expect(s.models.groupDetail(s.ada.id, g.id).warnings).toContain("Its copies differ in context window.");
    s.models.setColumnTask(s.ada.id, "private", "chat", [{ groupId: g.id }, s.localRef]);
    s.models.removeGroup(s.ada, g.id);
    expect(s.models.column(s.ada.id, "private").entries.chat).toEqual([s.localRef]);
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
    // The default level, chosen by nobody, isn't worth a note.
    expect(s.models.thinkingFor(plain, "medium", true)).toEqual({ level: "off" });
    s.models.setCapabilities(s.ada, s.blackwell.ref.offeringId, { reasoning: ["medium", "high"] });
    const some = s.models.resolve("chat", { ...s.ctx(), overrides: { chat: [s.blackwell.ref] } });
    expect(s.models.thinkingFor(some, "low")).toEqual({ level: "medium", note: "blackwell/qwen3.8-27b doesn't think at low, so it thought at medium" });
    // One level on a plain endpoint still says so; a host's on/off switch (one level) is just on.
    s.models.setCapabilities(s.ada, s.blackwell.ref.offeringId, { reasoning: ["medium"] });
    const one = s.models.resolve("chat", { ...s.ctx(), overrides: { chat: [s.blackwell.ref] } });
    expect(s.models.thinkingFor(one, "high")).toEqual({ level: "medium", note: "blackwell/qwen3.8-27b doesn't think at high, so it thought at medium" });
    expect(s.models.thinkingFor({ ...one, endpoint: { ...one.endpoint, api: "host" } }, "high")).toEqual({ level: "medium" });
    // Off is off, unless the model's provider refused it: then medium, or the nearest level it has, with a note.
    s.models.setCapabilities(s.ada, s.blackwell.ref.offeringId, { reasoning: ["high", "medium"] });
    const must = s.models.resolve("chat", { ...s.ctx(), overrides: { chat: [s.blackwell.ref] } });
    expect(s.models.thinkingFor(must, "off")).toEqual({ level: "off" });
    s.models.mustThink(must.offering.id);
    expect(s.models.thinkingFor(must, "off")).toEqual({ level: "medium", note: "blackwell/qwen3.8-27b can't turn thinking off, so it thought at medium" });
    s.models.setCapabilities(s.ada, s.blackwell.ref.offeringId, { reasoning: ["high"] });
    const high = s.models.resolve("chat", { ...s.ctx(), overrides: { chat: [s.blackwell.ref] } });
    expect(s.models.thinkingFor(high, "off")).toEqual({ level: "high", note: "blackwell/qwen3.8-27b can't turn thinking off, so it thought at high" });
    // Per thread, with a per-user default that starts at medium.
    expect(s.models.defaultThinking(s.ada.id)).toBe("medium");
    expect(s.models.callContext(s.ada.id, "general", "web/t")).toMatchObject({ thinking: "medium", thinkingUnset: true });
    s.models.setDefaultThinking(s.ada.id, "high");
    expect(s.models.callContext(s.ada.id, "general", "web/t").thinking).toBe("high");
    expect(s.models.callContext(s.ada.id, "general", "web/t").thinkingUnset).toBeUndefined();
    s.models.setThinking(s.ada.id, "web/t", "off");
    expect(s.models.callContext(s.ada.id, "general", "web/t").thinking).toBe("off");
  });
});

describe("every model away", () => {
  it("is Offline, not NoModel's unset, and a machine that comes back answers the next call", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "private", "chat", [s.blackwell.ref, s.spare.ref]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    s.models.reportDown(s.blackwell.ep.id);
    s.models.reportDown(s.spare.ep.id);
    const err = (() => { try { s.models.resolve("chat", priv); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(Offline);
    expect(err).toBeInstanceOf(NoModel);
    expect((err as Offline).tried).toEqual([
      { label: "blackwell/qwen3.8-27b", reason: "blackwell is down" }, { label: "spare/Qwen3.8-27B-Q4_K_M.gguf", reason: "spare is down" },
    ]);
    // Both are actually up again: resolveLive asks rather than trusting the cache, in list order.
    expect((await s.models.resolveLive("chat", priv)).ref).toEqual(s.blackwell.ref);
    // Unfit for the call is NoModel, never Offline.
    const unfit = (() => { try { s.models.resolve("chat", priv, { tokens: 200_000 }); } catch (e) { return e; } })();
    expect(unfit).toBeInstanceOf(NoModel);
    expect(unfit).not.toBeInstanceOf(Offline);
  });

  it("falls back through a call's models and names every one tried when none answers", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "private", "title", [s.blackwell.ref, s.spare.ref]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { name: "TypeError" });
    const seen: string[] = [];
    const out = await s.models.callWithFallback("title", priv, {}, async (r) => {
      seen.push(r.label);
      if (r.endpoint.name === "blackwell") throw new TypeError("fetch failed", { cause: refused });
      return "ok";
    });
    expect([out, seen]).toEqual(["ok", ["blackwell/qwen3.8-27b", "spare/Qwen3.8-27B-Q4_K_M.gguf"]]);
    // The model's own refusal isn't a reason to try the next one.
    await expect(s.models.callWithFallback("title", priv, {}, async () => { throw new Error("400 bad request"); })).rejects.toThrow("400 bad request");
    // Both machines answer probes but every call fails: Offline, once round, never a loop.
    const all = await s.models.callWithFallback("title", priv, {}, async () => { throw refused; }).catch((e: unknown) => e);
    expect(all).toBeInstanceOf(Offline);
    expect((all as Offline).task).toBe("title");
    expect((all as Offline).tried.map((t) => t.label).sort()).toEqual(["blackwell/qwen3.8-27b", "spare/Qwen3.8-27B-Q4_K_M.gguf"]);
  });

  it("passes over one model its host couldn't run, keeping the host's other models", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "private", "title", [s.blackwell.ref, s.spare.ref]);
    const other = { offeringId: s.models.addModel(s.ada, s.blackwell.ep.id, { modelId: "other-model" }).id };
    s.models.setColumnTask(s.ada.id, "private", "chat", [other]);
    const priv = s.ctx({ pool: "private", localOnly: true });
    const seen: string[] = [];
    await s.models.callWithFallback("title", priv, {}, async (r) => {
      seen.push(r.label);
      if (r.endpoint.name === "blackwell") throw new HostRefused("model_unavailable", "the model isn't loaded");
      return "ok";
    });
    expect(seen).toEqual(["blackwell/qwen3.8-27b", "spare/Qwen3.8-27B-Q4_K_M.gguf"]);
    expect(s.models.resolve("title", priv).ref).toEqual(s.spare.ref);
    expect(s.models.resolve("chat", priv).ref).toEqual(other);
  });

  it("tells a machine that's away from a model that refused", () => {
    expect(isUnreachable("Connection error.")).toBe(true);
    expect(isUnreachable("terminated")).toBe(true);
    expect(isUnreachable(new HostRefused("paused", "paused"))).toBe(true);
    expect(isUnreachable(new HostRefused("not_found", "no such model"))).toBe(false);
    expect(isUnreachable(Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }))).toBe(true);
    expect(isUnreachable(new Error("400 context length exceeded"))).toBe(false);
    expect(isUnreachable("The client disconnected before the tool could connect to the sandbox")).toBe(false);
    expect(isUnreachable("connect ECONNREFUSED 10.0.0.2:8080")).toBe(true);
  });
});

describe("Fallback off", () => {
  it("lets only the list's first entry answer: a machine away is Offline, an unfit model a plain NoModel", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "private", "chat", [s.blackwell.ref, s.spare.ref]);
    const priv = s.ctx({ pool: "private", localOnly: true, fallback: false });
    expect(s.models.resolve("chat", priv).ref).toEqual(s.blackwell.ref);
    s.models.reportDown(s.blackwell.ep.id);
    const away = (() => { try { s.models.resolve("chat", priv); } catch (e) { return e; } })();
    expect(away).toBeInstanceOf(Offline);
    expect((away as Offline).tried.map((t) => t.label)).toEqual(["blackwell/qwen3.8-27b"]);
    // With it on, the same list falls back.
    expect(s.models.resolve("chat", { ...priv, fallback: true }).ref).toEqual(s.spare.ref);
    s.models.setCapabilities(s.ada, s.blackwell.ref.offeringId, { tools: false });
    s.models.reportUp(s.ada.id, s.blackwell.ep.id);
    expect(() => s.models.resolve("chat", priv, { tools: true })).toThrow(/can't use tools\), and Fallback is off$/);
    // A call that fails on the first model is never retried on the next.
    s.models.setCapabilities(s.ada, s.blackwell.ref.offeringId, { tools: null });
    const seen: string[] = [];
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { name: "TypeError" });
    const out = await s.models.callWithFallback("title", priv, {}, async (r) => { seen.push(r.label); throw refused; }).catch((e: unknown) => e);
    expect(out).toBeInstanceOf(Offline);
    expect(seen).toEqual(["blackwell/qwen3.8-27b"]);
  });

  it("keeps a group's copies when the group is the first entry", async () => {
    const s = await setup();
    const g = s.models.addGroup(s.ada, { name: "Qwen", members: [s.blackwell.ref.offeringId, s.spare.ref.offeringId] });
    s.models.setColumnTask(s.ada.id, "private", "chat", [{ groupId: g.id }, s.localRef]);
    const priv = s.ctx({ pool: "private", localOnly: true, fallback: false });
    s.models.reportDown(s.blackwell.ep.id);
    expect(s.models.resolve("chat", priv).ref).toEqual(s.spare.ref);
    s.models.reportDown(s.spare.ep.id);
    expect(() => s.models.resolve("chat", priv)).toThrow(Offline);
  });

  it("is on by default, set per thread or as the default, and a child starts with its parent's", async () => {
    const s = await setup();
    const { models, ada } = s;
    expect(models.defaultFallback(ada.id)).toBe(true);
    expect(models.callContext(ada.id, "general", "web/a").fallback).toBe(true);
    models.setThreadFallback(ada.id, "web/a", false);
    expect([models.threadFallback(ada.id, "web/a"), models.callContext(ada.id, "general", "web/a").fallback]).toEqual([false, false]);
    // A subagent or branch of it starts with it off, even after the default changes.
    models.inheritContext(models.callContext(ada.id, "general", "web/a"), "web/a.child");
    expect(models.threadFallback(ada.id, "web/a.child")).toBe(false);
    models.setDefaultFallback(ada.id, false);
    expect(models.callContext(ada.id, "general", "web/b").fallback).toBe(false);
    models.setThreadFallback(ada.id, "web/b", true);
    models.inheritContext(models.callContext(ada.id, "general", "web/b"), "web/b.child");
    models.setDefaultFallback(ada.id, true);
    expect(models.callContext(ada.id, "general", "web/b.child").fallback).toBe(true);
    models.setThreadFallback(ada.id, "web/a", null);
    expect(models.threadFallback(ada.id, "web/a")).toBeNull();
    expect(() => models.setThreadFallback(ada.id, "web/a", "no" as unknown as boolean)).toThrow(/true, false or null/);
  });
});
