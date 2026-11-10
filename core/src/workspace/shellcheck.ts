// ShellCheck on her bash calls before they run: a delete or move written
// wrong (an unquoted or unset variable in its path, a `cd` that may fail
// before it) is refused with ShellCheck's own words, so she fixes it
// before anything is gone. Everything else ShellCheck says is left out:
// on a one-line command most of it is style. The command goes to
// ShellCheck on its standard input, never to a file, and nothing of it is
// logged. Without ShellCheck on lyricad's PATH the check is skipped; the
// suspect-command card still asks.

import { spawn } from "node:child_process";
import { simpleCommands, unwrapped } from "./machines.ts";

export interface ShellFinding {
  code: number;
  level: "error" | "warning" | "info" | "style";
  line: number;
  column: number;
  message: string;
}

/** Runs ShellCheck on a command; undefined when it isn't installed, fails or takes too long. */
export type ShellcheckRun = (command: string) => Promise<ShellFinding[] | undefined>;

const TIMEOUT_MS = 3000;

/** ShellCheck from lyricad's PATH, as bash, ignoring any .shellcheckrc, the command on its standard input. */
export const runShellcheck: ShellcheckRun = (command) => new Promise((resolve) => {
  let out = "";
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("shellcheck", ["--norc", "--shell=bash", "--format=json1", "-"], { stdio: ["pipe", "pipe", "ignore"] });
  } catch { resolve(undefined); return; }
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  child.on("error", () => { clearTimeout(timer); resolve(undefined); });
  child.stdout!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
  child.stdin!.on("error", () => {});
  child.on("close", (code) => {
    clearTimeout(timer);
    // 0: nothing found; 1: findings. Anything else (a bad option, a kill) means no answer.
    if (code !== 0 && code !== 1) { resolve(undefined); return; }
    try {
      const comments = (JSON.parse(out) as { comments: ShellFinding[] }).comments;
      resolve(comments.map(({ code, level, line, column, message }) => ({ code, level, line, column, message })));
    } catch { resolve(undefined); }
  });
  child.stdin!.end(command);
});

/**
 * What blocks inside a command that deletes or moves files, or a `cd` before
 * one: word splitting or globbing of an unquoted expansion (2086, 2046,
 * 2048, 2068), a path that may expand to `/` (2115), a system folder (2114),
 * a lowercase variable the line never sets (2154: each call is a fresh shell,
 * so it is empty), and a `cd` that may fail with the rest run anyway (2164).
 * A short, fixed list.
 */
export const BLOCKS_IN_DELETE: ReadonlySet<number> = new Set([2086, 2046, 2048, 2068, 2115, 2114, 2154, 2164]);

/** Programs that delete or move files. */
const DELETES = new Set(["rm", "rmdir", "unlink", "shred", "mv", "truncate"]);

/** Whether one simple command deletes or moves files. */
function deletes(words: string[]): boolean {
  const w = unwrapped(words);
  if (!w.length) return false;
  if (DELETES.has(w[0]!)) return true;
  if (w[0] === "find") return w.includes("-delete");
  if (w[0] === "rsync") return w.some((a) => a.startsWith("--delete") || a === "--remove-source-files");
  if (w[0] === "git") return w.includes("clean") || w.includes("rm");
  return false;
}

/**
 * The command's segments, split where simpleCommands splits (unquoted
 * `; & | ( ) { }` and newlines), as [start, end) offsets. A substitution or a
 * here-document's body stays in the segment that holds it; a third offset
 * ends the segment's own command line, before any body.
 */
export function segments(command: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  let start = 0, quote = "";
  const heredocs: { word: string; tabs: boolean }[] = [];
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (ch === "'" || ch === '"') {
      if (!quote) quote = ch; else if (quote === ch) quote = "";
      continue;
    }
    if (quote === "'") continue;
    if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
      let depth = 1, end = i + (ch === "`" ? 1 : 2);
      for (; end < command.length; end++) {
        if (ch === "`" && command[end] === "`") break;
        if (ch !== "`") { if (command[end] === "(") depth++; if (command[end] === ")" && --depth === 0) break; }
      }
      i = end; continue;
    }
    if (quote) continue;
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(command.slice(i));
      if (m) { heredocs.push({ word: m[3]!, tabs: m[1] === "-" }); i += m[0].length - 1; continue; }
    }
    if (ch === "\n" && heredocs.length) {
      // The bodies follow this line; they belong to the command that reads them.
      let at = i + 1;
      for (const h of heredocs.splice(0)) {
        while (at < command.length) {
          const nl = command.indexOf("\n", at);
          const line = command.slice(at, nl < 0 ? command.length : nl);
          at = nl < 0 ? command.length : nl + 1;
          if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.word) break;
        }
      }
      out.push([start, at, i]); start = at; i = at - 1; continue;
    }
    if (/[;&|\n(){}]/.test(ch)) { out.push([start, i, i]); start = i + 1; }
  }
  out.push([start, command.length, command.length]);
  return out;
}

/** The offset of a 1-based line and column (ShellCheck's json1 counts a tab as one column). */
function offset(command: string, line: number, column: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const nl = command.indexOf("\n", at);
    if (nl < 0) return command.length;
    at = nl + 1;
  }
  return at + column - 1;
}

/**
 * The findings that keep a command from running: any parse error (bash
 * would run the lines before it, then stop), and those in BLOCKS_IN_DELETE
 * that fall in a segment that deletes or moves files, or in a `cd`/`pushd`
 * before one.
 */
export function blocking(command: string, findings: ShellFinding[]): ShellFinding[] {
  const segs = segments(command);
  const del = segs.map(([s, , h]) => simpleCommands(command.slice(s, h)).some(deletes));
  const counts = segs.map(([s, , h], i) => {
    if (del[i]) return true;
    const first = unwrapped(simpleCommands(command.slice(s, h))[0] ?? []);
    return (first[0] === "cd" || first[0] === "pushd") && del.slice(i + 1).some(Boolean);
  });
  return findings.filter((f) => {
    if (f.code < 2000) return f.level === "error";
    if (!BLOCKS_IN_DELETE.has(f.code)) return false;
    const at = offset(command, f.line, f.column);
    const i = segs.findIndex(([s, e]) => at >= s && at < Math.max(e, s + 1));
    return i >= 0 && counts[i]!;
  });
}

/** The refusal for a command ShellCheck finds malformed where it deletes, or undefined to let it go on. */
export async function malformedCommand(command: string, run: ShellcheckRun = runShellcheck): Promise<string | undefined> {
  const findings = await run(command).catch(() => undefined);
  if (!findings?.length) return undefined;
  const hits = blocking(command, findings);
  if (!hits.length) return undefined;
  const lines = hits.map((f) => `line ${f.line}, column ${f.column}: ${f.message} (SC${f.code})`);
  const codes = [...new Set(hits.map((f) => `SC${f.code}`))].join(",");
  const parse = hits.every((f) => f.code < 2000);
  return [
    parse ? "Not run: ShellCheck couldn't parse this command, and bash would run the lines before the error." : "Not run: ShellCheck found a problem in a command that deletes or moves files.",
    ...lines,
    parse ? "Fix it and run it again." : `Fix it and run it again. If it is right as written, put \`# shellcheck disable=${codes}\` on its own line before it.`,
  ].join("\n");
}
