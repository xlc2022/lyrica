import { describe, expect, it } from "vitest";
import { answers } from "../src/answers.ts";

describe("answers to a resource fetched again", () => {
  it("shows an answer while a newer fetch is still on its way, and never an older one after it", () => {
    const o = answers();
    const first = o.send();
    const second = o.send();
    const third = o.send();
    expect(o.take(second)).toBe(true);
    expect(o.take(first)).toBe(false);
    expect(o.take(third)).toBe(true);
  });

  it("shows an error only for the newest fetch", () => {
    const o = answers();
    const first = o.send();
    const second = o.send();
    expect(o.latest(first)).toBe(false);
    expect(o.latest(second)).toBe(true);
  });

  it("drops answers to a resource it has moved on from", () => {
    const o = answers();
    const before = o.send();
    o.reset();
    const after = o.send();
    expect(o.take(before)).toBe(false);
    expect(o.latest(before)).toBe(false);
    expect(o.take(after)).toBe(true);
  });
});
