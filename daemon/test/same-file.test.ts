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

describe("a command that changed a file another thread changed", () => {
  it("tells both threads after the fact, once, and holds the other thread's next write", () => {
    const { s, told, later } = setup();
    s.claim("u", "general", "a", "folder:shared/notes.md", "/shared/notes.md");
    later(3 * 60_000);
    const since = 1_000_000 + 3 * 60_000;
    later(1000);
    s.changed("u", "general", "b", "folder:shared/notes.md", "/shared/notes.md", since);
    expect(told).toEqual([
      { to: "a", from: "b", text: expect.stringMatching(/^\[t:b\] changed \/shared\/notes\.md with a command, which you changed 3 min before/) },
      { to: "b", from: "a", text: expect.stringMatching(/^Your command changed \/shared\/notes\.md, which \[t:a\] changed 3 min before/) },
    ]);
    // Both were told: each goes on, and another command tells nobody again.
    expect(s.claim("u", "general", "a", "folder:shared/notes.md", "/shared/notes.md")).toBeUndefined();
    s.changed("u", "general", "b", "folder:shared/notes.md", "/shared/notes.md", since + 60_000);
    expect(told).toHaveLength(2);

    // A third thread's command is recorded as its own, so the first thread's next write is held.
    s.changed("u", "general", "c", "folder:shared/plan.md", "/shared/plan.md", since);
    expect(s.claim("u", "general", "a", "folder:shared/plan.md", "/shared/plan.md")).toMatch(/^Not changed yet: \[t:c\] changed/);
  });

  it("leaves a change made while the command ran alone, and its own files", () => {
    const { s, told, later } = setup();
    const since = 1_000_000;
    later(1000);
    s.claim("u", "general", "a", "folder:shared/notes.md", "/shared/notes.md");
    s.changed("u", "general", "b", "folder:shared/notes.md", "/shared/notes.md", since);
    s.changed("u", "general", "b", undefined, "/workspace/x", since);
    expect(told).toEqual([]);
    // Still a's: b's write is held.
    expect(s.claim("u", "general", "b", "folder:shared/notes.md", "/shared/notes.md")).toMatch(/^Not changed yet: \[t:a\]/);
  });
});
