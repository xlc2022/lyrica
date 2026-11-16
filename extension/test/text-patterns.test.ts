import { describe, expect, it } from "vitest";
import { parseVerdict } from "../src/evidence.ts";
import { sameText } from "../src/memory.ts";
import { bundleLines, commits } from "../src/workspace.ts";

// Model replies and command output reach these on lyricad's thread; each
// crafted 64 KB input here took a second or more before it was made linear.

const fill = (unit: string, end = "") => unit.repeat(Math.ceil(65536 / unit.length)) + end;
const quick = (run: () => unknown) => {
  const started = performance.now();
  run();
  expect(performance.now() - started).toBeLessThan(300);
};

describe("text patterns over crafted input", () => {
  it("reads a judge's verdict quickly, and as before", () => {
    quick(() => parseVerdict(fill("{")));
    expect(parseVerdict('Sure. {"verdict":"continue","reason":" r ","next":"n"} done')).toEqual({ verdict: "continue", reason: "r", next: "n" });
    expect(parseVerdict("} {")).toBeUndefined();
  });

  it("compares notes quickly", () => quick(() => sameText(fill("["), fill("{user"))));

  it("tells a commit quickly, within one part of a command", () => {
    quick(() => commits(fill("t\0git\0", "t")));
    expect(commits("cd x && git -C y commit -m z")).toBe(true);
    expect(commits("git status; echo commit")).toBe(false);
    expect(commits("gitcommit")).toBe(false);
  });

  it("reads saved bundles quickly, split at the last colon-slash", () => {
    quick(() => bundleLines("BUNDLE:" + fill(":/", ":")));
    expect(bundleLines("x\nBUNDLE:/w/a:/b:/s/a-1.bundle\r\nBUNDLE:/w:/.bundle\nBUNDLE::/x.bundle\nBUNDLE:/w:x.bundle")).toEqual([
      { dir: "/w/a:/b", bundle: "/s/a-1.bundle" }, { dir: "/w", bundle: "/.bundle" }, { dir: "", bundle: "/x.bundle" },
    ]);
  });
});
