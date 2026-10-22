// The changes view's line differences (web/src/diff.ts): what the user sees of two sides of a file.
import { describe, expect, it } from "vitest";
import { blocks, lineDiff, sideBySide } from "../src/diff.ts";

describe("line differences", () => {
  it("keeps, removes and adds lines, pairing a change's lines so their words are marked", () => {
    const lines = lineDiff("one\ntwo\nthree\nfour\n", "one\ntwo changed\nthree\nfive\nsix\n");
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ["same", "one"], ["del", "two"], ["ins", "two changed"], ["same", "three"], ["del", "four"], ["ins", "five"], ["ins", "six"],
    ]);
    expect(lines[1]).toMatchObject({ a: 2 });
    expect(lines[2]).toMatchObject({ b: 2, ops: [{ kind: "same", text: "two " }, { kind: "ins", text: "changed" }] });
    // A wholly different line is left plain.
    expect(lines[5]).not.toHaveProperty("ops");
  });

  it("shows a new file as all added, a deleted one as all removed, and an empty change as nothing", () => {
    expect(lineDiff("", "a\nb\n").map((l) => l.kind)).toEqual(["ins", "ins"]);
    expect(lineDiff("a\nb\n", "").map((l) => l.kind)).toEqual(["del", "del"]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("folds unchanged stretches, keeping three lines around a change, and unfolds twenty at a time", () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 30", "line 30 changed");
    const lines = lineDiff(before, after);
    expect(blocks(lines, new Map())).toEqual([
      { kind: "fold", from: 0, to: 26 }, { kind: "lines", from: 26, to: 34 }, { kind: "fold", from: 34, to: 61 },
    ]);
    expect(blocks(lines, new Map([[0, 20]]))).toEqual([
      { kind: "lines", from: 0, to: 20 }, { kind: "fold", from: 20, to: 26 }, { kind: "lines", from: 26, to: 34 }, { kind: "fold", from: 34, to: 61 },
    ]);
    expect(blocks(lines, new Map([[0, 40], [34, 40]]))).toEqual([{ kind: "lines", from: 0, to: 61 }]);
  });

  it("lays a change's lines side by side, the longer side facing blanks", () => {
    const lines = lineDiff("a\nb\nc\n", "a\nB\nC\nd\n");
    const rows = sideBySide(lines, 0, lines.length);
    expect(rows.map((r) => [r.left?.text, r.right?.text])).toEqual([["a", "a"], ["b", "B"], ["c", "C"], [undefined, "d"]]);
  });

  it("gives up matching lines past the edit budget and shows the whole middle replaced", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `x${i}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, i) => `y${i}`).join("\n");
    const lines = lineDiff(before, after);
    expect(lines.filter((l) => l.kind === "del")).toHaveLength(3000);
    expect(lines.filter((l) => l.kind === "ins")).toHaveLength(3000);
  });
});
