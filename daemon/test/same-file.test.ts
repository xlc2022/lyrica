import { describe, expect, it } from "vitest";
import { SAME_FILE_MS, SameFile } from "../src/same-file.ts";

function setup(gone: string[] = []) {
  let now = 1_000_000;
  const told: { to: string; from: string; text: string }[] = [];
  const s = new SameFile({ exists: (_u, _p, t) => !gone.includes(t), tell: (_u, _p, to, from, text) => told.push({ to, from, text }), now: () => now });
  return { s, told, later: (ms: number) => { now += ms; } };
}

describe("two threads changing one file", () => {
  it("holds the second thread once, tells the first, and lets both go on after", () => {
    const { s, told, later } = setup();
    expect(s.claim("u", "general", "a", "grant:/repo/app.ts", "/repo/app.ts")).toBeUndefined();
    later(5 * 60_000);
    const held = s.claim("u", "general", "b", "grant:/repo/app.ts", "/repo/app.ts");
    expect(held).toMatch(/^Not changed yet: \[t:a\] changed \/repo\/app\.ts 5 min ago/);
    expect(told).toEqual([{ to: "a", from: "b", text: expect.stringMatching(/^\[t:b\] is about to change \/repo\/app\.ts, which you changed 5 min ago/) }]);
    // Each goes on now, without either being held again.
    expect(s.claim("u", "general", "b", "grant:/repo/app.ts", "/repo/app.ts")).toBeUndefined();
    expect(s.claim("u", "general", "a", "grant:/repo/app.ts", "/repo/app.ts")).toBeUndefined();
    expect(s.claim("u", "general", "b", "grant:/repo/app.ts", "/repo/app.ts")).toBeUndefined();
    expect(told).toHaveLength(1);
  });

  it("leaves a thread alone in its own files, in another pool, after a while, or once the other thread is gone", () => {
    const { s, told, later } = setup(["gone"]);
    s.claim("u", "general", "a", "grant:/repo/app.ts", "/repo/app.ts");
    expect(s.claim("u", "general", "b", "grant:/repo/other.ts", "/repo/other.ts")).toBeUndefined();
    expect(s.claim("u", "private", "b", "grant:/repo/app.ts", "/repo/app.ts")).toBeUndefined();
    expect(s.claim("u", "general", "b", undefined, "/tmp/x")).toBeUndefined();
    later(SAME_FILE_MS);
    expect(s.claim("u", "general", "b", "grant:/repo/app.ts", "/repo/app.ts")).toBeUndefined();
    s.claim("u", "general", "gone", "grant:/repo/b.ts", "/repo/b.ts");
    expect(s.claim("u", "general", "c", "grant:/repo/b.ts", "/repo/b.ts")).toBeUndefined();
    expect(told).toEqual([]);
  });
});
