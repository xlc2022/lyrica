import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PRONOUN_PRESETS, type Persona, type Profile } from "@lyrica/core";
import { describe, expect, it } from "vitest";
import { createLyricaExtension, toolGuidance } from "../src/index.ts";

const persona: Persona = {
  core: [{ path: "SOUL.md", text: "She is Lyrica." }],
  topics: [{ id: "music", summary: "", triggers: ["song"], priority: 2, text: "Music is structured feeling." }],
};
const profile: Profile = { displayName: "Li", pronouns: PRONOUN_PRESETS.she, previousNames: [] };

/** Loads the extension against a fake Pi API and returns a function that runs one turn. */
function load() {
  const handlers = new Map<string, Function>();
  const pi = { on: (event: string, h: Function) => handlers.set(event, h) } as unknown as ExtensionAPI;
  void createLyricaExtension(
    {
      user: { id: "u1", login: "li", admin: true, profile }, pool: "general", interface: "cli", threadId: "t1",
      view: { pool: "general" }, call: { userId: "u1", pool: "general", localOnly: false },
    },
    { persona: () => persona, profile: () => profile },
  )(pi);
  return async (prompt: string) => {
    // Pi builds fresh options from its base for every turn.
    const options = { cwd: "/", selectedTools: [], sections: {} as Record<string, string> };
    const result = await handlers.get("before_agent_start")!({ type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: options }, { hasUI: false });
    return { options, result };
  };
}

describe("extension", () => {
  it("edits Pi's prompt options instead of replacing the prompt, routed per turn", async () => {
    const turn = load();
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
