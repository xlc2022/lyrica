import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudModelForbidden, Memory, PRONOUN_PRESETS, type Persona, type Pool } from "@lyrica/core";
import { createAssistantMessageEventStream, fauxAssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { deadUrl, fakeOpenAI } from "../../core/test/fake-openai.ts";
import { fakeHost } from "../../core/test/fake-host.ts";
import { withModels } from "../../core/test/helpers.ts";
import { createLyricaExtension, modelRuntimeFor, openThreadSession, piModelFor, toStoredEntry, type ThreadContext } from "../src/index.ts";
import { markUnservable } from "../src/models.ts";
import { keepRecentFor, reserveFor } from "../src/context.ts";

const persona: Persona = { core: [{ path: "SOUL.md", text: "She is Lyrica." }], topics: [] };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Ada's models (a cloud and a local fake server) plus a Memory, with both columns' chat set. */
async function setup() {
  const m = await withModels();
  m.models.setColumnTask(m.ada.id, "general", "chat", m.cloudRef);
  m.models.setColumnTask(m.ada.id, "private", "chat", m.localRef);
  const memory = new Memory(m.keyring, m.users);
  const thread = (pool: Pool, opts: { localOnly?: boolean; unlogged?: boolean } = {}): ThreadContext => {
    const view = memory.openThreadView(m.ada.id, pool);
    const { id } = view.own.createThread({ interface: "cli", unlogged: opts.unlogged });
    if (opts.localOnly) m.models.setLocalOnly(m.ada.id, pool, id, true);
    return { user: m.ada, pool, interface: "cli", threadId: id, view, call: m.models.callContext(m.ada.id, pool, id) };
  };
  const open = (t: ThreadContext, settings?: object) => {
    const cwd = mkdtempSync(join(tmpdir(), "lyrica-models-"));
    dirs.push(cwd);
    return openThreadSession({
      thread: t, models: m.models, cwd, settings,
      extensions: [createLyricaExtension(t, { persona: () => persona, profile: () => ({ displayName: "Ada", pronouns: PRONOUN_PRESETS.she, previousNames: [] }) })],
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

  it("plans by a thread's context limit where it is below the model's window", async () => {
    const s = await setup();
    const call = s.thread("general").call;
    const window = async (limit?: number) => (await modelRuntimeFor(s.models, { ...call, ...(limit ? { contextLimit: limit } : {}) })).getModel(s.gpu.id, "qwen3.8-27b")!.contextWindow;
    expect(await window()).toBe(32768);
    expect(await window(16384)).toBe(16384);
    expect(await window(65536)).toBe(32768);
  });

  it("sizes Pi's compaction by the model's window as it is when compaction runs", async () => {
    const s = await setup();
    const { session, dispose } = await s.open(s.thread("general"));
    try {
      const model = session.model!;
      expect(session.settingsManager.getCompactionSettings(model)).toMatchObject({ reserveTokens: reserveFor(model.contextWindow), keepRecentTokens: keepRecentFor(model.contextWindow) });
      // prepareRequest moves the window when the copy changes; the reserve and kept tail move with it.
      model.contextWindow = 131_072;
      expect(session.settingsManager.getCompactionSettings(model)).toMatchObject({ reserveTokens: reserveFor(131_072), keepRecentTokens: keepRecentFor(131_072) });
    } finally {
      dispose();
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
    s.models.setColumnTask(s.ada.id, "general", "subagent.strong", s.cloudRef);
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
    const db = s.users.openUserDb(s.ada.id);
    db.prepare("UPDATE endpoints SET down_since = ? WHERE id = ?").run(new Date(Date.now() - 13 * 86_400_000).toISOString(), s.gpu.id);
    db.close();
    const { session, dispose } = await s.open(s.thread("private"));
    try {
      await session.prompt("hello");
    } finally {
      dispose();
    }
    expect(s.models.endpoint(s.ada.id, s.gpu.id)!.downSince).toBeUndefined();
  });
});

describe("each turn's model", () => {
  it("falls back to the next model when the first one's machine is off, and records it", async () => {
    const s = await setup();
    const off = s.models.addEndpoint(s.ada, { name: "off", kind: "local", baseUrl: await deadUrl() });
    const first = { offeringId: s.models.addModel(s.ada, off.id, { modelId: "qwen3.8-27b" }).id };
    s.models.setColumnTask(s.ada.id, "private", "chat", [first, s.localRef]);
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
    expect(s.models.recentCalls(s.ada.id, { threadId: t.threadId })[0]).toMatchObject({ label: "gpu/qwen3.8-27b", kind: "local", fallback: expect.stringContaining("off/qwen3.8-27b was skipped (off is down)") });
  });

  it("passes the thread's thinking level to a model that thinks, and none to one that doesn't, noting it", async () => {
    const s = await setup();
    s.models.setCapabilities(s.ada, s.cloudRef.offeringId, { reasoning: ["low", "medium", "high"] });
    s.models.setDefaultThinking(s.ada.id, "high");
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
    const [plain, thought] = s.models.recentCalls(s.ada.id);
    expect(plain!.note).toBe("gpu/qwen3.8-27b can't think, so it answered without thinking");
    expect(thought!.note).toBeUndefined();
  });

  it("thinks at medium unless someone chooses, with no note for a model that can't", async () => {
    const s = await setup();
    s.models.setCapabilities(s.ada, s.cloudRef.offeringId, { reasoning: ["low", "medium", "high"] });
    for (const t of [s.thread("general"), s.thread("private")]) {
      const { session, prepare, dispose } = await s.open(t);
      try {
        await prepare();
        await session.prompt("hello");
      } finally {
        dispose();
      }
    }
    expect((s.cloud.requests[0] as unknown as Record<string, unknown>).reasoning_effort).toBe("medium");
    expect(s.models.recentCalls(s.ada.id).map((c) => c.note)).toEqual([undefined, undefined]);
  });

  it("asks again at medium when a provider won't run a model without thinking, and keeps thinking from then on", async () => {
    const s = await setup();
    s.models.setCapabilities(s.ada, s.cloudRef.offeringId, { reasoning: ["low", "medium", "high"] });
    s.models.setDefaultThinking(s.ada.id, "off");
    s.cloud.reply({ status: 400, message: "Reasoning is mandatory for this endpoint and cannot be disabled." });
    const { session, prepare, dispose } = await s.open(s.thread("general"));
    try {
      await prepare();
      await session.prompt("hello");
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
      await prepare();
      await session.prompt("and again");
    } finally {
      dispose();
    }
    const sent = s.cloud.requests.map((r) => (r as unknown as Record<string, unknown>).reasoning_effort);
    expect(sent).toEqual([undefined, "medium", "medium"]);
    expect(s.models.recentCalls(s.ada.id)[0]!.note).toBe("openrouter/deepseek/deepseek-4.1-flash can't turn thinking off, so it thought at medium");
  });

  it("thinks on LM Studio as its own API says, and turns thinking off with none unless it can't", async () => {
    const s = await setup();
    const studio = await fakeOpenAI({ models: [{ id: "flash" }, { id: "glm" }], lmStudio: [
      { type: "llm", key: "flash", capabilities: { vision: true, reasoning: { allowed_options: ["off", "on"], default: "on" } }, loaded_instances: [] },
      { type: "llm", key: "glm", capabilities: { vision: true, reasoning: { allowed_options: ["on"], default: "on" } }, loaded_instances: [] },
    ] });
    const ep = s.models.addEndpoint(s.ada, { name: "studio", kind: "local", baseUrl: studio.baseUrl });
    const [flash, glm] = await s.models.discover(s.ada, ep.id);
    const ask = async (offeringId: string, level: "medium" | "off") => {
      s.models.setColumnTask(s.ada.id, "private", "chat", [{ offeringId }]);
      s.models.setDefaultThinking(s.ada.id, level);
      const { session, prepare, dispose } = await s.open(s.thread("private"));
      try {
        await prepare();
        await session.prompt("hello");
      } finally {
        dispose();
      }
      return (studio.requests.at(-1) as unknown as Record<string, unknown>).reasoning_effort;
    };
    expect(await ask(flash!.id, "medium")).toBe("medium");
    expect(await ask(flash!.id, "off")).toBe("none");
    expect(await ask(glm!.id, "off")).toBe("medium");
    expect(s.models.recentCalls(s.ada.id).map((c) => c.note)).toEqual(["studio/glm can't turn thinking off, so it thought at medium", undefined, undefined]);
  });

  it("leaves a subagent role's own thinking level alone", async () => {
    const s = await setup();
    s.models.setCapabilities(s.ada, s.localRef.offeringId, { reasoning: ["low", "medium", "high"] });
    s.models.setDefaultThinking(s.ada.id, "low");
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
    const ep = await s.models.pairHost(s.ada, { name: "blackwell", addresses: [host.address], code: host.newCode() });
    const [o] = await s.models.discover(s.ada, ep.id);
    s.models.setColumnTask(s.ada.id, "private", "chat", [{ offeringId: o!.id }]);
    s.models.setDefaultThinking(s.ada.id, "high");
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
    expect(s.models.recentCalls(s.ada.id)[0]!.note).toBeUndefined();
  });
});

describe("how a model answers", () => {
  it("sends the offering's saved values with every call, only those set, and never another user's", async () => {
    const s = await setup();
    const bob = await s.users.createUser("bob", "pw", { displayName: "Bob", pronouns: PRONOUN_PRESETS.he }, { admin: false });
    await s.users.authenticate("bob", "pw");
    const lan = s.models.addEndpoint(s.ada, { name: "lan", kind: "local", baseUrl: s.local.baseUrl }, { shared: true });
    const [qwen] = await s.models.discover(s.ada, lan.id);
    s.models.setColumnTask(s.ada.id, "private", "chat", [{ offeringId: qwen!.id }]);
    s.models.setOfferingSettings(s.ada, qwen!.id, { temperature: 0.6, repeatPenalty: 1.1 }, "shared");
    s.models.setOfferingSettings(s.ada, qwen!.id, { seed: 7, stop: ["END"], maxTokens: 300 });
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

  it("caps a reply at the smaller of 131,072 tokens and a quarter of the context window, clamping a longer saved maximum", async () => {
    const s = await setup();
    const id = s.localRef.offeringId;
    s.models.setOfferingSettings(s.ada, id, { maxTokens: 200_000 });
    const sentFor = async (contextWindow: number) => {
      s.models.setCapabilities(s.ada, id, { contextWindow });
      const { session, dispose } = await s.open(s.thread("private"));
      try {
        await session.prompt("hello");
      } finally {
        dispose();
      }
      return (s.local.requests.at(-1) as unknown as Record<string, unknown>).max_tokens;
    };
    expect(await sentFor(1_048_576)).toBe(131_072);
    expect(await sentFor(262_144)).toBe(65_536);
    expect(await sentFor(32_768)).toBe(8192);
  });
});

describe("each model's own settings", () => {
  it("sends the fallback model its own values, and a cloud API only what it takes", async () => {
    const s = await setup();
    const off = s.models.addEndpoint(s.ada, { name: "off", kind: "local", baseUrl: await deadUrl() });
    const first = s.models.addModel(s.ada, off.id, { modelId: "qwen3.8-27b" });
    s.models.setOfferingSettings(s.ada, first.id, { temperature: 1.5 });
    s.models.setOfferingSettings(s.ada, s.localRef.offeringId, { temperature: 0.3 });
    s.models.setColumnTask(s.ada.id, "private", "chat", [{ offeringId: first.id }, s.localRef]);
    s.models.setOfferingSettings(s.ada, s.cloudRef.offeringId, { temperature: 0.9, topK: 20 });
    for (const t of [s.thread("private"), s.thread("general")]) {
      const { session, prepare, dispose } = await s.open(t);
      try {
        await prepare();
        await session.prompt("hello");
      } finally {
        dispose();
      }
    }
    expect((s.local.requests[0] as unknown as Record<string, unknown>).temperature).toBe(0.3);
    const cloud = s.cloud.requests[0] as unknown as Record<string, unknown>;
    expect(cloud.temperature).toBe(0.9);
    expect(cloud.top_k).toBeUndefined();
  });
});

describe("thinking on a host", () => {
  it("sends reasoning_effort to a host model with levels, and the chat-template switch only for one with an on/off switch", async () => {
    const s = await setup();
    const host = await fakeHost({ name: "vllm", models: [
      { id: "Qwen/Qwen3.8-27B", kind: "chat", contextLength: 32768, tools: true, reasoning: ["low", "medium", "high"] },
    ] });
    const ep = await s.models.pairHost(s.ada, { name: "vllm", addresses: [host.address], code: host.newCode() });
    const [o] = await s.models.discover(s.ada, ep.id);
    expect(o!.reasoning).toEqual(["low", "medium", "high"]);
    s.models.setColumnTask(s.ada.id, "private", "chat", [{ offeringId: o!.id }]);
    s.models.setDefaultThinking(s.ada.id, "high");
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

it("says plainly when OpenRouter's provider can't serve a model, in words Pi won't retry", async () => {
  const raw = '404 Provider returned error\n{"error":{"message":"Function \'f\': Not found for account \'a\'"},"metadata":{"provider_name":"Nvidia"}}';
  const source = createAssistantMessageEventStream();
  const error = { ...fauxAssistantMessage(""), stopReason: "error" as const, errorMessage: raw };
  expect(isRetryableAssistantError(error)).toBe(true);
  source.push({ type: "error", reason: "error", error });
  source.end();
  const out = [];
  for await (const e of markUnservable("vendor/big:free", source)) out.push(e);
  const shown = out[0]!.type === "error" ? out[0]!.error : error;
  expect(shown.errorMessage).toBe("Nvidia can't serve vendor/big:free right now (OpenRouter answered 404). Pick another model, or try again later.");
  expect(isRetryableAssistantError(shown)).toBe(false);
});
