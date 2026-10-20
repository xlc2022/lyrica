import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ExecutionTarget } from "@lyrica/core";

// Principles 2 and 6: a project's checks run when a code turn ends, whatever the model decides,
// so "done" means the person's own commands passed (docs/workspace.md, "Project checks").

/** Shown in the thread: which checks passed or failed. */
export const CHECKS_NOTICE = "lyrica-checks";
/** Told to her, unseen: what failed, so she fixes it in the same turn. */
export const CHECKS_FAILED = "lyrica-checks-failed";
export const CHECK_ROUNDS = 3;
export const CHECK_TIMEOUT_MS = 10 * 60_000;
const TAIL_LINES = 60;
const TAIL_CHARS = 4000;

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
}

/** The last lines of a check's output, within the character limit. */
export function tail(output: string): string {
  const lines = output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  return lines.length > TAIL_CHARS ? lines.slice(-TAIL_CHARS) : lines;
}

async function runCheck(target: ExecutionTarget, dir: string | undefined, command: string): Promise<{ ok: boolean; output: string }> {
  if (!target.run) return { ok: false, output: "This thread can't run commands here." };
  const argv = dir ? ["sh", "-c", 'cd "$1" && sh -c "$2" 2>&1', "sh", dir, command] : ["sh", "-c", `${command} 2>&1`];
  try {
    const r = await target.run(argv, { timeoutMs: CHECK_TIMEOUT_MS });
    const output = r.stdout.toString() + r.stderr.toString();
    return { ok: r.code === 0, output: r.code === null ? `${output}\n(stopped after ${CHECK_TIMEOUT_MS / 60_000} minutes)` : output };
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
}

export function createChecksExtension(o: ChecksOptions): ExtensionFactory {
  return (pi) => {
    let changed = false;
    let rounds = 0;
    pi.on("agent_start", () => { changed = false; rounds = 0; });
    pi.on("tool_result", (e) => {
      if (!e.isError && (e.toolName === "edit" || e.toolName === "write" || e.toolName === "bash")) changed = true;
    });
    pi.on("turn_end", async (e) => {
      // Her reply ends the run: no tool calls, and not cut off by an error, a stop or the tool limit's wrap-up.
      if (!changed || rounds >= CHECK_ROUNDS || e.message.role !== "assistant") return;
      if (e.message.content.some((c) => c.type === "toolCall") || e.message.stopReason === "error" || e.message.stopReason === "aborted") return;
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
          const r = await runCheck(target, dir, command);
          if (!r.ok) { ok = false; failed.push({ command, ...(dir ? { dir } : {}), output: tail(r.output) }); }
        }
        if (ok) passed.push(command);
      }
      const list = (cs: string[]) => cs.map((c) => `\`${c}\``).join(", ");
      if (!failed.length) {
        changed = false;
        return { entries: [{ type: "custom_message", customType: CHECKS_NOTICE, content: `Checks passed: ${list(passed)}`, display: true }] };
      }
      // Still pending: her next reply ending the run is checked again, edits or not.
      rounds++;
      const last = rounds >= CHECK_ROUNDS;
      const detail = failed.map((f) => `$ ${f.command}${f.dir ? ` (in ${f.dir})` : ""}\n${f.output}`).join("\n\n");
      const ask = last
        ? `The project's checks still fail after ${CHECK_ROUNDS} rounds, so they won't run again this turn. Stop here and tell the person plainly what fails and why: the work isn't done.`
        : "The project's checks failed. Fix what they report, then finish: they run again when you end your turn.";
      pi.sendMessage({ customType: CHECKS_FAILED, content: `${ask}\n\n${detail}`, display: false }, { deliverAs: "followUp", triggerTurn: true });
      return { entries: [{ type: "custom_message", customType: CHECKS_NOTICE, content: `Checks failed: ${list([...new Set(failed.map((f) => f.command))])}${passed.length ? `. Passed: ${list(passed)}` : ""}`, display: true }] };
    });
  };
}
