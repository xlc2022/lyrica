import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_THREADS_LIMITS, PROJECT_CHAT_GUIDELINES, PROJECT_THREAD_GUIDELINES, type Persona } from "@lyrica/core";
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLyricaExtension, createThreadsExtension, createSubagentExtension, createDelegateExtension, Delegation, BUILTIN_ROLES } from "../extension/src/index.ts";
import { CODING_GUIDELINE, CODE_TOOLS_OFF } from "../extension/src/code.ts";
import { withMemory } from "../extension/test/helpers.ts";

// Scripted evidence only. No environment variable can enable a real model here.
const persona: Persona = { core: [
  { path: "SOUL.md", text: "SOUL-SENTINEL" },
  { path: "STYLE.md", text: "STYLE-SENTINEL" },
  { path: "REGISTER.md", text: "REGISTER-SENTINEL" },
], topics: [{ id: "coding", text: "TOPIC-SENTINEL", summary: "", triggers: ["fixture"], priority: 1 }] };

function fakePi() {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  let active = [...CODE_TOOLS_OFF];
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); },
    getAllTools: () => [...new Set([...CODE_TOOLS_OFF, ...tools.keys()])].map(name => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  const sessionManager = { getBranch: () => [] };
  return { pi, tools, async turn(prompt: string, model?: { id: string; name: string }) {
    const options = { cwd: "/", customPrompt: "", selectedTools: [...active], sections: {} as Record<string, string> };
    const messages = [];
    for (const handler of handlers.get("before_agent_start") ?? []) {
      const result = await handler({ messageType: "user", prompt, systemPrompt: "", systemPromptOptions: options }, { hasUI: false, sessionManager, model });
      if (result?.message) messages.push(result.message.content);
    }
    return { options, text: JSON.stringify(options) + messages.join("\n"), active: [...active] };
  } };
}

describe("code mode scripted continuity", () => {
  it("focuses the prompt, recall and tools, then restores the companion turn", async () => {
    const s = await withMemory();
    const t = s.thread();
    const own = t.view.own;
    own.setProject(t.threadId);
    own.setGoal(t.threadId, "FIXTURE-GOAL");
    own.putWake("WAKE-SENTINEL", "sleep");
    own.putPage({ slug: "about-user", title: "About user", summary: "PAGE-INDEX-SENTINEL", text: "ABOUT-SENTINEL" }, "sleep");
    own.setCodeTask(t.threadId, "Fix fixture addition", "Read the failing test");
    const source = own.appendEntry(t.threadId, { piId: "fixture-source", role: "user", text: "fixture addition", data: {} });
    own.addNotes([{ text: "fixture project note", source }], { author: "lyrica", thread: t.threadId });
    own.addNotes([{ text: "fixture working preference", about: ["working"] }, { text: "fixture unrelated note" }], { author: "sleep" });
    let code = true;
    let repoReads = 0;
    const f = fakePi();
    createLyricaExtension(t.context, { persona: () => persona, profile: () => s.user.profile, code: () => code,
      codeRepositories: async () => { repoReads++; return "fixture: feature/fix\nFix addition"; } })(f.pi);
    const on = await f.turn("fixture");
    expect(on.options.customPrompt).toBe("SOUL-SENTINEL");
    expect(on.text).toContain("FIXTURE-GOAL");
    expect(on.text).toContain("Code task");
    expect(on.text).toContain("Fix fixture addition");
    expect(on.text).toContain("fixture project note");
    expect(on.text).toContain("fixture working preference");
    for (const absent of ["STYLE-SENTINEL", "REGISTER-SENTINEL", "TOPIC-SENTINEL", "WAKE-SENTINEL", "ABOUT-SENTINEL", "PAGE-INDEX-SENTINEL", "fixture unrelated note"]) expect(on.text).not.toContain(absent);
    for (const tool of CODE_TOOLS_OFF) expect(on.active).not.toContain(tool);
    expect(repoReads).toBe(1);
    expect(on.text).toContain("never end a reply on a plan or a promise");
    expect(on.text).toContain("check that a library is already used");
    const recall = f.tools.get("recall");
    const result = (everywhere?: boolean) => recall.execute("call", { query: "fixture", everywhere });
    expect(JSON.stringify(await result())).not.toContain("fixture unrelated note");
    expect(JSON.stringify(await result(true))).toContain("fixture unrelated note");
    code = false;
    const off = await f.turn("fixture");
    for (const restored of ["STYLE-SENTINEL", "REGISTER-SENTINEL", "WAKE-SENTINEL", "ABOUT-SENTINEL"]) expect(off.text).toContain(restored);
    for (const tool of CODE_TOOLS_OFF) expect(off.active).toContain(tool);
    expect(off.text).toContain(CODING_GUIDELINE);
    expect(off.text).not.toContain("never end a reply on a plan or a promise");
    const delegation = {
      recover: () => {}, depth: () => 0, limits: { depth: 1 }, newBudget: () => ({ left: 8 }),
      roles: () => [...BUILTIN_ROLES], workflows: () => [], claudeCode: () => undefined,
    } as unknown as Delegation;
    createDelegateExtension(t.context, delegation)(f.pi);
    const plain = await f.turn("Fix the fixture’s failing test");
    expect(plain.options.sections.delegation).toContain("- coder (strong): code changes in a repository: edit, test, fix");
    expect(plain.options.sections.delegation!.indexOf("- coder")).toBeLessThan(plain.options.sections.delegation!.indexOf("- worker"));
    expect(f.tools.get("delegate").description).not.toContain("Roles:");
    expect(off.text).not.toContain("Code task");
    expect(repoReads).toBe(1);
    t.view.close();
  });

  it("keeps only working notes outside a project and in the other pool of a private view", async () => {
    const s = await withMemory();
    const owner = s.memory.openOwnerView(s.user.id);
    owner.general.addNotes([{ text: "fixture working preference", about: ["working"] }, { text: "fixture unrelated memory" }], { author: `user:${s.user.id}` });
    owner.close();
    for (const pool of ["general", "private"] as const) {
      const t = s.thread(pool);
      const f = fakePi();
      createLyricaExtension(t.context, { persona: () => persona, profile: () => s.user.profile, code: () => true })(f.pi);
      const on = await f.turn("fixture");
      expect(on.text).toContain("fixture working preference");
      expect(on.text).not.toContain("fixture unrelated memory");
      t.view.close();
    }
  });

  it("sets task text through threads code, rejects subagents, and gives coder project memory", async () => {
    const s = await withMemory();
    const t = s.thread();
    t.view.own.setProject(t.threadId);
    t.view.own.setGoal(t.threadId, "PROJECT-SENTINEL");
    let code = false;
    const host = { limits: DEFAULT_THREADS_LIMITS, start: async () => { throw new Error("unused"); }, message: async () => "saved" as const, list: () => [], code: (_: unknown, on: boolean) => { code = on; } };
    const f = fakePi();
    createThreadsExtension(t.context, host)(f.pi);
    await f.tools.get("threads").execute("call", { action: "code", on: true, task: "Fix fixture", done: "Checked failure" });
    expect(code).toBe(true);
    expect(t.view.own.codeTask(t.threadId)).toMatchObject({ task: "Fix fixture", done: "Checked failure" });
    await f.tools.get("threads").execute("call", { action: "code", on: false });
    expect(code).toBe(false);
    const child = t.view.own.createThread({ interface: "cli", parent: t.threadId, subagent: true });
    const context = { ...t.context, threadId: child.id };
    expect(() => createThreadsExtension(context, host)).toThrow(/subagent/);
    t.view.own.setCodeTask(child.id, "Coder fixture", "Prior decisions");
    const coder = BUILTIN_ROLES.find(r => r.name === "coder")!;
    const sub = fakePi();
    createSubagentExtension(context, coder, { question: () => {}, note: () => true }, new Set(coder.tools))(sub.pi);
    const prompt = await sub.turn("fixture", { id: "qwen3.8-27b", name: "Qwen3.8 27B" });
    expect(prompt.text).toContain("PROJECT-SENTINEL");
    expect(prompt.text).toContain("never report success you didn't achieve");
    expect(prompt.text).toContain("never end a reply on a plan or a promise");
    const onClaude = await sub.turn("fixture", { id: "claude-opus-5-5", name: "Claude Opus 5.5" });
    expect(onClaude.text).not.toContain("never end a reply on a plan or a promise");
    expect(prompt.text).toContain("Coder fixture");
    expect(prompt.text).not.toContain("SOUL-SENTINEL");
    t.view.close();
  });

  it("splits a larger build into code threads in a project chat, and codes in place elsewhere", async () => {
    const s = await withMemory();
    const host = { limits: DEFAULT_THREADS_LIMITS, start: async () => { throw new Error("unused"); }, message: async () => "saved" as const, list: () => [], code: () => {} };
    const guidance = (context: typeof s.thread extends () => infer T ? T : never) => {
      const f = fakePi();
      createThreadsExtension((context as { context: Parameters<typeof createThreadsExtension>[0] }).context, host)(f.pi);
      return (f.tools.get("threads").promptGuidelines as string[]).join("\n");
    };
    const chat = s.thread();
    chat.view.own.setProject(chat.threadId);
    const split = PROJECT_CHAT_GUIDELINES.find(g => g.includes("one code: true thread per part"))!;
    expect(split).toContain("A small job (one feature or fix) keeps one thread");
    expect(split).toContain("splits even when the parts fit together");
    expect(guidance(chat)).toContain(split);
    const plain = s.thread();
    expect(guidance(plain)).not.toContain(split);
    expect(PROJECT_THREAD_GUIDELINES.join("\n")).toContain("only the files your brief gives you");
    // Outside a project chat she codes in the thread itself and switches code mode back off when done.
    expect(CODING_GUIDELINE).toContain("code in this thread");
    expect(CODING_GUIDELINE).toContain("turn it off (on: false) when the coding is done");
    expect(CODING_GUIDELINE).toContain("code: true thread only if the user asks for one");
    chat.view.close();
    plain.view.close();
  });

  it("has a repository fixture with a reproducible failing test", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-code-fixture-"));
    try {
      cpSync(new URL("./fixtures/code-mode/", import.meta.url), dir, { recursive: true });
      execFileSync("git", ["init", "--quiet", dir]);
      const failure = spawnSync(process.execPath, ["--test", "sum.test.mjs"], { cwd: dir, encoding: "utf8" });
      expect(failure.status).toBe(1);
      expect(failure.stdout).toContain("2 !== 5");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skip("real-model evidence: tests, edit, tests; plain thread delegates to coder or enables code mode", () => {});
});
