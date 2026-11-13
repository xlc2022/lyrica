import { describe, expect, it } from "vitest";
import { countRecalls, memorySections } from "@lyrica/extension";
import { withMemory } from "../../extension/test/helpers.ts";
import { memoryUse, useCounts } from "../src/memory-use.ts";

/** A logged user message, for a note to cite as its source. */
const say = (own: Parameters<typeof memorySections>[0]["own"], thread: string, text: string) =>
  own.appendEntry(thread, { piId: `u-${Math.random()}`, role: "user", data: { type: "message", message: { role: "user", content: [{ type: "text", text }] } }, text });

describe("Memory use", () => {
  it("counts the notes she reaches, by pool, and shows the administrator only the pools their display shows", async () => {
    const m = await withMemory();
    const g = m.thread("general");
    const [sourdough] = g.view.own.addNotes([{ text: "Ada keeps a rye sourdough starter fed twice a day", source: say(g.view.own, g.threadId, "my rye starter") }], { author: "lyrica", thread: g.threadId });
    g.view.own.addNotes([{ text: `Ada bakes on Sundays with the starter [${sourdough}]` }], { author: "lyrica", thread: g.threadId });

    const p = m.thread("private");
    const [diagnosis] = p.view.own.addNotes([{ text: "Ada has a quiet diagnosis about sourdough allergies", source: say(p.view.own, p.threadId, "the allergy") }], { author: "lyrica", thread: p.threadId });

    const ctx = (t: typeof g) => ({ threadId: t.threadId, user: { id: m.user.id, profile: m.user.profile }, folders: [], countRecalls: true });
    // Automatic recall in a private thread reaches both pools: each count stays in the private pool.
    const recalled = await memorySections(p.view, "tell me about the rye sourdough starter allergies", ctx(p));
    expect(recalled.recall).toContain(`general/${sourdough}`);
    countRecalls(g.view, [sourdough!], "opened", ctx(g));
    countRecalls(g.view, [sourdough!, "e:cli/x#1"], "searched", ctx(g));

    const o = m.memory.openOwnerView(m.user.id);
    const both = memoryUse(o, ["general", "private"], 30);
    const row = both.top.find((r) => r.id === sourdough && r.pool === "general")!;
    expect(row).toMatchObject({ kind: "note", recalled: 1, searched: 1, opened: 1, citedBy: 1, label: "Ada keeps a rye sourdough starter fed twice a day" });
    expect(both.top.some((r) => r.id === diagnosis && r.pool === "private")).toBe(true);
    // The Memory page's Most used reads the same counts, a private thread's count of a general note only with both shown.
    expect(useCounts(o, ["general", "private"]).general[sourdough!]).toBe(3);
    expect(useCounts(o, ["general"]).general[sourdough!]).toBe(2);
    expect(useCounts(o, ["general"]).private).toEqual({});
    // Only notes and pages are counted: a message hit isn't.
    expect(both.top.every((r) => r.kind === "note" || r.kind === "page")).toBe(true);

    // General alone: no private memory, and no count made in a private thread.
    const general = memoryUse(o, ["general"], 30);
    expect(JSON.stringify(general)).not.toContain("diagnosis");
    expect(general.top.find((r) => r.id === sourdough)).toMatchObject({ recalled: 0, searched: 1, opened: 1 });
    expect(general.hours.reduce((n, h) => n + h.recalled, 0)).toBe(0);

    // A deleted memory's counts go with it.
    o.private.delete(diagnosis!, `user:${m.user.id}`);
    expect(memoryUse(o, ["private"], 7).top.some((r) => r.id === diagnosis)).toBe(false);
    expect(o.private.recallCounts("2000-01-01").some((r) => r.id === diagnosis)).toBe(false);
    o.close();
  });

  it("counts nothing in an unlogged thread or where counting is off (sleep)", async () => {
    const m = await withMemory();
    const g = m.thread("general");
    const [note] = g.view.own.addNotes([{ text: "Ada collects vintage typewriters", source: say(g.view.own, g.threadId, "typewriters") }], { author: "lyrica", thread: g.threadId });
    const quiet = m.thread("general", { unlogged: true });
    const user = { id: m.user.id, profile: m.user.profile };
    await memorySections(quiet.view, "vintage typewriters collection", { threadId: quiet.threadId, user, folders: [], countRecalls: true });
    await memorySections(g.view, "vintage typewriters collection", { threadId: "sleep/x", user, folders: [] });
    expect(g.view.own.recallCounts("2000-01-01")).toEqual([]);
    expect(note).toBeDefined();
  });

  it("keeps 31 days of counts", async () => {
    const m = await withMemory();
    const g = m.thread("general");
    const [note] = g.view.own.addNotes([{ text: "Ada swims at dawn" }], { author: "lyrica", thread: g.threadId });
    g.view.own.countRecalls([note!], "recalled", "2026-01-01T08:00:00.000Z");
    g.view.own.countRecalls([note!], "recalled", "2026-01-01T08:30:00.000Z");
    expect(g.view.own.recallCounts("2026-01-01T00")).toEqual([{ id: note, hour: "2026-01-01T08", recalled: 2, searched: 0, opened: 0 }]);
    g.view.own.countRecalls([note!], "opened", "2026-02-15T08:00:00.000Z");
    expect(g.view.own.recallCounts("2000-01-01").map((r) => r.hour)).toEqual(["2026-02-15T08"]);
  });
});
