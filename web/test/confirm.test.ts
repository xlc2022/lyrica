// What a confirm's checkboxes send (web/src/ui.tsx): forgetting a thread with "Also forget its child thread" ticked must take the child too.
import { describe, expect, it } from "vitest";
import { tickStates } from "../src/ui.tsx";

const keep = { label: "Keep memories", ticked: false }, kids = { label: "Also forget its child thread", ticked: true };

describe("a confirm's options", () => {
  it("start at their defaults and keep what the user set", () => {
    expect(tickStates([keep, kids], {})).toEqual([false, true]);
    expect(tickStates([keep, kids], { "Also forget its child thread": false, "Keep memories": true })).toEqual([true, false]);
  });

  it("give an option that appeared after the confirm opened its default, as its checkbox shows it", () => {
    // The thread's child count loaded after Forget this thread was pressed: the child option wasn't there at first.
    expect(tickStates([keep, kids], { "Keep memories": true })).toEqual([true, true]);
  });
});
