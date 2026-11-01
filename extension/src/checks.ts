import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { maskSecrets, type ExecutionTarget } from "@lyrica/core";
import { continueAsk, EVIDENCE_CONTINUE, EVIDENCE_NOTICE, EVIDENCE_ROUNDS, judgePrompt, parseVerdict, type EvidenceResult, type JudgedCall, type Verdict } from "./evidence.ts";

// Principles 2 and 6: a project's checks run when a code turn ends, whatever the model decides,
// so "done" means the person's own commands passed (docs/workspace.md, "Project checks").
// Once they pass, or where there are none, the evidence check asks the thread's own code
// model whether the turn's tool results show the work done (docs/briefs/code-evidence.md).

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
  /**
   * The evidence check: one call to the thread's own `code` model list, answering the judge prompt. None in a
   * project chat or a subagent. A throw, or an answer that isn't a verdict, counts as done and is said in the notice.
   */
  judge?(prompt: { system: string; user: string }, signal?: AbortSignal): Promise<string>;
  /** The thread's Code task, as her prompt carries it, for the judge. */
  codeTask?(): string | undefined;
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

type Entry = { type: "custom_message"; customType: string; content: string; display: boolean; details: unknown };

export function createChecksExtension(o: ChecksOptions): ExtensionFactory {
  return (pi) => {
    let changed = false;
    let rounds = 0;
    /** The evidence check's rounds this run, and the reason it gave last: the same one again ends them. */
    let judged = 0;
    let lastReason: string | undefined;
    /** What started the run, and each tool call with its result, for the judge. Kept in memory for the run only. */
    let request = "";
    let calls: JudgedCall[] = [];
    pi.on("agent_start", () => { changed = false; rounds = 0; judged = 0; lastReason = undefined; calls = []; });
    pi.on("before_agent_start", (e) => {
      // A run a hidden message starts (a child's report, a nudge) carries on the request before it.
      if (e.messageType === "user") request = e.prompt;
      else if (!request) { const c = e.message.content; request = typeof c === "string" ? c : c.filter((p) => p.type === "text").map((p) => p.text).join("\n"); }
    });
    pi.on("tool_result", (e) => {
      // A delegate counts too: a single coder writes in the thread's own checkouts (docs/delegation.md).
      if (!e.isError && ["edit", "write", "bash", "delegate"].includes(e.toolName)) changed = true;
      if (o.judge) calls.push({ name: e.toolName, args: e.input, output: tail(e.content.map((c) => (c.type === "text" ? c.text : "(image)")).join("\n")), isError: e.isError });
    });
    /**
     * The evidence check on her reply: the notice, and whether a follow-up went back to her, so her next reply ending
     * the run is checked and judged again.
     */
    const judge = async (reply: string, signal?: AbortSignal): Promise<{ entry: Entry; pending: boolean }> => {
      const notice = (details: EvidenceResult, pending = false) => ({ pending, entry: { type: "custom_message", customType: EVIDENCE_NOTICE, content: `Evidence ${details.ok ? "checked" : "not shown"}: ${details.reason}`, display: true, details } as Entry });
      let v: Verdict | undefined;
      let note: string | undefined;
      try {
        v = parseVerdict(await o.judge!(judgePrompt({ request, task: o.codeTask?.(), calls, reply }), signal));
        if (!v) note = "The evidence check's answer couldn't be read, so the reply stands.";
      } catch (err) {
        note = `The evidence check couldn't run (${(err as Error).message}), so the reply stands.`;
      }
      if (!v || v.verdict === "done") return notice({ ok: true, reason: note ?? (v?.reason || "The tool results bear the reply out.") });
      if (v.verdict === "blocked") return notice({ ok: false, reason: `Waits on you: ${v.reason}` });
      // continue: back to her unseen, at most EVIDENCE_ROUNDS times; the same reason again means she can't show it.
      if (judged >= EVIDENCE_ROUNDS || v.reason === lastReason) {
        judged = EVIDENCE_ROUNDS;
        return notice({ ok: false, reason: v.reason });
      }
      judged++;
      lastReason = v.reason;
      pi.sendMessage({ customType: EVIDENCE_CONTINUE, content: continueAsk(v, judged >= EVIDENCE_ROUNDS), display: false }, { deliverAs: "followUp", triggerTurn: true });
      return notice({ ok: false, reason: v.reason }, true);
    };
    pi.on("turn_end", async (e, ctx) => {
      // Her reply ends the run: no tool calls, and not cut off by an error, a stop or the tool limit's wrap-up.
      if (!changed || rounds >= CHECK_ROUNDS || e.message.role !== "assistant") return;
      if (e.message.content.some((c) => c.type === "toolCall") || e.message.stopReason === "error" || e.message.stopReason === "aborted") return;
      // A reply with only thinking isn't one: turn-tools asks her to carry on.
      const reply = e.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (!reply.trim()) return;
      if (!pi.getActiveTools().length) return;
      if (!o.code() || o.plan()) return;
      const checks = o.checks();
      // No checks: the evidence check alone, on each reply until its rounds are spent.
      if (!checks.length) {
        if (!o.judge || judged >= EVIDENCE_ROUNDS) { changed = false; return; }
        const r = await judge(reply, ctx.signal);
        if (ctx.signal?.aborted) return;
        if (!r.pending) changed = false;
        return { entries: [r.entry] };
      }
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
        const details: ChecksResult = { ok: true, failed: [], passed };
        const entries: Entry[] = [{ type: "custom_message", customType: CHECKS_NOTICE, content: `Checks passed: ${list(passed)}`, display: true, details }];
        // The checks passed: now whether the results show the work done. While a follow-up is pending, her next
        // reply ending the run is checked again, edits or not.
        let pending = false;
        if (o.judge && judged < EVIDENCE_ROUNDS) {
          const r = await judge(reply, ctx.signal);
          if (ctx.signal?.aborted) return;
          entries.push(r.entry);
          pending = r.pending;
        }
        if (!pending) changed = false;
        return { entries };
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
