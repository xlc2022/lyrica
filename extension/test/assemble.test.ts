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
const ada: Profile = { displayName: "Ada", pronouns: PRONOUN_PRESETS.they, previousNames: [] };

describe("prompt assembly", () => {
  it("puts stable content in the system prompt, keeps topics apart and omits empty memory", () => {
    const a = assemble({ persona, topics: [routed("music", "Music is structured feeling.")], memory: {}, profile: ada, now });
    expect(a.customPrompt).toBe("# Soul\nShe is Lyrica.\n\n# Style\nWarm.");
    expect(Object.keys(a.sections)).toEqual(["user"]);
    expect(a.topics).toEqual([{ id: "music", text: '<topic id="music">\nMusic is structured feeling.\n</topic>' }]);
    expect(a.sections.user).toBe("You are talking with Ada (pronouns: they/them).");
  });

  it("keeps per-turn content (opening, recall, time) out of the system prompt", () => {
    const a = assemble({
      persona, topics: [], profile: ada, now,
      memory: { wake: "WAKE", pageIndex: "pages", recall: "a recall hit", opening: "Bring up the garden.", lastTalk: new Date("2026-10-07T12:00:00Z") },
    });
    expect(Object.keys(a.sections)).toEqual(["wake", "pages", "user"]);
    expect(JSON.stringify(a.sections)).not.toMatch(/recall hit|garden|2026/);
    expect(a.turn).toMatch(/^<opening>\nBring up the garden\.\n<\/opening>\n\n<recall>\na recall hit\n<\/recall>\n\n<time>\nIt is Friday, 9 October 2026 at .*You last talked 2 days ago\.\n<\/time>$/s);
  });

  it("tells her the user's own date and time, in their zone", () => {
    // 23:30 UTC on Friday is already Saturday morning in Tokyo, and still Friday afternoon in Los Angeles.
    const late = new Date("2026-10-09T23:30:00Z");
    const tokyo = assemble({ persona, topics: [], memory: {}, profile: { ...ada, timeZone: "Asia/Tokyo" }, now: late });
    expect(tokyo.turn).toContain("It is Saturday, 10 October 2026 at 08:30 (Asia/Tokyo).");
    const la = assemble({ persona, topics: [], memory: {}, profile: { ...ada, timeZone: "America/Los_Angeles" }, now: late });
    expect(la.turn).toContain("It is Friday, 9 October 2026 at 16:30 (America/Los_Angeles).");
    // Without one, the server's (UTC in tests).
    expect(assemble({ persona, topics: [], memory: {}, profile: ada, now: late }).turn).toContain("It is Friday, 9 October 2026 at 23:30 (UTC).");
  });

  it("gives the same system content at a different time", () => {
    const input = { persona, topics: [], memory: {}, profile: ada };
    const a = assemble({ ...input, now });
    const b = assemble({ ...input, now: new Date("2026-10-10T08:00:00Z") });
    expect([b.customPrompt, b.sections]).toEqual([a.customPrompt, a.sections]);
    expect(b.turn).not.toBe(a.turn);
  });

  it("tells her who she's talking with, including previous names", () => {
    const renamed: Profile = { ...ada, displayName: "Lin", previousNames: [{ name: "Ada", until: "2026-10-09" }] };
    const { sections } = assemble({ persona, topics: [], memory: {}, profile: renamed, now });
    expect(sections.user).toContain("You are talking with Lin (pronouns: they/them).");
    expect(sections.user).toContain("previous name: Ada (until 2026-10-09)");
  });

  it("keeps every section within its budget", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a long topic.`).join("\n");
    const budgets = { ...DEFAULT_BUDGETS, persona: 20, topics: 1000, wake: 100, recall: 100 };
    const a = assemble(
      { persona, topics: [routed("a", long), routed("b", long), routed("c", long)], memory: { wake: long, recall: long }, profile: ada, now },
      budgets,
    );
    const section = (name: string) => a.report.find((s) => s.name === name)!;
    expect(section("persona").truncated).toBe(true);
    expect(a.customPrompt.length).toBeLessThanOrEqual(budgets.persona);
    expect(a.sections.wake!.length).toBeLessThanOrEqual(budgets.wake);
    expect(section("recall").text.length).toBeLessThanOrEqual(budgets.recall);
    expect(a.topics.map((t) => t.text).join("").replace(/<\/?topic[^>]*>\n?/g, "").length).toBeLessThanOrEqual(budgets.topics + 10);
    expect(a.topics[0]!.text).toContain('<topic id="a">');
  });

  it("cuts at a line break when one is near", () => {
    expect(fit("first line\nsecond line", 15)).toBe("first line\n…");
    expect(fit("short", 15)).toBe("short");
  });
});
