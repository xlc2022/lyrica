import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandOutputs, cutMarker, KeptOutput, LiveText, matchingLines, migrate, openEncrypted, outputPage, sortOutputs, type CommandOutput } from "../src/index.ts";
import { Jobs } from "../src/workspace/jobs.ts";
import type { ExecutionTarget } from "../src/workspace/ops.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function store(threadBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-outputs-"));
  dirs.push(dir);
  const db = openEncrypted(join(dir, "general.db"), { raw: Buffer.alloc(32, 7) });
  migrate(db, "pool");
  db.prepare("INSERT INTO threads (id, interface, created_at) VALUES ('web/t1', 'web', '2026-01-01')").run();
  return { db, outputs: new CommandOutputs(db, threadBytes) };
}

const cmd = (id: string, o: Partial<CommandOutput> = {}): CommandOutput => ({
  id, kind: id.startsWith("j") ? "job" : "call", place: "nautica", command: "./install.sh --yes", cwd: "/home/lyrica",
  startedAt: "2026-11-16T01:00:00.000Z", endedAt: "2026-11-16T01:05:00.000Z", state: "exited", exitCode: 0, bytes: 0, dropped: 0, ...o,
});

describe("command output", () => {
  it("keeps a command's first part and its end, marking the cut, so a long build keeps both its start and its error", () => {
    const k = new KeptOutput(100, 40);
    k.push(Buffer.from("a".repeat(30)));
    k.push(Buffer.from("b".repeat(30)));
    k.push(Buffer.from("c".repeat(80)));
    expect(k.bytes).toBe(140);
    expect(k.dropped).toBe(40);
    const kept = k.buffer().toString();
    expect(kept.startsWith("a".repeat(30) + "b".repeat(10))).toBe(true);
    expect(kept).toContain(cutMarker(40));
    expect(kept.endsWith("b".repeat(0) + "c".repeat(60))).toBe(true);
    // Nothing cut: as it came.
    const small = new KeptOutput();
    small.push(Buffer.from("ok\n"));
    expect(small.buffer().toString()).toBe("ok\n");
  });

  it("keeps commands with their thread, finds them by call, searches name, command and output, and goes with the thread", () => {
    const { db, outputs } = store();
    outputs.save("web/t1", cmd("c1", { call: "call-1" }), Buffer.from("Linux nautica 6.12\n"));
    outputs.save("web/t1", cmd("j1", { name: "Pull the host images", startedAt: "2026-11-16T01:01:00.000Z" }), Buffer.from("pulling llamacpp\nerror: manifest unknown\n"));
    outputs.save("web/t1", cmd("j2", { command: "docker compose build", startedAt: "2026-11-16T01:02:00.000Z" }), Buffer.from("built\n"));
    expect(outputs.lastNumber("web/t1", "c")).toBe(1);
    expect(outputs.lastNumber("web/t1", "j")).toBe(2);
    expect(outputs.byCall("web/t1", "call-1")?.id).toBe("c1");
    expect(outputs.text("web/t1", "j1")).toContain("manifest unknown");
    expect(outputs.list("web/t1", "job").map((j) => j.id).sort()).toEqual(["j1", "j2"]);
    expect(outputs.list("web/t1", "job", "MANIFEST").map((j) => j.id)).toEqual(["j1"]);
    expect(outputs.list("web/t1", "job", "host images").map((j) => j.id)).toEqual(["j1"]);
    expect(outputs.list("web/t1", "job", "compose").map((j) => j.id)).toEqual(["j2"]);
    db.prepare("DELETE FROM threads WHERE id = 'web/t1'").run();
    expect(outputs.list("web/t1", "job")).toEqual([]);
  });

  it("empties a thread's oldest outputs past its limit, keeping the newest whole", () => {
    const { outputs } = store(1000);
    const big = Buffer.alloc(500, 0x61);
    outputs.save("web/t1", cmd("c1", { startedAt: "2026-11-16T01:00:00.000Z", bytes: big.length }), big);
    outputs.save("web/t1", cmd("c2", { startedAt: "2026-11-16T01:01:00.000Z", bytes: big.length }), big);
    outputs.save("web/t1", cmd("c3", { startedAt: "2026-11-16T01:02:00.000Z", bytes: big.length }), big);
    expect(outputs.text("web/t1", "c1")).toContain("bytes left out here");
    expect(outputs.get("web/t1", "c1")?.dropped).toBe(big.length);
    expect(outputs.text("web/t1", "c3")).toHaveLength(big.length);
  });

  it("gives her a numbered page, the next line to go on from, and matches for a pattern", async () => {
    const text = Array.from({ length: 500 }, (_, i) => (i === 420 ? "E: Unable to locate package nvidia-driver" : `line ${i + 1}`)).join("\n");
    const page = await outputPage(text, { from: 1, lines: 3 });
    expect(page).toBe("Lines 1-3 of 500; from: 4 goes on:\n  1  line 1\n  2  line 2\n  3  line 3");
    expect(await outputPage(text, { pattern: "unable to locate" })).toBe("1 of 500 lines match:\n421  E: Unable to locate package nvidia-driver");
    expect(await outputPage(text, { pattern: "unable|refused" })).toMatch(/^1 of 500 lines match/);
    expect(() => outputPage(text, { pattern: "(" })).toThrow(/isn't a regular expression/);
    expect(() => outputPage(text, { pattern: "(?<=E: )Unable" })).toThrow(/lookaround/);
    expect(() => outputPage(text, { pattern: "a".repeat(201) })).toThrow(/200 characters/);
    // RE2 is linear: what makes JavaScript's engine backtrack for minutes is quick here.
    const started = Date.now();
    expect(await outputPage("a".repeat(50_000) + "b", { pattern: "(a+)+$" })).toBe("No line of 1 matches (a+)+$.");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("finds matching lines in one pass: anchors per line, a line once however often it matches, any script", () => {
    const text = "ok\nE: one E: two\nok\nnée: café\nE: last";
    expect(matchingLines(text, "^e:")).toEqual([1, 4]);
    expect(matchingLines(text, "e:")).toEqual([1, 3, 4]);
    expect(matchingLines(text, "caf[ée]$")).toEqual([3]);
    expect(matchingLines(text, "^$")).toEqual([]);
    expect(matchingLines("a\n\nb", "^$")).toEqual([1]);
  });

  it("cuts a line too long for a page rather than leaving it out, so from always moves on", async () => {
    const text = "a\n" + "x".repeat(70_000) + "\nb\n";
    const page = await outputPage(text, { from: 2, lines: 5 });
    expect(page).toMatch(/^Lines 2-3 of 3:\n2  x+ \[… [\d,]+ more characters\]\n3  b$/);
    expect(page.length).toBeLessThanOrEqual(60_100);
    expect(await outputPage(text, { pattern: "xxx" })).toMatch(/^1 of 3 lines match:\n2  x+ \[…/);
  });

  it("never splits a character between two live pieces", () => {
    const live = new LiveText();
    const bytes = Buffer.from("née ✓ ok");
    const a = live.piece(0, bytes.subarray(0, 2));   // "n" and half of "é"
    const b = live.piece(2, bytes.subarray(2, 7));   // the rest of "é", "e ", two of "✓"'s three bytes
    const c = live.piece(7, bytes.subarray(7));
    expect([a, b, c].map((p) => p.data).join("")).toBe("née ✓ ok");
    expect(a).toEqual({ at: 0, to: 1, data: "n" });
    expect(b.at).toBe(1);
    expect(c.to).toBe(bytes.length);
    expect([a, b, c].every((p) => !p.data.includes("\ufffd"))).toBe(true);
  });

  it("sorts newest, oldest, running first and longest", () => {
    const a = cmd("j1", { startedAt: "2026-11-16T01:00:00.000Z", endedAt: "2026-11-16T01:30:00.000Z" });
    const b = cmd("j2", { startedAt: "2026-11-16T01:10:00.000Z", endedAt: "2026-11-16T01:11:00.000Z" });
    const c = cmd("j3", { startedAt: "2026-11-16T01:05:00.000Z", state: "running", endedAt: undefined });
    const now = Date.parse("2026-11-16T01:12:00.000Z");
    expect(sortOutputs([a, b, c], "newest", now).map((j) => j.id)).toEqual(["j2", "j3", "j1"]);
    expect(sortOutputs([a, b, c], "oldest", now).map((j) => j.id)).toEqual(["j1", "j3", "j2"]);
    expect(sortOutputs([a, b, c], "running", now).map((j) => j.id)).toEqual(["j3", "j2", "j1"]);
    expect(sortOutputs([a, b, c], "longest", now).map((j) => j.id)).toEqual(["j1", "j3", "j2"]);
  });

  it("names a job, streams its output, keeps it with the thread when it ends, and goes on numbering after a restart", async () => {
    const thread = { userId: "u1", pool: "general", threadId: "web/t1" };
    const pieces: string[] = [];
    const saved: { job: CommandOutput; output: string }[] = [];
    const target = {
      ops: () => ({ bash: { exec: async (_c: string, _d: string, o: { onData: (d: Buffer) => void }) => { o.onData(Buffer.from("step 1\n")); o.onData(Buffer.from("done\n")); return { exitCode: 0 }; } } }),
    } as unknown as ExecutionTarget;
    const ended = new Promise<void>((resolve) => {
      const jobs = new Jobs(() => resolve(), 10, {
        seed: () => 4,
        data: (_t, _j, at, d) => pieces.push(`${at}:${d.toString()}`),
        save: (_t, job, output) => saved.push({ job, output: output.toString() }),
      });
      const job = jobs.start(thread, "sandbox", target, "docker compose pull --ignore-buildable", "/workspace", 60, { name: "Pull the host images", call: "call-9" });
      expect(job).toMatchObject({ id: "j5", name: "Pull the host images", call: "call-9" });
    });
    await ended;
    expect(pieces).toEqual(["0:step 1\n", "7:done\n"]);
    expect(saved[0]).toMatchObject({ job: { id: "j5", kind: "job", name: "Pull the host images", state: "exited", exitCode: 0, bytes: 12 }, output: "step 1\ndone\n" });
  });
});
