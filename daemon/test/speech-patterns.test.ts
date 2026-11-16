import { describe, expect, it } from "vitest";
import { sentences, speakable } from "../src/speech.ts";

// Read aloud runs on lyricad's thread over her reply, which may quote a page;
// each crafted 64 KB line here took seconds before its patterns were made linear.

const fill = (unit: string, end = "") => unit.repeat(Math.ceil(65536 / unit.length)) + end;
const quick = (run: () => unknown) => {
  const started = performance.now();
  run();
  expect(performance.now() - started).toBeLessThan(300);
};

describe("speech over crafted text", () => {
  it.each([
    ["a table rule with long spacing", "---|---" + fill("\t", ":---")],
    ["brackets left open", fill("[")],
    ["link targets left open", fill("[a](")],
    ["angle brackets left open", fill("<")],
  ])("makes %s speakable quickly", (_name, text) => quick(() => speakable(text)));

  it("splits a long run of marks quickly", () => quick(() => sentences(fill("!", "x"))));

  it("still reads tables, links and sentences as before", () => {
    expect(speakable("a | b\n---|:---:\nSee [the guide](https://example.org/wiki/A_(b)) and <b>this</b>.\n| x |")).toBe("a | b\nSee the guide and this.");
    expect(sentences("One!! Two?” Three… 四。五")).toEqual(["One!!", "Two?”", "Three…", "四。", "五"]);
  });
});
