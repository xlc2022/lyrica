import { describe, expect, it } from "vitest";
import type { Display, MemoryLink } from "../src/api.ts";
import { linkCitations, plainWords, wordDiff, firstWords } from "../src/memory.ts";

const show: Display = { theme: "device", sort: "date", showGeneral: true, showPrivate: true, showHidden: false, projects: "all" } as Display;
const links: Record<string, MemoryLink> = {
  "p:garden": { kind: "page", pool: "general", title: "The garden", snippet: "Four beds.", updatedAt: "2026-10-09T10:00:00Z" },
  "n:20261009-k3f9": { kind: "note", pool: "general", snippet: "Seeds arrive Friday.", updatedAt: "2026-10-09T10:00:00Z", origin: "lyrica" },
  "t:web/3f7a2c": { kind: "thread", pool: "general", title: "Garden bed plan", snippet: "", updatedAt: "2026-10-09T10:00:00Z" },
};
const hidePrivate: Display = { ...show, showPrivate: false };
const text = "Seeds arrive Friday [n:20261009-k3f9]. The beds are in [p:garden], planned in [t:web/3f7a2c]; the rest is in [n:gone] and [private/n:secret].";

describe("citations in a memory's text", () => {
  it("read as titles and dated marks, never as IDs, and say when a pool is hidden", () => {
    const { markdown, words } = linkCitations(text, "general", "u1", links, show);
    expect(markdown).not.toMatch(/\[[a-z]+:[^\]]+\]\(/);
    expect(markdown).toContain("[The garden](#/u/u1/memory/general/p%3Agarden)");
    expect(markdown).toContain("[Garden bed plan](#/u/u1/t/general/web%2F3f7a2c)");
    expect(markdown).toContain("in a deleted note and a deleted note.");
    expect([...words.values()].find((w) => w.cite)!.text).toMatch(/\d/);
    const hiddenPrivate = linkCitations(text, "general", "u1", links, hidePrivate);
    expect(hiddenPrivate.markdown).toContain("and Private is hidden.");
    expect(hiddenPrivate.markdown).toContain("The garden");
  });
  it("read plainly for a sentence or a difference, with the source marks dropped", () => {
    expect(plainWords(text, "general", links, hidePrivate, "u1")).toBe("Seeds arrive Friday. The beds are in The garden, planned in Garden bed plan; the rest is in a deleted note and Private is hidden.");
    expect(firstWords("Li wants the cluster off the old NAS. [e:web/3f7a2c#41]")).toBe("Li wants the cluster off the old NAS.");
  });
});

describe("word differences", () => {
  it("join back to either text and mark only what changed", () => {
    const from = "The job runs at 03:00 against nas-old and keeps 30 days.";
    const to = "The job now runs at 03:00 against tank and keeps 14 days.";
    const ops = wordDiff(from, to);
    expect(ops.filter((o) => o.kind !== "ins").map((o) => o.text).join("")).toBe(from);
    expect(ops.filter((o) => o.kind !== "del").map((o) => o.text).join("")).toBe(to);
    expect(ops.filter((o) => o.kind === "del").map((o) => o.text.trim())).toEqual(["nas-old", "30"]);
    expect(ops.filter((o) => o.kind === "ins").map((o) => o.text.trim())).toEqual(["now", "tank", "14"]);
    expect(wordDiff("same words", "same words")).toEqual([{ kind: "same", text: "same words" }]);
    expect(wordDiff("", "new")).toEqual([{ kind: "ins", text: "new" }]);
  });
});
