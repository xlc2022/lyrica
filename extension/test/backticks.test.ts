import { describe, expect, it } from "vitest";
import { parseBackticks } from "../src/backticks.ts";

// The one-time backticks pass (remove with it in the next PR).
describe("the backticks pass's reply", () => {
  it("reads ID-tab-text lines for the notes asked about, and nothing else", () => {
    const asked = new Set(["n:1", "n:2"]);
    const got = parseBackticks("Here you go:\nn:1\tRuns `backup.sh` at `03:00`  \nn:9\tNot asked\nn:2 no tab\n", asked);
    expect([...got]).toEqual([["n:1", "Runs `backup.sh` at `03:00`"]]);
  });
});
