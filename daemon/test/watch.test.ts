// The watcher counts only the person's own words as a trigger: markers the system writes (a wake-up, a routine,
// another thread's message, a look) are not them (docs/delegation.md, Watching threads).
import { describe, expect, it, vi } from "vitest";
import { Watcher } from "../src/watch.ts";

function watcher(last: string) {
  const wanted = vi.fn(() => false);
  const view = { own: { projectOf: () => "p", getThread: () => ({ unlogged: false, subagent: false }), lastEntry: () => ({ text: last }) }, close: () => {} };
  const w = new Watcher({ memory: { openThreadView: () => view } as never, wanted } as never);
  return { w, wanted };
}

describe("watcher triggers", () => {
  it.each([
    ["Check the DNS again.", true],
    ["[Wake-up, set 2026-10-12T05:15:00Z]\n\nlook again", false],
    ["[Routine, Daily at 08:00]\n\nInspect the build queue.", false],
  ])("a user entry %j counts as the person's: %s", (text, theirs) => {
    const { w, wanted } = watcher(text);
    w.turnEnded("u", "general", "t");
    expect(wanted.mock.calls.length > 0).toBe(theirs);
    w.close();
  });
});
