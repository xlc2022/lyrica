import { tail } from "./checks.ts";

// Principles 2 and 6: when a code turn says it is done, the claim rests on
// what the tools showed, judged by the thread's own code model
// (docs/briefs/code-evidence.md, part A). The judge prompt is adapted from
// opencode's plugin/goal/judge.txt (MIT, https://github.com/sst/opencode).

/** Shown in the thread beside Checks: whether the tool results showed the work done. */
export const EVIDENCE_NOTICE = "lyrica-evidence";
/** An EVIDENCE_NOTICE entry's details, which the thread's notice shows. */
export interface EvidenceResult { ok: boolean; reason: string }
/** Told to her, unseen: what the results don't show, so she works on in the same run. */
export const EVIDENCE_CONTINUE = "lyrica-evidence-continue";
export const EVIDENCE_ROUNDS = 2;
/** The most of the turn's calls the judge is shown, newest first, and the most text in all. */
const MAX_CALLS = 80;
const MAX_CHARS = 60_000;
const ARGS_CHARS = 400;

export interface Verdict { verdict: "done" | "continue" | "blocked"; reason: string; next?: string }

/** One of the turn's tool calls, as the judge sees it. */
export interface JudgedCall { name: string; args: unknown; output: string; isError: boolean }

export const JUDGE_SYSTEM = `You judge whether a coding assistant's work is done, from what its tools showed.
You are given the person's request, the task the assistant was set, each tool call it made this turn with the end of the result, and what it told the person. Its reply is a claim, not evidence: only the tool results count.
Judge the request, not the reply's wording:
- done: the tool results show the request met, with what the person would notice checked (tests run and passing, the build passing, the file saying what was claimed), and nothing left half-built.
- continue: something the request asked for is not shown done, a result contradicts the reply (a failing test, an error, an edit that didn't apply), or a claimed check never ran; and the assistant could still do or check it.
- blocked: only the person can supply what is missing (an answer, access, a decision), and the reply asks for it.
Answer with one line of JSON and nothing else: {"verdict":"done"}, {"verdict":"continue","reason":"<what is not shown, in one sentence>","next":"<the one step to take>"} or {"verdict":"blocked","reason":"<what only the person can give>"}.`;

/** The judge's answer, or none when it isn't a verdict. */
export function parseVerdict(text: string): Verdict | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return undefined; }
  const v = parsed as { verdict?: unknown; reason?: unknown; next?: unknown } | null;
  if (!v || typeof v !== "object" || (v.verdict !== "done" && v.verdict !== "continue" && v.verdict !== "blocked")) return undefined;
  const reason = typeof v.reason === "string" ? v.reason.trim() : "";
  return { verdict: v.verdict, reason, ...(typeof v.next === "string" && v.next.trim() ? { next: v.next.trim() } : {}) };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * What the judge is shown: the request and task as data, the turn's calls
 * with each result's tail (the checks' limits), newest kept when they are
 * many, and her reply, marked as a claim.
 */
export function judgePrompt(o: { request: string; task?: string; calls: JudgedCall[]; reply: string }): { system: string; user: string } {
  const calls = o.calls.slice(-MAX_CALLS);
  const first = o.calls.length - calls.length;
  const shown: string[] = [];
  let chars = 0;
  // Newest first, so the end of the turn is always there; older results are left out before their calls are.
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    const head = `## Call ${first + i + 1}: ${c.name} ${clip(JSON.stringify(c.args) ?? "", ARGS_CHARS)}${c.isError ? " (failed)" : ""}`;
    const body = tail(c.output);
    const line = chars + head.length + body.length > MAX_CHARS ? `${head}\n(result left out for length)` : `${head}\n${body}`;
    chars += line.length;
    shown.unshift(line);
  }
  const user = [
    `<request>\n${o.request.trim()}\n</request>`,
    ...(o.task ? [`<task>\n${o.task.trim()}\n</task>`] : []),
    `<tool_calls>\n${shown.length ? shown.join("\n\n") : "(none)"}\n</tool_calls>`,
    `<reply>\n${o.reply.trim()}\n</reply>`,
  ].join("\n\n");
  return { system: JUDGE_SYSTEM, user };
}

/** Told to her after a `continue`: what to show, and that the last round's reply says what stays unverified. */
export function continueAsk(v: Verdict, last: boolean): string {
  const step = v.next ? ` Next: ${v.next}` : "";
  return last
    ? `Your reply isn't borne out by this turn's tool results: ${v.reason}${step} This is the last round: do it and show the result, or say plainly in your reply what is unverified.`
    : `Your reply isn't borne out by this turn's tool results: ${v.reason}${step} Do it and show the result, then finish; your reply is judged again when you end your turn.`;
}
