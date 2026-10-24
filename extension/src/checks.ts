import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { maskSecrets, type ExecutionTarget } from "@lyrica/core";

// Principles 2 and 6: a project's checks run when a code turn ends, whatever the model decides,
// so "done" means the person's own commands passed (docs/workspace.md, "Project checks").

/** Shown in the thread: which checks passed or failed. */
export const CHECKS_NOTICE = "lyrica-checks";
/** A CHECKS_NOTICE entry's details, which the thread's notice shows. */
export interface ChecksResult { ok: boolean; failed: string[]; passed: string[] }
/** Told to her, unseen: what failed, so she fixes it in the same turn. */
export const CHECKS_FAILED = "lyrica-checks-failed";
export const CHECK_ROUNDS = 3;
export const CHECK_TIMEOUT_MS = 10 * 60_000;
const TAIL_LINES = 60;
const TAIL_CHARS = 4000;
/** The most of each failing output the thread's parent is told when the rounds run out. */
const REPORT_LINES = 20;
const REPORT_CHARS = 1500;

export interface ChecksOptions {
  /** The project's checks now; none outside a project or in its chat. */
  checks(): string[];
  /** Whether the thread is in code mode now. */
  code(): boolean;
  /** Whether it is in Plan mode, where nothing changes. */
  plan(): boolean;
  /** Where its code lives (checkoutsOf); none runs each check once in its folder. */
  checkouts(): string[];
  target(): ExecutionTarget;
  /** The checks still fail after the last round: lyricad tells the thread's parent, if it has one (docs/delegation.md). */
  exhausted?(report: string): void;
}

/** The last lines of a check's output, within the character limit. */
export function tail(output: string, maxLines = TAIL_LINES, maxChars = TAIL_CHARS): string {
  const lines = output.trimEnd().split("\n").slice(-maxLines).join("\n");
  return lines.length > maxChars ? lines.slice(-maxChars) : lines;
}

/** A checkout's short head commit, for the parent's report; none when it isn't one. */
async function headOf(target: ExecutionTarget, dir: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  if (!target.run) return undefined;
  try {
    const r = await target.run(dir ? ["git", "-C", dir, "rev-parse", "--short", "HEAD"] : ["git", "rev-parse", "--short", "HEAD"], { timeoutMs: 10_000, signal });
    return r.code === 0 ? r.stdout.toString().trim() || undefined : undefined;
  } catch { return undefined; }
}

async function runCheck(target: ExecutionTarget, dir: string | undefined, command: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  if (!target.run) return { ok: false, output: "This thread can't run commands here." };
  const argv = dir ? ["sh", "-c", 'cd "$1" && sh -c "$2" 2>&1', "sh", dir, command] : ["sh", "-c", `${command} 2>&1`];
  const stopped = `(stopped after ${CHECK_TIMEOUT_MS / 60_000} minutes)`;
  try {
    const r = await target.run(argv, { timeoutMs: CHECK_TIMEOUT_MS, signal });
    // Masked as her bash tool's output is: a check can print a token it reads.
    const secrets = target.secrets?.() ?? [];
    const output = maskSecrets(r.stdout, secrets).toString() + maskSecrets(r.stderr, secrets).toString();
    return { ok: r.code === 0, output: r.code === null ? `${output}\n${stopped}` : output };
  } catch (err) {
    const message = (err as Error).message;
    return { ok: false, output: message.startsWith("timeout:") ? stopped : message };
  }
}

export function createChecksExtension(o: ChecksOptions): ExtensionFactory {
  return (pi) => {
    let changed = false;
    let rounds = 0;
    pi.on("agent_start", () => { changed = false; rounds = 0; });
    pi.on("tool_result", (e) => {
      // A delegate counts too: a single coder writes in the thread's own checkouts (docs/delegation.md).
      if (!e.isError && ["edit", "write", "bash", "delegate"].includes(e.toolName)) changed = true;
    });
    pi.on("turn_end", async (e, ctx) => {
      // Her reply ends the run: no tool calls, and not cut off by an error, a stop or the tool limit's wrap-up.
      if (!changed || rounds >= CHECK_ROUNDS || e.message.role !== "assistant") return;
      if (e.message.content.some((c) => c.type === "toolCall") || e.message.stopReason === "error" || e.message.stopReason === "aborted") return;
      // A reply with only thinking isn't one: turn-tools asks her to carry on.
      if (!e.message.content.some((c) => c.type === "text" && c.text.trim())) return;
      if (!pi.getActiveTools().length) return;
      const checks = o.checks();
      if (!checks.length || !o.code() || o.plan()) return;
      const target = o.target();
      const dirs: (string | undefined)[] = o.checkouts();
      if (!dirs.length) dirs.push(undefined);
      const passed: string[] = [];
      const failed: { command: string; dir?: string; output: string }[] = [];
      for (const command of checks) {
        let ok = true;
        for (const dir of dirs) {
          if (ctx.signal?.aborted) return;
          const r = await runCheck(target, dir, command, ctx.signal);
          if (!r.ok) { ok = false; failed.push({ command, ...(dir ? { dir } : {}), output: tail(r.output) }); }
        }
        if (ok) passed.push(command);
      }
      // Stopped by the person: no notice, no follow-up.
      if (ctx.signal?.aborted) return;
      const list = (cs: string[]) => cs.map((c) => `\`${c}\``).join(", ");
      if (!failed.length) {
        changed = false;
        const details: ChecksResult = { ok: true, failed: [], passed };
        return { entries: [{ type: "custom_message", customType: CHECKS_NOTICE, content: `Checks passed: ${list(passed)}`, display: true, details }] };
      }
      // Still pending: her next reply ending the run is checked again, edits or not.
      rounds++;
      const last = rounds >= CHECK_ROUNDS;
      const detail = failed.map((f) => `$ ${f.command}${f.dir ? ` (in ${f.dir})` : ""}\n${f.output}`).join("\n\n");
      const ask = last
        ? `The project's checks still fail after ${CHECK_ROUNDS} rounds, so they won't run again this turn. Stop here and tell the person plainly what fails and why: the work isn't done.`
        : "The project's checks failed. Fix what they report, then finish: they run again when you end your turn.";
      pi.sendMessage({ customType: CHECKS_FAILED, content: `${ask}\n\n${detail}`, display: false }, { deliverAs: "followUp", triggerTurn: true });
      if (last && o.exhausted) {
        // lyricad, not her, tells the parent: a thread told to stop may not report (docs/delegation.md).
        const heads = new Map<string | undefined, string | undefined>();
        for (const f of failed) if (!heads.has(f.dir)) heads.set(f.dir, await headOf(target, f.dir, ctx.signal));
        const where = (f: { dir?: string }) => [f.dir && `in ${f.dir}`, heads.get(f.dir) && `at ${heads.get(f.dir)}`].filter(Boolean).join(", ");
        o.exhausted(failed.map((f) => `$ ${f.command}${where(f) ? ` (${where(f)})` : ""}\n${tail(f.output, REPORT_LINES, REPORT_CHARS)}`).join("\n\n"));
      }
      const details: ChecksResult = { ok: false, failed: [...new Set(failed.map((f) => f.command))], passed };
      return { entries: [{ type: "custom_message", customType: CHECKS_NOTICE, content: `Checks failed: ${list(details.failed)}${passed.length ? `. Passed: ${list(passed)}` : ""}`, display: true, details }] };
    });
  };
}
