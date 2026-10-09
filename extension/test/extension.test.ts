import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Persona } from "@lyrica/core";
import { describe, expect, it } from "vitest";
import { createLyricaExtension } from "../src/index.ts";

const persona: Persona = {
  core: [{ path: "SOUL.md", text: "She is Lyrica." }],
  topics: [{ id: "music", summary: "", triggers: ["song"], priority: 2, text: "Music is structured feeling." }],
};

/** Loads the extension against a fake Pi API and returns its before_agent_start handler. */
function load() {
  const handlers = new Map<string, Function>();
  const pi = { on: (event: string, h: Function) => handlers.set(event, h) } as unknown as ExtensionAPI;
  const factory = createLyricaExtension(
    {
      user: { id: "u1", name: "Xu", admin: true }, pool: "general", interface: "cli", threadId: "t1",
      view: { pool: "general" }, call: { userId: "u1", pool: "general", localOnly: false },
    },
    { persona: () => persona, displayName: "Xu" },
  );
  void factory(pi);
  const ctx = { hasUI: false };
  return (prompt: string) => handlers.get("before_agent_start")!({ type: "before_agent_start", prompt, systemPrompt: "" }, ctx);
}

describe("extension", () => {
  it("replaces the system prompt with the assembled one, routed per turn", async () => {
    const turn = load();
    const first = await turn("sing me a song");
    expect(first.systemPrompt).toContain("She is Lyrica.");
    expect(first.systemPrompt).toContain('<topic id="music">');

    for (let i = 0; i < 3; i++) expect((await turn("hm")).systemPrompt).toContain('<topic id="music">');
    expect((await turn("hm")).systemPrompt).not.toContain('<topic id="music">');
  });
});
