import { describe, expect, it } from "vitest";
import { cleanOutput, foldOutput, jobNotice, MAX_COLUMN, SCREEN_ROWS, Terminal } from "../src/workspace/index.ts";

describe("command output as a terminal shows it", () => {
  it("keeps a progress bar redrawn with carriage returns at its latest state", () => {
    expect(foldOutput("Downloading\n 10%\r 55%\r100%\ndone\n")).toBe("Downloading\n100%\ndone\n");
    // A shorter redraw leaves the old line's end, as a terminal does, unless the tool erases it.
    expect(foldOutput("12345\rab")).toBe("ab345");
    expect(foldOutput("12345\rab\x1b[K")).toBe("ab");
    expect(foldOutput("ab\bc\r\n")).toBe("ac\n");
  });

  it("plays lines redrawn with cursor moves, as Docker's terminal mode draws its layers", () => {
    const frames = "a1 Waiting\na2 Waiting\n"
      + "\x1b[2A\x1b[2Ka1 Downloading 1.2GB\n\x1b[2Ka2 Waiting\n"
      + "\x1b[2A\x1b[2Ka1 \x1b[32mPull complete\x1b[0m\n\x1b[2Ka2 Pull complete\n";
    expect(foldOutput(frames)).toBe("a1 Pull complete\na2 Pull complete\n");
  });

  it("drops colours, titles and other sequences, and takes a sequence split between pieces", () => {
    expect(foldOutput("\x1b]0;title\x07\x1b[1;31merror\x1b[0m \x1b[?25lok\x1b(B")).toBe("error ok");
    const t = new Terminal().write("50%\x1b[").write("2K\r").write("\ud83d").write("\ude00 done");
    expect(t.text()).toBe("😀 done");
  });

  it("adds a note after everything shown, wherever the cursor was moved", () => {
    const t = new Terminal().write("a 1\nb 1\n\x1b[2A");
    expect(t.toEnd().write("\n[skipped]\n").text()).toBe("a 1\nb 1\n\n[skipped]\n");
  });

  it("keeps plain output byte for byte", () => {
    const plain = "cbb9175a9bc5 Downloading 1.189GB\ncbb9175a9bc5 Downloading 1.191GB\n\ttab, 你好\n";
    expect(foldOutput(plain)).toBe(plain);
  });

  it("stays bounded and linear on crafted moves", () => {
    expect(foldOutput("\x1b[99999999Gx").length).toBe(MAX_COLUMN + 1);
    const lines = Array.from({ length: SCREEN_ROWS + 10 }, (_, i) => `line ${i}`).join("\n");
    // Up past the screen stops at its top: the first lines have scrolled out and stay.
    expect(foldOutput(`${lines}\x1b[99999A\rX`).split("\n").slice(0, 11)).toEqual([...Array.from({ length: 10 }, (_, i) => `line ${i}`), "Xine 10"]);
    const crafted = "\x1b[999999B\x1b[999999A\r\x1b[2J".repeat(4096) + "x\r".repeat(1 << 20);
    const start = performance.now();
    foldOutput(crafted);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("stays linear on erases and jumps that redo work, and gives no more than the output paid for", () => {
    const time = (input: string) => { const start = performance.now(); const out = foldOutput(input); return { ms: performance.now() - start, out }; };
    // Erase to the cursor at the end of an ever longer line (PR review's case: 27.9 s before).
    expect(time(("a".repeat(4000) + "\x1b[1K").repeat(4000)).ms).toBeLessThan(2000);
    // A jump far right, then erase to it, then back to the start: each erase would blank 4,096 cells.
    expect(time(`${"y".repeat(5000)}${"\x1b[1Gx\x1b[4000G\x1b[1K".repeat(1 << 20)}`).ms).toBeLessThan(2000);
    // Clearing every line above, from the screen's last line, over and over.
    expect(time(`${"l\n".repeat(SCREEN_ROWS)}${"\x1b[1J".repeat(1 << 21)}`).ms).toBeLessThan(2000);
    // Jumps that pad a line with spaces: what comes back can't outgrow the output by much.
    const pad = "\x1b[4096Gx\n".repeat(1 << 20);
    const padded = time(pad);
    expect(padded.ms).toBeLessThan(2000);
    expect(padded.out.length).toBeLessThan(2 * pad.length + 65536);
    const cleared = time("\x1b[256;1H\x1b[2J".repeat(1 << 20));
    expect(cleared.out.length).toBe(0);
    // One huge line overwritten at its start.
    expect(time(`${"x".repeat(16 << 20)}\rY`).out.slice(0, 2)).toBe("Yx");
  });

  it("starts its note in plain text even when a gap lands inside a sequence", () => {
    const t = new Terminal().write("ok\x1b[");
    expect(t.toEnd().write("\n[skipped]\n").text()).toBe("ok\n[skipped]\n");
  });

  it("keeps a machine's carriage returns and cursor moves for the fold, and still strips the rest", () => {
    const got: string[] = [];
    const clean = cleanOutput((d) => got.push(d.toString()));
    clean.push(Buffer.from(" 10%\r100%\x1b[K\n\x1b[1A\x1b[31mred\x1b[0m\x07\n"));
    clean.end();
    expect(got.join("")).toBe(" 10%\r100%\x1b[K\n\x1b[1Ared\n");
    expect(foldOutput(got.join(""))).toBe("red%\n");
  });

  it("gives her job notice the latest state", () => {
    const job = { id: "j1", command: "curl -O x", place: "sandbox", state: "exited" as const, exitCode: 0, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:05Z", cwd: "/" };
    expect(jobNotice(job as never, " 1%\r 50%\r100%\n")).toMatch(/Last output:\n100%$/);
  });
});
