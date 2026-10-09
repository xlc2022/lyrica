import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PRONOUN_PRESETS, type Persona, type Profile } from "@lyrica/core";
import { describe, expect, it } from "vitest";
import { createLyricaExtension, toolGuidance, UNLOGGED_NOTICE, type ThreadContext } from "../src/index.ts";
import { withMemory } from "./helpers.ts";

const persona: Persona = {
  core: [{ path: "SOUL.md", text: "She is Lyrica." }],
  topics: [{ id: "music", summary: "", triggers: ["song"], priority: 2, text: "Music is structured feeling." }],
};
const profile: Profile = { displayName: "Li", pronouns: PRONOUN_PRESETS.she, previousNames: [] };

/** Loads the extension against a fake Pi API and returns a function that runs one turn. */
function load(thread: ThreadContext, folders: string[] = []) {
  const handlers = new Map<string, Function>();
  const tools: string[] = [];
  let active: string[] = [];
  const pi = {
    on: (event: string, h: Function) => handlers.set(event, h),
    registerTool: (t: { name: string }) => { tools.push(t.name); active.push(t.name); },
    getActiveTools: () => [...active],
    getAllTools: () => tools.map((name) => ({ name })),
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  void createLyricaExtension(thread, { persona: () => persona, profile: () => profile, folders: () => folders })(pi);
  const turn = async (prompt: string) => {
    // Pi builds fresh options from its base for every turn.
    const options = { cwd: "/", selectedTools: [], sections: {} as Record<string, string> };
    const result = await handlers.get("before_agent_start")!({ type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: options }, { hasUI: false });
    return { options, result, active: [...active] };
  };
  return Object.assign(turn, { tools });
}

describe("extension", () => {
  it("edits Pi's prompt options instead of replacing the prompt, routed per turn", async () => {
    const turn = load((await withMemory()).thread().context);
    const first = await turn("sing me a song");
    expect(first.result.systemPrompt).toBeUndefined();
    expect(first.options).toMatchObject({ customPrompt: "She is Lyrica." });
    expect(first.options.sections.topics).toContain('<topic id="music">');
    expect(first.options.sections.user).toBe("You are talking with Li (pronouns: she/her).");
    expect(first.result.message).toMatchObject({ customType: "lyrica-turn", display: false });
    expect(first.result.message.content).toContain("<time>");

    for (let i = 0; i < 3; i++) expect((await turn("hm")).options.sections.topics).toContain("music");
    expect((await turn("hm")).options.sections.topics).toBeUndefined();
  });

  it("accepts only a thread view from openThreadView", async () => {
    const m = await withMemory();
    const { context } = m.thread();
    const owner = m.memory.openOwnerView(m.user.id);
    expect(() => load({ ...context, view: owner as never })).toThrow(/openThreadView/);
    expect(() => load({ ...context, view: { ...context.view } })).toThrow(/openThreadView/);
    expect(() => load({ ...context, pool: "private" })).toThrow(/openThreadView/);
    expect(load(context).tools).toEqual(["remember", "recall", "read_memory"]);
  });

  it("puts WAKE, the page index and folder pages in the prompt, and recall in the turn", async () => {
    const m = await withMemory();
    const { context, view, threadId } = m.thread();
    const past = view.own.createThread({ interface: "web" });
    const entry = view.own.appendEntry(past.id, { piId: "x", role: "user", data: {}, text: "my sourdough starter died" });
    view.own.addNotes([{ text: "{user}'s sourdough starter is called Gerald", source: entry }], { author: "lyrica", thread: past.id });
    view.own.putWake("Li is baking again.", "sleep");
    view.own.putPage({ slug: "site", title: "Website", summary: "{user}'s site", text: "Built with Astro.", folders: ["/srv/site"] }, "sleep");
    const owner = m.memory.openOwnerView(m.user.id);
    owner.general.addNotes([{ text: "Rye flour works best for my starter" }], { author: `user:${m.user.id}` });

    const { options, result, active } = await load(context, ["/srv/site"])("how is the sourdough starter?");
    expect(options.sections.wake).toBe("Li is baking again.");
    expect(options.sections.pages).toBe("- [p:site] Website: Li's site");
    expect(options.sections.folders).toContain("Built with Astro.");
    expect(options.sections.notice).toBeUndefined();
    expect(active).toContain("remember");
    const turn = result.message.content as string;
    expect(turn).toMatch(/<recall>[\s\S]*Li's sourdough starter is called Gerald/);
    expect(turn).toMatch(/\(note, added by Li\) Rye flour/);
    expect(turn).toContain("You last talked");
    expect(JSON.stringify(options.sections)).not.toContain("Gerald");
    expect(threadId).not.toBe(past.id);
    owner.close();
  });

  it("doesn't offer remember in an unlogged thread, and says so", async () => {
    const { context } = (await withMemory()).thread("general", { unlogged: true });
    const { options, active } = await load(context)("hello");
    expect(options.sections.notice).toBe(UNLOGGED_NOTICE);
    expect(active).not.toContain("remember");
    expect(active).toContain("recall");
  });

  it("rebuilds tool guidance that a custom prompt would drop", () => {
    expect(toolGuidance({
      cwd: "/",
      selectedTools: ["recall", "hidden", "plain"],
      hiddenTools: ["hidden"],
      toolSnippets: { recall: "search memory", hidden: "secret" },
      toolGuidelines: { recall: ["Recall first"], hidden: ["Not shown"] },
      promptGuidelines: ["Recall first", "Be kind"],
    })).toBe("- recall: search memory\n\nGuidelines:\n- Recall first\n- Be kind");
    expect(toolGuidance({ cwd: "/", selectedTools: [] })).toBe("");
  });
});
