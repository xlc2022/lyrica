import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { malformedCommand, runShellcheck, segments, suspectCommand, type ShellFinding } from "../src/index.ts";

const installed = (() => { try { execFileSync("shellcheck", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("ShellCheck before her bash calls", () => {
  it("lets a command with no findings, or none that block, go on, and skips without ShellCheck", async () => {
    expect(await malformedCommand("rm -rf dist", async () => [])).toBeUndefined();
    expect(await malformedCommand("echo $x", async () => [{ code: 2086, level: "info", line: 1, column: 6, message: "Double quote" }])).toBeUndefined();
    expect(await malformedCommand("rm -rf $DIR", async () => undefined)).toBeUndefined();
    expect(await malformedCommand("rm -rf $DIR", async () => { throw new Error("gone"); })).toBeUndefined();
  });

  it("blocks a finding only in a segment that deletes, or a cd before one", async () => {
    const f = (column: number, code = 2086): ShellFinding[] => [{ code, level: "info", line: 1, column, message: "Double quote to prevent globbing and word splitting." }];
    const line = "echo $a && rm -rf $b";
    expect(await malformedCommand(line, async () => f(6))).toBeUndefined();
    expect(await malformedCommand(line, async () => f(19))).toBe([
      "Not run: ShellCheck found a problem in a command that deletes or moves files.",
      "line 1, column 19: Double quote to prevent globbing and word splitting. (SC2086)",
      "Fix it and run it again. If it is right as written, put `# shellcheck disable=SC2086` on its own line before it.",
    ].join("\n"));
    // A cd that may land elsewhere, before a delete.
    expect(await malformedCommand("cd $d; rm -rf *", async () => f(4))).toBeDefined();
    expect(await malformedCommand("rm -rf x; cd $d", async () => f(14))).toBeUndefined();
    // A code off the list never blocks.
    expect(await malformedCommand("rm *", async () => f(4, 2035))).toBeUndefined();
  });

  it("splits like the shell, keeping substitutions and here-documents whole", () => {
    const parts = (c: string) => segments(c).map(([s, e]) => c.slice(s, e));
    expect(parts("a; b | c && d")).toEqual(["a", " b ", " c ", "", " d"]);
    expect(parts("rm -rf $(find . -name 'x;y')")).toEqual(["rm -rf $(find . -name 'x;y')"]);
    expect(parts("cat <<EOF > f\nrm -rf $dir\nEOF\nls")).toEqual(["cat <<EOF > f\nrm -rf $dir\nEOF\n", "ls"]);
  });

  it("reads a delete behind the shell's own keywords", () => {
    expect(suspectCommand("if true; then rm -rf /tmp/x; fi", "sandbox")).toBe("This deletes a folder and everything in it.");
    expect(suspectCommand("for d in a b; do rm -r $d; done", "sandbox")).toBe("This deletes a folder and everything in it.");
  });

  describe.skipIf(!installed)("with ShellCheck installed", () => {
    it("refuses the deletes written wrong", async () => {
      for (const [command, code] of [
        ['rm -rf "$DIR/"', "SC2115"],
        ["rm -rf $DIR/build", "SC2086"],
        ['rm -rf "$build"/*', "SC2154"],
        ["cd build; rm -rf *", "SC2164"],
        ["rm -rf $(ls)", "SC2046"],
        ["for f in *.log; do rm $f; done", "SC2086"],
        ["if true; then\n  mv $src /tmp\nfi", "SC2086"],
      ]) expect(await malformedCommand(command!), command).toContain(code);
    });
    it("refuses a parse error, since bash would run the lines before it", async () => {
      expect(await malformedCommand('echo one\nrm -rf "$HOME/x')).toMatch(/^Not run: ShellCheck couldn't parse this command/);
    });
    it("lets the rest go on", async () => {
      for (const command of [
        "rm -rf dist", 'rm -rf "${DIR:?}/build"', "cd build && rm -rf ./*", 'dir=/tmp/x; rm -rf "$dir"', "echo $x", "ls $HOME | wc -l",
        "cat <<EOF > notes.sh\nrm -rf $dir\nEOF", "# shellcheck disable=SC2086\nrm -rf $DIR/build", "git status", "npm test 2>&1 | tail -n 20",
      ]) expect(await malformedCommand(command), command).toBeUndefined();
    });
    it("answers within its time limit for a long script", async () => {
      const script = Array.from({ length: 2000 }, (_, i) => `echo "line ${i}"`).join("\n");
      expect(await runShellcheck(script)).toEqual([]);
    });
  });
});
