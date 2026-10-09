import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudModelForbidden, Memory, PRONOUN_PRESETS, type Persona, type Pool } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import { withModels } from "../../core/test/helpers.ts";
import { modelRuntimeFor, openThreadSession, piModelFor, type ThreadContext } from "../src/index.ts";

const persona: Persona = { core: [{ path: "SOUL.md", text: "She is Lyrica." }], topics: [] };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Li's models (a cloud and a local fake server) plus a Memory, with both profiles' chat set. */
async function setup() {
  const m = await withModels();
  m.models.setProfile(m.li.id, "cloud", "chat", m.cloudRef);
  m.models.setProfile(m.li.id, "local", "chat", m.localRef);
  const memory = new Memory(m.keyring, m.users);
  const thread = (pool: Pool, opts: { localOnly?: boolean } = {}): ThreadContext => {
    const view = memory.openThreadView(m.li.id, pool);
    const { id } = view.own.createThread({ interface: "cli" });
    if (opts.localOnly) m.models.setLocalOnly(m.li.id, pool, id, true);
    return { user: m.li, pool, interface: "cli", threadId: id, view, call: m.models.callContext(m.li.id, pool, id) };
  };
  const open = (t: ThreadContext, settings?: object) => {
    const cwd = mkdtempSync(join(tmpdir(), "lyrica-models-"));
    dirs.push(cwd);
    return openThreadSession({
      thread: t, models: m.models, cwd, settings,
      lyrica: { persona: () => persona, profile: () => ({ displayName: "Li", pronouns: PRONOUN_PRESETS.she, previousNames: [] }) },
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
        expect(runtime.getProviders().map((p) => p.id)).toEqual(["gpu"]);
        expect(runtime.getAllModels().map((m) => `${m.provider}/${m.id}`)).toEqual(["gpu/qwen3.8-27b"]);
        expect(runtime.getModel("openrouter", s.cloudRef.modelId)).toBeUndefined();
        expect(() => runtime.registerProvider("openrouter", { baseUrl: s.cloud.baseUrl })).toThrow();
      }
      const general = await modelRuntimeFor(s.models, s.thread("general").call);
      expect(general.getProviders().map((p) => p.id).sort()).toEqual(["gpu", "openrouter"]);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("refuses a cloud model there, and nothing falls back", async () => {
    const s = await setup();
    const t = s.thread("private");
    const runtime = await modelRuntimeFor(s.models, t.call);
    expect(() => piModelFor(runtime, s.models, "chat", { ...t.call, overrides: { chat: s.cloudRef } })).toThrow(CloudModelForbidden);
    // Even a cloud Model object from a general runtime can't be used through it.
    const cloudModel = (await modelRuntimeFor(s.models, s.thread("general").call)).getModel("openrouter", s.cloudRef.modelId)!;
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
    s.cloud.reply({ tool: { name: "recall", args: { query: "Miso" } } }, { text: "Nothing about Miso yet." });
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
});
