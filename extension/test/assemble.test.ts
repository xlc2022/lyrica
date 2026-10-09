import { PRONOUN_PRESETS, type Persona, type Profile, type Topic } from "@lyrica/core";
import { describe, expect, it } from "vitest";
import { assemble, DEFAULT_BUDGETS, fit } from "../src/assemble.ts";
import type { RoutedTopic } from "../src/routing.ts";

const persona: Persona = {
  core: [{ path: "SOUL.md", text: "# Soul\nShe is Lyrica." }, { path: "STYLE.md", text: "# Style\nWarm." }],
  topics: [],
};
const routed = (id: string, text: string): RoutedTopic => ({
  topic: { id, summary: "", triggers: [], priority: 1, text } satisfies Topic,
  score: 1,
  fresh: true,
  turnsLeft: 3,
});
const now = new Date("2026-10-09T12:00:00Z");
const li: Profile = { displayName: "Li", pronouns: PRONOUN_PRESETS.they, previousNames: [] };

describe("prompt assembly", () => {
  it("puts stable content in the system prompt and omits empty memory", () => {
    const a = assemble({ persona, topics: [routed("music", "Music is structured feeling.")], memory: {}, profile: li, now });
    expect(a.customPrompt).toBe("# Soul\nShe is Lyrica.\n\n# Style\nWarm.");
    expect(Object.keys(a.sections)).toEqual(["topics", "user"]);
    expect(a.sections.topics).toBe('<topic id="music">\nMusic is structured feeling.\n</topic>');
    expect(a.sections.user).toBe("You are talking with Li (pronouns: they/them).");
  });

  it("keeps per-turn content (recall, time) out of the system prompt", () => {
    const a = assemble({
      persona, topics: [], profile: li, now,
      memory: { wake: "WAKE", pageIndex: "pages", recall: "a recall hit", lastTalk: new Date("2026-10-07T12:00:00Z") },
    });
    expect(Object.keys(a.sections)).toEqual(["wake", "pages", "user"]);
    expect(JSON.stringify(a.sections)).not.toMatch(/recall hit|2026/);
    expect(a.turn).toMatch(/^<recall>\na recall hit\n<\/recall>\n\n<time>\nIt is Friday, 9 October 2026 at .*You last talked 2 days ago\.\n<\/time>$/s);
  });

  it("gives the same system content at a different time", () => {
    const input = { persona, topics: [], memory: {}, profile: li };
    const a = assemble({ ...input, now });
    const b = assemble({ ...input, now: new Date("2026-10-10T08:00:00Z") });
    expect([b.customPrompt, b.sections]).toEqual([a.customPrompt, a.sections]);
    expect(b.turn).not.toBe(a.turn);
  });

  it("tells her who she's talking with, including previous names", () => {
    const renamed: Profile = { ...li, displayName: "Lin", previousNames: [{ name: "Li", until: "2026-10-09" }] };
    const { sections } = assemble({ persona, topics: [], memory: {}, profile: renamed, now });
    expect(sections.user).toContain("You are talking with Lin (pronouns: they/them).");
    expect(sections.user).toContain("previous name: Li (until 2026-10-09)");
  });

  it("keeps every section within its budget", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a long topic.`).join("\n");
    const budgets = { ...DEFAULT_BUDGETS, persona: 20, topics: 1000, wake: 100, recall: 100 };
    const a = assemble(
      { persona, topics: [routed("a", long), routed("b", long), routed("c", long)], memory: { wake: long, recall: long }, profile: li, now },
      budgets,
    );
    const section = (name: string) => a.report.find((s) => s.name === name)!;
    expect(section("persona").truncated).toBe(true);
    expect(a.customPrompt.length).toBeLessThanOrEqual(budgets.persona);
    expect(a.sections.wake!.length).toBeLessThanOrEqual(budgets.wake);
    expect(section("recall").text.length).toBeLessThanOrEqual(budgets.recall);
    expect(a.sections.topics!.replace(/<\/?topic[^>]*>\n?/g, "").length).toBeLessThanOrEqual(budgets.topics + 10);
    expect(a.sections.topics).toContain('<topic id="a">');
  });

  it("cuts at a line break when one is near", () => {
    expect(fit("first line\nsecond line", 15)).toBe("first line\n…");
    expect(fit("short", 15)).toBe("short");
  });
});
