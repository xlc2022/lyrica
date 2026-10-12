// A thread's checklist on its card and in its header: the count done, and the step the card shows (web/src/Checklist.tsx).
import { describe, expect, it } from "vitest";
import type { ThreadStep } from "../src/api.ts";
import { checklistOf } from "../src/Checklist.tsx";

const step = (state: ThreadStep["state"], text: string): ThreadStep => ({ state, text });

describe("a checklist", () => {
  it("counts the done steps out of all of them", () => {
    const { done, total } = checklistOf([step("done", "Read the brief"), step("doing", "Build the card"), step("todo", "Check it on a phone")]);
    expect([done, total]).toEqual([1, 3]);
  });

  it("shows the step under way, even after a later one is done", () => {
    expect(checklistOf([step("done", "Sow"), step("todo", "Water"), step("doing", "Weed"), step("done", "Fence")]).current).toEqual(step("doing", "Weed"));
  });

  it("shows the first to do when none is under way", () => {
    expect(checklistOf([step("done", "Sow"), step("todo", "Water"), step("todo", "Weed")]).current).toEqual(step("todo", "Water"));
  });

  it("shows no step once all are done, and counts nothing in an empty list", () => {
    expect(checklistOf([step("done", "Sow"), step("done", "Water")])).toEqual({ done: 2, total: 2 });
    expect(checklistOf([])).toEqual({ done: 0, total: 0 });
  });
});
