import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudModelForbidden, Memory, type Persona, type Pool } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import { withModels } from "../../core/test/helpers.ts";
import { createDelegateExtension, createLyricaExtension, modelRuntimeFor, openThreadSession, runSubagent, type ThreadContext } from "../src/index.ts";

const persona: Persona = { core: [{ path: "SOUL.md", text: "She is Lyrica." }], topics: [] };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const toolNames = (r: { tools?: { function: { name: string } }[] }) => (r.tools ?? []).map((t) => t.function.name);
const system = (r: { messages: { role: string; content?: unknown }[] }) => JSON.stringify(r.messages.filter((m) => m.role === "system"));

/** Chat on the cloud endpoint for general threads; cheap subagents on the local one; strong on the cloud. */
async function setup() {
  const m = await withModels();
  m.models.setProfile(m.li.id, "cloud", "chat", m.cloudRef);
  m.models.setProfile(m.li.id, "cloud", "subagent.cheap", m.localRef);
  m.models.setProfile(m.li.id, "cloud", "subagent.strong", m.cloudRef);
  m.models.setProfile(m.li.id, "local", "chat", m.localRef);
  const memory = new Memory(m.keyring, m.users);
  const cwd = mkdtempSync(join(tmpdir(), "lyrica-delegate-"));
  dirs.push(cwd);
  const host = { models: m.models, cwd };
  const thread = (pool: Pool, opts: { unlogged?: boolean } = {}): ThreadContext => {
    const view = memory.openThreadView(m.li.id, pool);
    const { id } = view.own.createThread({ interface: "web", unlogged: opts.unlogged });
    return { user: m.li, pool, interface: "web", threadId: id, view, call: m.models.callContext(m.li.id, pool, id) };
  };
  const open = (t: ThreadContext, maxConcurrent?: number) => openThreadSession({
    thread: t, models: m.models, cwd,
    extensions: [
      createLyricaExtension(t, { persona: () => persona, profile: () => m.li.profile }),
      createDelegateExtension(t, { ...host, maxConcurrent }),
    ],
  });
  return { ...m, host, thread, open };
}

describe("delegate", () => {
  it("runs the tier's model in a subagent thread under the parent, and returns its result", async () => {
    const s = await setup();
    const t = s.thread("general", { unlogged: true });
    s.cloud.reply({ tools: [{ name: "delegate", args: { task: "Find notes about Miso", tier: "cheap" } }] }, { text: "Miso hates the vacuum." });
    s.local.reply({ text: "Found one note: Miso hates the vacuum cleaner." });
    const { session, dispose } = await s.open(t);
    try {
      await session.prompt("What does Miso think of the vacuum?");
    } finally {
      dispose();
    }

    const [child, ...more] = t.view.own.listThreads({ parent: t.threadId });
    expect(more).toHaveLength(0);
    expect(child).toMatchObject({ parent: t.threadId, subagent: true, unlogged: true, interface: "web" });
    // The cheap tier ran on the local model, with the worker prompt and read-only memory.
    const [worker] = s.local.requests;
    expect(worker!.messages.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(worker!.messages)).toContain("Find notes about Miso");
    expect(system(worker!)).toContain("You are a worker that Lyrica handed one task to.");
    expect(system(worker!)).not.toContain("She is Lyrica.");
    expect(toolNames(worker!)).toEqual(expect.arrayContaining(["recall", "read_memory"]));
    expect(toolNames(worker!)).not.toContain("remember");
    // A subagent can't delegate.
    expect(toolNames(worker!)).not.toContain("delegate");
    expect(() => createDelegateExtension({ ...t, threadId: child!.id }, s.host)).toThrow("a subagent can't delegate");
    // Its result came back to Lyrica as the tool result.
    const back = s.cloud.requests[1]!.messages.find((msg) => msg.role === "tool");
    expect(JSON.stringify(back)).toContain("Found one note: Miso hates the vacuum cleaner.");
    expect(t.view.own.loadEntries(child!.id).length).toBeGreaterThanOrEqual(2);
  });

  it("gives a subagent in a private thread only a local model", async () => {
    const s = await setup();
    const t = s.thread("private");
    // The local profile has no subagent models: both tiers fall back to the local chat model.
    const { threadId } = await runSubagent(t, s.host, { task: "Check the shopping list", tier: "strong" });
    const childCall = s.models.callContext(s.li.id, "private", threadId);
    expect(childCall.localOnly).toBe(true);
    expect((await modelRuntimeFor(s.models, childCall)).getProviders().map((p) => p.id)).toEqual(["gpu"]);
    // A cloud model for a tier is refused before any thread is made.
    const before = t.view.own.listThreads({ parent: t.threadId }).length;
    await expect(runSubagent({ ...t, call: { ...t.call, overrides: { "subagent.strong": s.cloudRef } } }, s.host, { task: "x", tier: "strong" }))
      .rejects.toThrow(CloudModelForbidden);
    expect(t.view.own.listThreads({ parent: t.threadId })).toHaveLength(before);
    expect(s.cloud.requests).toHaveLength(0);
  });

  it("keeps a local-only thread's subagents local-only", async () => {
    const s = await setup();
    const t = s.thread("general");
    s.models.setLocalOnly(s.li.id, "general", t.threadId, true);
    const parent = { ...t, call: s.models.callContext(s.li.id, "general", t.threadId) };
    const { threadId } = await runSubagent(parent, s.host, { task: "Summarize", tier: "cheap" });
    expect(s.models.callContext(s.li.id, "general", threadId).localOnly).toBe(true);
    expect(s.cloud.requests).toHaveLength(0);
  });

  it("limits how many subagents run at once in a thread", async () => {
    const s = await setup();
    const t = s.thread("general");
    s.cloud.reply({ tools: [
      { id: "a", name: "delegate", args: { task: "one", tier: "cheap" } },
      { id: "b", name: "delegate", args: { task: "two", tier: "cheap" } },
    ] }, { text: "done" });
    const { session, dispose } = await s.open(t, 1);
    try {
      await session.prompt("do two things");
    } finally {
      dispose();
    }
    const results = session.messages.filter((m) => m.role === "toolResult") as { isError: boolean; content: unknown }[];
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.isError).map((r) => JSON.stringify(r.content))).toEqual([expect.stringContaining("already running")]);
  });
});
