import { describe, expect, it } from "vitest";
import { assemble, DEFAULT_BUDGETS, memorySections, pinnedBlock, type PinnedText } from "../src/index.ts";
import { withMemory } from "./helpers.ts";

const say = (own: Parameters<typeof memorySections>[0]["own"], thread: string, role: string, text: string) =>
  own.appendEntry(thread, { piId: `${role}-${text.slice(0, 8)}-${Math.random()}`, role, data: {}, text });
const n = (id: string) => Number(id.split("#")[1]);

describe("pinned messages", () => {
  it("stay in her context word for word, whatever is left of the conversation, and only in their own thread", async () => {
    const m = await withMemory();
    const { view, threadId } = m.thread();
    const recipe = "Rye starter: 50 g rye flour,\n50 g water, every 12 hours.";
    const pinned = say(view.own, threadId, "user", recipe);
    say(view.own, threadId, "assistant", "Got it.");
    view.own.pinEntry(threadId, n(pinned), true);

    const ctx = { threadId, user: { id: m.user.id, profile: m.user.profile }, folders: [] };
    const own = await memorySections(view, "hi", ctx);
    // Built from the store, not from the messages Pi keeps: compaction can't summarise it away.
    expect(own.pinned).toEqual([{ id: pinned, role: "user", text: recipe }]);
    expect(assemble({ persona: { core: [], topics: [] }, topics: [], memory: own, profile: m.user.profile, now: new Date() }).sections.pinned)
      .toBe(`[${pinned}] User: ${recipe}`);

    const other = m.thread();
    expect((await memorySections(other.view, "hi", { ...ctx, threadId: other.threadId })).pinned).toBeUndefined();
  });

  it("hold their budget: the oldest are shortened to their first line, and it says so", () => {
    const pins: PinnedText[] = [
      { id: "e:t#1", role: "user", text: `first line\n${"old detail ".repeat(40)}` },
      { id: "e:t#2", role: "assistant", text: "the newest, kept whole" },
    ];
    const roomy = pinnedBlock(pins, DEFAULT_BUDGETS.pinned);
    expect(roomy.shortened).toBe(false);
    const tight = pinnedBlock(pins, 120);
    expect(tight.text.length).toBeLessThanOrEqual(120);
    expect(tight.text).toBe("[e:t#1] User: first line …\n\n[e:t#2] You: the newest, kept whole");
    expect(tight.shortened).toBe(true);
  });

  it("are copied with a branch, removed with their turn, and counted when they go", async () => {
    const m = await withMemory();
    const { view, threadId } = m.thread();
    const a = say(view.own, threadId, "user", "keep this");
    say(view.own, threadId, "assistant", "kept");
    const b = say(view.own, threadId, "user", "and this");
    view.own.pinEntry(threadId, n(a), true);
    view.own.pinEntry(threadId, n(b), true);

    const branch = view.own.branchThread(threadId, n(a) + 1);
    expect(view.own.pins(branch.id).map((p) => p.id)).toEqual([a]);
    expect(view.own.truncateThread(threadId, n(b), "lyrica")).toMatchObject({ removed: 1, pins: 1 });
    expect(view.own.pins(threadId).map((p) => p.id)).toEqual([a]);
    view.own.pinEntry(threadId, n(a), false);
    expect(view.own.pins()).toHaveLength(1); // the branch's copy
    expect(() => view.own.pinEntry(threadId, 99, true)).toThrow(/no entry 99/);
  });

  it("of a private thread never reach a general one, and sleep sees which entries were pinned", async () => {
    const m = await withMemory();
    const secret = m.thread("private");
    const id = say(secret.view.own, secret.threadId, "user", "my therapist is on Tuesdays");
    secret.view.own.pinEntry(secret.threadId, n(id), true);
    const general = m.thread("general");
    const ctx = { threadId: general.threadId, user: { id: m.user.id, profile: m.user.profile }, folders: [] };
    expect(JSON.stringify(await memorySections(general.view, "therapist", ctx))).not.toContain("therapist");
    expect(general.view.own.pins()).toEqual([]);

    const material = secret.view.own.sleepMaterial(undefined, new Date(Date.now() + 1000).toISOString());
    expect(material.threads.find((t) => t.id === secret.threadId)?.pinned).toEqual([id]);
  });
});
