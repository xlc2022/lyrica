import { buildSessionContext, estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FROM_PARENT, ROUTINE, speeds, WAKEUP, WATCHING, type Pace } from "@lyrica/core";
import type { Section } from "./assemble.ts";

// Context and pace: how full her context is and how fast her model answers,
// measured each turn; the lines that tell her to prepare and to compact; and
// compacting with her own summary (an action of the `threads` tool). Counts and times only,
// never text.

/** What the context holds, as the breakdown shows it. */
export type ContextPartName = "persona" | "about" | "memory" | "pinned" | "recall" | "tools" | "conversation" | "reserve" | "free";
export interface ContextPart { name: ContextPartName; tokens: number }

export interface ContextReport {
  /** Tokens used, measured from the last response (estimated just after a compaction). */
  tokens: number;
  window: number;
  /** Used, as a whole percentage of the window. */
  percent: number;
  /** Pi's compaction reserve: it compacts on its own once used + reserve reaches the window. */
  reserve: number;
  /** What's left before Pi's own compaction: window − used − reserve. */
  free: number;
  /** The parts, adding up to the window: the estimated ones scaled to the measured total, then the reserve and free space. */
  parts: ContextPart[];
  measuredAt: string;
  /** How many times this conversation has been compacted: the tokens are what is left after them. */
  compactions: number;
  /** The last turn's speed. */
  pace?: Pace;
}

/**
 * Pi's compaction reserve for a window: 8% (1,024 to 16,384 tokens), and at
 * least 5,120 on a window of 20,480 or more. Pi compacts on its own once used
 * + reserve reaches the window. pi-ai keeps 4,096 tokens spare under the
 * window when it sizes a reply, so a smaller reserve let a reply be asked for
 * a token or two just before compacting; 5,120 leaves it 1,024.
 */
export const reserveFor = (window: number) => Math.min(16_384, Math.max(1024, Math.round(window * 0.08), window >= 20_480 ? 5120 : 0));
/** How much recent conversation Pi keeps when it compacts: a quarter of the window. */
export const keepRecentFor = (window: number) => Math.min(20_000, Math.max(2000, Math.round(window * 0.25)));
/** A summary shorter than this is taken as notes for Pi's own summary. */
export const MIN_SUMMARY = 400;

const ESTIMATED: ContextPartName[] = ["persona", "about", "memory", "pinned", "recall", "tools", "conversation"];
/** Which part each prompt section counts towards. */
const PART: Record<Section["name"], ContextPartName> = {
  persona: "persona", topics: "persona", notice: "persona", user: "persona", time: "persona",
  about: "about", opening: "memory", wake: "memory", pages: "memory", folders: "memory", project: "memory", pinned: "pinned", recall: "recall",
};
const chars = (n: number) => Math.ceil(n / 4);

/**
 * One thread's meter. The Lyrica extension feeds it as turns run; lyricad
 * reads the report, records each turn's pace and runs a compaction she asked
 * for once the turn has ended.
 */
export class ContextMeter {
  /** This turn's prompt sections and tool definitions, in characters. */
  private sections: Partial<Record<ContextPartName, number>> = {};
  private snapshot?: { parts: Partial<Record<ContextPartName, number>>; tokens: number; window: number; at: string };
  private fresh?: Pace;
  /** The last finished turn's pace. */
  last?: Pace;
  /** Compactions on the conversation's branch, counted at each turn's end. */
  compactions = 0;
  /** A compaction she asked for, run when the turn ends: her summary, or notes for Pi's own. */
  pending?: { summary?: string; notes?: string };
  /** The compaction now running, for `session_before_compact`. */
  running?: { summary?: string; notes?: string };
  /** Called after each request that leaves the turn going on (it asked for tools), so a long turn reports as it runs. */
  onProgress?: () => void;

  /** The prompt sections assemble made for this turn, and the tool definitions with their guidance. */
  setPrompt(report: Section[], toolChars: number): void {
    const s: Partial<Record<ContextPartName, number>> = { tools: toolChars };
    for (const r of report) s[PART[r.name]] = (s[PART[r.name]] ?? 0) + r.text.length;
    this.sections = s;
  }

  /** After a request: the measured total and the conversation, estimated. */
  measure(tokens: number | null | undefined, window: number, conversation: number, pace?: Pace): void {
    const parts: Partial<Record<ContextPartName, number>> = { conversation };
    for (const [k, v] of Object.entries(this.sections) as [ContextPartName, number][]) parts[k] = chars(v);
    const estimated = ESTIMATED.reduce((a, k) => a + (parts[k] ?? 0), 0);
    this.snapshot = { parts, tokens: tokens ?? estimated, window, at: new Date().toISOString() };
    if (pace) this.last = this.fresh = pace;
  }

  /** The turn's pace since it was last taken, once: lyricad records it on the call. */
  takePace(): Pace | undefined {
    const p = this.fresh;
    this.fresh = undefined;
    return p;
  }

  /** Her prompt and tools as last measured, estimated: what a compaction leaves besides the conversation. */
  fixedTokens(): number {
    const parts = this.snapshot?.parts ?? {};
    return ESTIMATED.filter((k) => k !== "conversation").reduce((a, k) => a + (parts[k] ?? 0), 0);
  }

  /** After a compaction: the total is the estimate until the next response measures it. */
  compacted(after: number): void {
    if (!this.snapshot) return;
    const { parts } = this.snapshot;
    this.snapshot = { ...this.snapshot, parts: { ...parts, conversation: Math.max(0, after - this.fixedTokens()) }, tokens: after, at: new Date().toISOString() };
    this.compactions++;
  }

  report(): ContextReport | undefined {
    const s = this.snapshot;
    if (!s || !s.window) return undefined;
    const estimated = ESTIMATED.reduce((a, k) => a + (s.parts[k] ?? 0), 0);
    const scale = estimated ? s.tokens / estimated : 0;
    const parts: ContextPart[] = ESTIMATED.map((name) => ({ name, tokens: Math.round((s.parts[name] ?? 0) * scale) }));
    // Rounding goes to the conversation, so the parts add up to the measured total exactly.
    const conv = parts.find((p) => p.name === "conversation")!;
    conv.tokens = Math.max(0, conv.tokens + s.tokens - parts.reduce((a, p) => a + p.tokens, 0));
    const reserve = Math.max(0, Math.min(reserveFor(s.window), s.window - s.tokens));
    const free = Math.max(0, s.window - s.tokens - reserve);
    parts.push({ name: "reserve", tokens: reserve }, { name: "free", tokens: free });
    return {
      tokens: s.tokens, window: s.window, percent: Math.round((s.tokens / s.window) * 100), reserve, free, parts, measuredAt: s.at, compactions: this.compactions,
      ...(this.last ? { pace: this.last } : {}),
    };
  }
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k` : String(Math.round(n)));

/** Her status line: numbers only. */
export function statusLine(r: ContextReport): string {
  const pace = r.pace;
  return [
    // A window of 32,768 is "32k", as models are described.
    `Context ${r.percent}% of ${r.window % 1024 === 0 ? `${r.window / 1024}k` : k(r.window)}`, `${k(r.free)} free`,
    ...(pace?.tokPerSec !== undefined ? [`${k(pace.tokPerSec)} tok/s`] : []),
    ...(pace?.promptTokPerSec !== undefined ? [`${k(pace.promptTokPerSec)} tok/s prompt`] : []),
  ].join(" · ");
}

/**
 * Where her two lines start, as percentages of the window. They follow Pi's
 * edge (100 − reserve): "compact now" 2 points before it, "prepare" 15 points
 * before that, and no later than 90% and 75%. From 32k up that is 90 and 75;
 * on 8k, where the 1,024 floor puts the edge at 87.5%, it is 85.5 and 70.5.
 */
export function linesFor(window: number): { prepare: number; compact: number } {
  const edge = 100 - (reserveFor(window) / window) * 100;
  const compact = Math.min(90, Math.round((edge - 2) * 10) / 10);
  return { prepare: Math.min(75, Math.round((compact - 15) * 10) / 10), compact };
}

/** The line that tells her to prepare or to compact now, if any. */
export function prepareLine(r: ContextReport): string | undefined {
  const at = linesFor(r.window);
  // To a tenth of a point, as the lines are set.
  const used = Math.round((r.tokens / r.window) * 1000) / 10;
  if (used >= at.compact) return "Your context is nearly full. Compact now: call threads with action \"compact\" and a summary of what the next stretch needs.";
  if (used >= at.prepare) return "Your context is filling up. Finish the current step, save what matters with remember, then call threads with action \"compact\" and a summary of what the next stretch needs.";
  return undefined;
}

/** The status line and any preparation line, for the turn's context. */
export function contextLines(meter: ContextMeter): string {
  const r = meter.report();
  if (!r) return "";
  return [statusLine(r), prepareLine(r)].filter(Boolean).join("\n");
}


/** Every message in her context now, estimated, without this turn's context message (counted in its parts). */
function conversationTokens(ctx: ExtensionContext): number {
  const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
  const lastTurn = messages.findLastIndex((m) => (m as { customType?: string }).customType === "lyrica-turn");
  return messages.reduce((a, m, i) => a + (i === lastTurn ? 0 : estimateTokens(m)), 0);
}

/** How she compacts, in the `threads` tool's guidance. */
export const COMPACT_GUIDELINES = [
  "Your turn context carries a status line: how full your context is, how much is free, and how fast your model answers.",
  "When it tells you your context is filling up, finish the step you're on, save what matters with remember, then call threads with action \"compact\". " +
    "Write the summary for yourself: what you're doing, decisions made, open questions, and the paths and names you'll need.",
  "Your summary replaces any earlier one, so carry forward what still matters from it.",
];

/**
 * `threads({ action: "compact", summary })`: the older part of the
 * conversation is replaced with her summary when the turn ends; recent
 * messages stay. A short one becomes notes for Pi's own summary.
 */
export function askCompaction(meter: ContextMeter, summary: string, window: number): { text: string; isError?: true } {
  summary = summary.trim();
  // The summary takes the place of the old messages, within Pi's reserve.
  const most = reserveFor(window) - 512;
  if (window && chars(summary.length) > most) return { text: `That summary is too long: keep it under about ${Math.floor(most * 0.75)} words.`, isError: true };
  if (summary.length < MIN_SUMMARY) {
    meter.pending = { notes: summary };
    return { text: "The thread compacts when this turn ends. Your summary was short, so Pi writes one, with yours as its notes." };
  }
  meter.pending = { summary };
  return { text: "The thread compacts with your summary when this turn ends." };
}

/**
 * One turn's counts and times, from its requests: each runs from the request
 * (`request`) to its first token (`token`) to its end (`end`). Her meter and a
 * subagent's call record both measure this way.
 */
export class PaceTracker {
  private turn = { calls: 0, prompt: 0, read: 0, output: 0, processed: 0, ttft: 0, gen: 0 };
  private started: number | undefined;
  private first: number | undefined;

  reset(): void { this.turn = { calls: 0, prompt: 0, read: 0, output: 0, processed: 0, ttft: 0, gen: 0 }; this.started = this.first = undefined; }
  request(at = Date.now()): void { this.started = at; this.first = undefined; }
  token(at = Date.now()): void { if (this.started !== undefined && this.first === undefined) this.first = at; }
  end(u: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined, at = Date.now()): void {
    if (this.started === undefined) return;
    const t = this.turn;
    const f = this.first ?? at;
    t.calls++;
    t.ttft += f - this.started;
    t.gen += at - f;
    if (u) {
      t.output += u.output;
      t.processed += u.input + u.cacheWrite;
      t.prompt = u.input + u.cacheRead + u.cacheWrite;
      t.read += t.prompt;
    }
    this.started = undefined;
  }
  /** The turn's pace so far, or none before a request ended. */
  pace(window: number): Pace | undefined {
    const t = this.turn;
    return t.calls ? speeds({ promptTokens: t.prompt, readTokens: t.read, outputTokens: t.output, window, ttftMs: t.ttft, genMs: t.gen, processed: t.processed }) : undefined;
  }
}

/**
 * Feeds the meter from Pi's events, and
 * answers `session_before_compact` with her summary when she
 * asked for one. Pi's automatic compaction (threshold or overflow) runs as Pi
 * makes it: its summary keeps the goal, progress and next steps.
 */
export function registerContext(pi: ExtensionAPI, meter: ContextMeter): void {
  const tracker = new PaceTracker();
  pi.on("agent_start", () => tracker.reset());
  pi.on("before_provider_request", () => tracker.request());
  pi.on("message_update", (e) => { if (e.message.role === "assistant") tracker.token(); });
  const measure = (ctx: ExtensionContext) => {
    const window = ctx.model?.contextWindow ?? 0;
    meter.compactions = ctx.sessionManager.getBranch().filter((e) => e.type === "compaction").length;
    meter.measure(ctx.getContextUsage()?.tokens, window, conversationTokens(ctx), tracker.pace(window));
  };
  pi.on("message_end", (e, ctx) => {
    if (e.message.role !== "assistant") return;
    tracker.end(e.message.usage);
    // A turn that goes on with tools reports each request, so a long one (a child thread's task) shows its context and tokens as it runs.
    if (e.message.stopReason === "toolUse" && meter.onProgress) { measure(ctx); meter.onProgress(); }
  });
  pi.on("agent_end", (_e, ctx) => measure(ctx));

  pi.on("session_before_compact", (e, ctx) => {
    // Principle 1: keep her requested summary when the final reply crosses
    // Pi's threshold. The host runs it after the turn, preserving Stop.
    if (e.reason === "threshold" && meter.pending) return { cancel: true };
    const summary = e.reason === "manual" ? meter.running?.summary : undefined;
    if (!summary) return undefined;
    const p = e.preparation;
    // What's left, estimated on one basis: her prompt and tools, the kept messages and the summary. Taking the
    // dropped estimate from the measured total instead missed what the estimate can't see, such as a model's reasoning.
    const dropped = [...p.messagesToSummarize, ...p.turnPrefixMessages].reduce((a, m) => a + estimateTokens(m), 0);
    const after = meter.fixedTokens() + Math.max(0, conversationTokens(ctx) - dropped) + chars(summary.length);
    return { compaction: { summary, firstKeptEntryId: p.firstKeptEntryId, tokensBefore: p.tokensBefore, estimatedTokensAfter: after, details: { after } } };
  });
}

const NUDGES = new Set(["lyrica-ask-nudge", "lyrica-empty-reply-retry", "lyrica-text-tool-call-retry"]);

/** A hidden nudge belongs only to the agent run that consumed it. */
export function dropNudges<T extends { role: string; customType?: string }>(messages: T[]): T[] {
  const boundary = messages.findLastIndex(m => m.role === "user" || m.customType === "lyrica-turn");
  const kept = messages.filter((m, i) => !NUDGES.has(m.customType ?? "") || i > boundary);
  return kept.length === messages.length ? messages : kept;
}

/** Marks only lyricad writes: another thread's message, a watch, a wake-up, a routine. */
const MARKS = [FROM_PARENT, WATCHING, WAKEUP, ROUTINE];
export const MID_TURN = "This arrived while you were working. It doesn't replace your task unless it says so.\n\n";

/**
 * A marked message that reaches her mid-turn (after a tool result) is stored
 * as a user message. Hours into a long turn it can be the newest user-role
 * message while her ask sits far back or in a summary, and a model then
 * reads it as the user's whole request. Said where it arrived, in the
 * request only: the same each time, so the prompt stays cacheable.
 */
export function frameMidTurn<T extends { role: string; content?: unknown }>(messages: T[]): T[] {
  let changed = false;
  const out = messages.map((m, i) => {
    if (m.role !== "user" || messages[i - 1]?.role !== "toolResult") return m;
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as { type: string; text?: string }[] | undefined);
    const first = parts?.[0];
    const mark = first?.type === "text" ? MARKS.map((r) => r.exec(first.text ?? "")).find(Boolean) : undefined;
    if (!mark) return m;
    changed = true;
    const text = `${mark[0]}${MID_TURN}${first!.text!.slice(mark[0].length)}`;
    return { ...m, content: typeof m.content === "string" ? text : [{ ...first, text }, ...parts!.slice(1)] };
  });
  return changed ? out : messages;
}
