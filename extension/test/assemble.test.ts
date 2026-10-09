import type { Persona, Topic } from "@lyrica/core";
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

describe("prompt assembly", () => {
  it("orders sections and omits empty memory", () => {
    const { prompt, sections } = assemble({ persona, topics: [routed("music", "Music is structured feeling.")], memory: {}, displayName: "Xu", now });
    expect(sections.map((s) => s.name)).toEqual(["persona", "topics", "time", "user"]);
    expect(prompt.indexOf("She is Lyrica")).toBeLessThan(prompt.indexOf('<topic id="music">'));
    expect(prompt).toContain("You are talking with Xu.");
  });

  it("places memory sections between topics and time", () => {
    const { sections } = assemble({
      persona, topics: [], displayName: "Xu", now,
      memory: { wake: "WAKE", pageIndex: "pages", recall: "recall", lastTalk: new Date("2026-10-07T12:00:00Z") },
    });
    expect(sections.map((s) => s.name)).toEqual(["persona", "wake", "pages", "recall", "time", "user"]);
    expect(sections.find((s) => s.name === "time")!.text).toContain("2 days ago");
  });

  it("keeps every section within its budget", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a long topic.`).join("\n");
    const budgets = { ...DEFAULT_BUDGETS, persona: 20, topics: 1000, wake: 100 };
    const { sections } = assemble(
      { persona, topics: [routed("a", long), routed("b", long), routed("c", long)], memory: { wake: long }, displayName: "Xu", now },
      budgets,
    );
    const body = (name: string) => sections.find((s) => s.name === name)!;
    expect(body("persona").truncated).toBe(true);
    expect(body("wake").text.length).toBeLessThanOrEqual(budgets.wake + "<wake>\n\n</wake>".length);
    const topicBodies = body("topics").text.replace(/<\/?topic[^>]*>\n?/g, "");
    expect(topicBodies.length).toBeLessThanOrEqual(budgets.topics + 10);
    expect(body("topics").text).toContain('<topic id="a">');
  });

  it("cuts at a line break when one is near", () => {
    expect(fit("first line\nsecond line", 15)).toBe("first line\n…");
    expect(fit("short", 15)).toBe("short");
  });
});
