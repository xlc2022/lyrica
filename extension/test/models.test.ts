import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudModelForbidden, Memory, PRONOUN_PRESETS, type Persona, type Pool } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import { deadUrl } from "../../core/test/fake-openai.ts";
import { fakeHost } from "../../core/test/fake-host.ts";
import { withModels } from "../../core/test/helpers.ts";
import { createLyricaExtension, modelRuntimeFor, openThreadSession, piModelFor, toStoredEntry, type ThreadContext } from "../src/index.ts";

const persona: Persona = { core: [{ path: "SOUL.md", text: "She is Lyrica." }], topics: [] };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Li's models (a cloud and a local fake server) plus a Memory, with both profiles' chat set. */
async function setup() {
  const m = await withModels();
  m.models.setProfile(m.li.id, "cloud", "chat", m.cloudRef);
  m.models.setProfile(m.li.id, "local", "chat", m.localRef);
  const memory = new Memory(m.keyring, m.users);
  const thread = (pool: Pool, opts: { localOnly?: boolean; unlogged?: boolean } = {}): ThreadContext => {
    const view = memory.openThreadView(m.li.id, pool);
    const { id } = view.own.createThread({ interface: "cli", unlogged: opts.unlogged });
    if (opts.localOnly) m.models.setLocalOnly(m.li.id, pool, id, true);
    return { user: m.li, pool, interface: "cli", threadId: id, view, call: m.models.callContext(m.li.id, pool, id) };
  };
  const open = (t: ThreadContext, settings?: object) => {
    const cwd = mkdtempSync(join(tmpdir(), "lyrica-models-"));
    dirs.push(cwd);
    return openThreadSession({
      thread: t, models: m.models, cwd, settings,
      extensions: [createLyricaExtension(t, { persona: () => persona, profile: () => ({ displayName: "Li", pronouns: PRONOUN_PRESETS.she, previousNames: [] }) })],
    });
  };
  return { ...m, thread, open };
}

describe("the model runtime", () => {
  it("holds no cloud model, and none of Pi's built-in providers, in a private or local-only thread", async () => {
    process.env.OPENROUTER_API_KEY = "sk-from-the-environment";
    try {
      const s = await setup();
      for (const t of [s.thread("private"), s.thread("general", { localOnly: true })]) {
        const runtime = await modelRuntimeFor(s.models, t.call);
        expect(runtime.getProviders().map((p) => p.id)).toEqual([s.gpu.id]);
        expect(runtime.getAllModels().map((m) => `${m.provider}/${m.id}`)).toEqual([`${s.gpu.id}/qwen3.8-27b`]);
        expect(runtime.getModel(s.openrouter.id, "deepseek/deepseek-4.1-flash")).toBeUndefined();
        expect(() => runtime.registerProvider(s.openrouter.id, { baseUrl: s.cloud.baseUrl })).toThrow();
      }
      const general = await modelRuntimeFor(s.models, s.thread("general").call);
      expect(general.getProviders().map((p) => p.id).sort()).toEqual([s.gpu.id, s.openrouter.id].sort());
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("refuses a cloud model there, and nothing falls back", async () => {
    const s = await setup();
    const t = s.thread("private");
    const runtime = await modelRuntimeFor(s.models, t.call);
    expect(() => piModelFor(runtime, s.models, "chat", { ...t.call, overrides: { chat: [s.cloudRef] } })).toThrow(CloudModelForbidden);
    // Even a cloud Model object from a general runtime can't be used through it.
    const cloudModel = (await modelRuntimeFor(s.models, s.thread("general").call)).getModel(s.openrouter.id, "deepseek/deepseek-4.1-flash")!;
    const { session, dispose } = await s.open(t);
    try {
      await expect(session.setModel(cloudModel)).rejects.toThrow();
      await session.prompt("hello");
    } finally {
      dispose();
    }
    expect(s.cloud.requests).toHaveLength(0);
    expect(s.local.requests.length).toBeGreaterThan(0);
  });

  it("keeps compaction and retries on the local endpoint", async () => {
    const s = await setup();
    const t = s.thread("private");
    const { session, dispose } = await s.open(t, { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } });
    try {
      s.local.reply({ status: 503 });
      await session.prompt("first");
      await session.prompt("second");
      await session.compact();
    } finally {
      dispose();
    }
    expect(s.cloud.requests).toHaveLength(0);
    // The failed request, its retry, the second prompt, and the compaction summary.
    expect(s.local.requests.length).toBeGreaterThanOrEqual(4);
    expect(s.local.requests.every((r) => r.model === "qwen3.8-27b")).toBe(true);
    expect(session.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(true);
  });

  it("runs a tool-call round trip through the router", async () => {
    const s = await setup();
    const t = s.thread("general");
    s.cloud.reply({ tools: [{ name: "recall", args: { query: "Miso" } }] }, { text: "Nothing about Miso yet." });
    const { session, chat, dispose } = await s.open(t);
    try {
      expect(chat).toEqual(s.cloudRef);
      await session.prompt("What do you know about Miso?");
    } finally {
      dispose();
    }
    const [first, second] = s.cloud.requests;
    expect(first!.tools?.map((x) => x.function.name)).toContain("recall");
    expect(second!.messages.some((msg) => msg.role === "tool")).toBe(true);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Nothing about Miso yet." }] });
    expect(s.local.requests).toHaveLength(0);
  });

  it("runs a subagent's thread under its parent, local-only and unlogged like the parent", async () => {
    const s = await setup();
    s.models.setProfile(s.li.id, "cloud", "subagent.strong", s.cloudRef);
    const parent = s.thread("private", { unlogged: true });
    const { id } = parent.view.own.createThread({ interface: "cli", parent: parent.threadId, subagent: true });
    const call = s.models.childContext(parent.call, id, { tier: "strong" });
    const { session, runtime, chat, dispose } = await s.open({ ...parent, threadId: id, call });
    try {
      expect(chat).toEqual(s.localRef);
      expect(runtime.getProviders().map((p) => p.id)).toEqual([s.gpu.id]);
      await session.prompt("check the list");
    } finally {
      dispose();
    }
    expect(parent.view.own.listThreads({ parent: parent.threadId })).toEqual([
      expect.objectContaining({ id, parent: parent.threadId, subagent: true, unlogged: true }),
    ]);
    expect(s.cloud.requests).toHaveLength(0);
    expect(s.local.requests).toHaveLength(1);
  });

  it("clears an endpoint's down time when a reply comes back, so a working endpoint never goes stale", async () => {
    const s = await setup();
    const db = s.users.openUserDb(s.li.id);
    db.prepare("UPDATE endpoints SET down_since = ? WHERE id = ?").run(new Date(Date.now() - 13 * 86_400_000).toISOString(), s.gpu.id);
    db.close();
    const { session, dispose } = await s.open(s.thread("private"));
    try {
      await session.prompt("hello");
    } finally {
      dispose();
    }
    expect(s.models.endpoint(s.li.id, s.gpu.id)!.downSince).toBeUndefined();
  });
});

describe("each turn's model", () => {
  it("falls back to the next model when the first one's machine is off, and records it", async () => {
    const s = await setup();
    const off = s.models.addEndpoint(s.li, { name: "off", kind: "local", baseUrl: await deadUrl() });
    const first = { offeringId: s.models.addModel(s.li, off.id, { modelId: "qwen3.8-27b" }).id };
    s.models.setProfile(s.li.id, "local", "chat", [first, s.localRef]);
    const t = s.thread("private");
    const { session, prepare, dispose } = await s.open(t);
    try {
      const r = await prepare();
      expect(r.label).toBe("gpu/qwen3.8-27b");
      await session.prompt("hello");
    } finally {
      dispose();
    }
    expect(s.local.requests).toHaveLength(1);
    expect(s.models.recentCalls(s.li.id, { threadId: t.threadId })[0]).toMatchObject({ label: "gpu/qwen3.8-27b", kind: "local", fallback: expect.stringContaining("off/qwen3.8-27b was skipped (off is down)") });
  });

  it("passes the thread's thinking level to a model that thinks, and none to one that doesn't, noting it", async () => {
    const s = await setup();
    s.models.setCapabilities(s.li, s.cloudRef.offeringId, { reasoning: ["low", "medium", "high"] });
    s.models.setDefaultThinking(s.li.id, "high");
    for (const t of [s.thread("general"), s.thread("private")]) {
      const { session, prepare, dispose } = await s.open(t);
      try {
        await prepare();
        await session.prompt("think about it");
      } finally {
        dispose();
      }
    }
    expect((s.cloud.requests[0] as unknown as Record<string, unknown>).reasoning_effort).toBe("high");
    const local = s.local.requests[0] as unknown as Record<string, unknown>;
    expect(local.reasoning_effort).toBeUndefined();
    expect(local.chat_template_kwargs).toBeUndefined();
    const [plain, thought] = s.models.recentCalls(s.li.id);
    expect(plain!.note).toBe("gpu/qwen3.8-27b can't think, so it answered without thinking");
    expect(thought!.note).toBeUndefined();
  });

  it("leaves a subagent role's own thinking level alone", async () => {
    const s = await setup();
    s.models.setCapabilities(s.li, s.localRef.offeringId, { reasoning: ["low", "medium", "high"] });
    s.models.setDefaultThinking(s.li.id, "low");
    const { session, prepare, dispose } = await s.open(s.thread("private"));
    try {
      session.setThinkingLevel("high");
      await prepare({ thinking: false });
      expect(session.thinkingLevel).toBe("high");
      await prepare();
      expect(session.thinkingLevel).toBe("low");
    } finally {
      dispose();
    }
  });

  it("never makes thinking text searchable", () => {
    const stored = toStoredEntry({
      type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "thinking", thinking: "a private chain of thought about Miso" }, { type: "text", text: "Miso is fine." }] },
    } as never);
    expect(stored.text).toBe("Miso is fine.");
  });
});

describe("a model host", () => {
  it("is called over mutual TLS with its pinned key, streaming, with thinking through the chat template", async () => {
    const s = await setup();
    const host = await fakeHost({ name: "lyrica-blackwell" });
    const ep = await s.models.pairHost(s.li, { name: "blackwell", addresses: [host.address], code: host.newCode() });
    const [o] = await s.models.discover(s.li, ep.id);
    s.models.setProfile(s.li.id, "local", "chat", [{ offeringId: o!.id }]);
    s.models.setDefaultThinking(s.li.id, "high");
    const t = s.thread("private");
    const { session, prepare, dispose } = await s.open(t);
    try {
      const r = await prepare();
      expect(r.endpoint.api).toBe("host");
      await session.prompt("hello over TLS");
    } finally {
      dispose();
    }
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "ok from lyrica-blackwell" }] });
    expect(host.chats).toEqual([expect.objectContaining({ model: o!.modelId, chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }, client: [...host.pinned.keys()][0] })]);
    expect(host.chats[0]!.reasoning_effort).toBeUndefined();
    expect(s.models.recentCalls(s.li.id)[0]!.note).toBeUndefined();
  });
});

describe("how a model answers", () => {
  it("sends the offering's saved values with every call, only those set, and never another user's", async () => {
    const s = await setup();
    const bob = await s.users.createUser("bob", "pw", { displayName: "Bob", pronouns: PRONOUN_PRESETS.he }, { admin: false });
    await s.users.authenticate("bob", "pw");
    const lan = s.models.addEndpoint(s.li, { name: "lan", kind: "local", baseUrl: s.local.baseUrl }, { shared: true });
    const [qwen] = await s.models.discover(s.li, lan.id);
    s.models.setProfile(s.li.id, "local", "chat", [{ offeringId: qwen!.id }]);
    s.models.setOfferingSettings(s.li, qwen!.id, { temperature: 0.6, repeatPenalty: 1.1 }, "shared");
    s.models.setOfferingSettings(s.li, qwen!.id, { seed: 7, stop: ["END"], maxTokens: 300 });
    s.models.setOfferingSettings(bob, qwen!.id, { temperature: 1.9, topP: 0.5 });
    const { session, dispose } = await s.open(s.thread("private"));
    try {
      await session.prompt("hello");
    } finally {
      dispose();
    }
    const sent = s.local.requests[0] as unknown as Record<string, unknown>;
    expect(sent).toMatchObject({ temperature: 0.6, repeat_penalty: 1.1, seed: 7, stop: ["END"], max_tokens: 300 });
    expect(sent.top_p).toBeUndefined();
    expect(sent.top_k).toBeUndefined();
  });
});

describe("thinking on a host", () => {
  it("sends reasoning_effort to a host model with levels, and the chat-template switch only for one with an on/off switch", async () => {
    const s = await setup();
    const host = await fakeHost({ name: "vllm", models: [
      { id: "Qwen/Qwen3.8-27B", kind: "chat", contextLength: 32768, tools: true, reasoning: ["low", "medium", "high"] },
    ] });
    const ep = await s.models.pairHost(s.li, { name: "vllm", addresses: [host.address], code: host.newCode() });
    const [o] = await s.models.discover(s.li, ep.id);
    expect(o!.reasoning).toEqual(["low", "medium", "high"]);
    s.models.setProfile(s.li.id, "local", "chat", [{ offeringId: o!.id }]);
    s.models.setDefaultThinking(s.li.id, "high");
    const { session, prepare, dispose } = await s.open(s.thread("private"));
    try {
      await prepare();
      await session.prompt("think hard");
    } finally {
      dispose();
    }
    expect(host.chats[0]).toMatchObject({ reasoning_effort: "high" });
    expect(host.chats[0]!.chat_template_kwargs).toBeUndefined();
  });
});
