// What a confirm's checkboxes send (web/src/ui.tsx): deleting a thread with "Also delete its child thread" ticked must take the child too.
import { describe, expect, it } from "vitest";
import { tickStates } from "../src/ui.tsx";

const keep = { label: "Keep memories", ticked: false }, kids = { label: "Also delete its child thread", ticked: true };

describe("a confirm's options", () => {
  it("start at their defaults and keep what the user set", () => {
    expect(tickStates([keep, kids], {})).toEqual([false, true]);
    expect(tickStates([keep, kids], { "Also delete its child thread": false, "Keep memories": true })).toEqual([true, false]);
  });

  it("give an option that appeared after the confirm opened its default, as its checkbox shows it", () => {
    // The thread's child count loaded after Delete… was chosen: the child option wasn't there at first.
    expect(tickStates([keep, kids], { "Keep memories": true })).toEqual([true, true]);
  });
});
