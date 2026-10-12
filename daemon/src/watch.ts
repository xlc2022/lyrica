import { FROM_PARENT, WAKEUP, WATCHING, WATCHING_MARK, type Memory, type Models, type Pool } from "@lyrica/core";
import { DELEGATE_MESSAGE, modelRuntimeFor, piModelFor } from "@lyrica/extension";
import type { ThreadHost } from "./hosted.ts";
import { toldLines } from "./messages.ts";

// Watching threads (DESIGN, Projects): after the person writes in one of a
// project's threads, a thread posts an update, stops with an error or starts
// waiting for an approval, a look goes a little later, batched across
// threads. A look is one call to the `watching` model with a small prompt:
// what was said (quoted, read from the pool when it fires), the project, its
// threads and what the last looks told them. Its answer names threads to tell
// and, rarely, something to raise with the person. The look is stored in the
// project chat as a short entry with no quotes: which threads it was about,
// and who was told what. Only a raise starts a project-chat turn.

export interface WatchOptions {
  memory: Memory;
  models: Models;
  host: () => ThreadHost;
  /** Her name, for the prompt. */
  name: () => string;
  /** Whether the project wants watching now: the setting on, and not paused or hidden. */
  wanted: (userId: string, pool: Pool, project: string) => boolean;
  /** Whether the thread's model calls are kept local (private, or local-only). */
  restricted: (userId: string, pool: Pool, threadId: string) => boolean;
  /** The project's threads that may be told (not resolved), and its `threads list` lines. */
  threads: (userId: string, pool: Pool, project: string) => { open: string[]; lines?: string };
  /** Sends a line to a thread as the project chat's `threads message` would. */
  tell: (userId: string, pool: Pool, project: string, thread: string, text: string) => Promise<void>;
  /** Appends the look to the project chat without a turn, as deliveries are. */
  store: (userId: string, pool: Pool, project: string, content: string, details: object) => void;
  /** Failures, by error name only. */
  log: (line: string) => void;
  /** How long after the first trigger the look goes, to batch what follows. */
  delayMs?: number;
}

/**
 * Looks in a row, whatever brought them, with no word from the person anywhere in the project. Past it, the
 * person's messages and updates bring no look, and a failure or a wait brings one that may only raise.
 */
export const WATCH_RUN = 3;
/** Threads one look may tell. */
export const WATCH_TELLS = 3;
const QUOTE = 500;
const LINE = 1000;

type What = "said" | "update" | "failed" | "waiting";
const WHAT: Record<What, string> = {
  said: "the person wrote there", update: "it posted an update", failed: "it stopped with an error", waiting: "it is waiting for an approval",
};
interface Pending { timer: ReturnType<typeof setTimeout>; threads: Map<string, Set<What>> }
interface Tell { thread: string; text: string }

export class Watcher {
  private readonly pending = new Map<string, Pending>();
  /** Looks since the person last wrote in the project, by `user/pool/project`. */
  private readonly run = new Map<string, number>();
  /** A failure or wait already counted in the thread's current turn, by `user/pool/thread/what`. */
  private readonly fired = new Set<string>();

  constructor(private readonly o: WatchOptions) {}

  /** A turn started in a thread: it may trigger a look for a failure or a wait again. */
  turnStarted(userId: string, pool: Pool, threadId: string): void {
    for (const w of ["failed", "waiting"]) this.fired.delete(`${userId}/${pool}/${threadId}/${w}`);
  }

  /** A turn ended. In a project's thread, a turn the person started is a trigger; anywhere in the project, it resets the run. */
  turnEnded(userId: string, pool: Pool, threadId: string): void {
    let project: string | undefined;
    let logged = false;
    let theirs = false;
    try {
      const view = this.o.memory.openThreadView(userId, pool);
      try {
        const own = view.own;
        project = own.projectOf(threadId);
        const t = own.getThread(threadId);
        if (!project || !t || t.subagent) return;
        const last = own.lastEntry(threadId, ["user"])?.text ?? "";
        theirs = !!last && !FROM_PARENT.test(last) && !WATCHING.test(last) && !WAKEUP.test(last);
        logged = !t.unlogged;
      } finally {
        view.close();
      }
    } catch { return; /* locked */ }
    if (!theirs) return;
    this.run.delete(key(userId, pool, project));
    if (threadId !== project && logged) this.add(userId, pool, project, threadId, "said");
  }

  /** A project's thread posted an update or asked for the person. */
  updated(userId: string, pool: Pool, project: string, threadId: string): void {
    if (this.logged(userId, pool, threadId)) this.add(userId, pool, project, threadId, "update");
  }

  /** A project's thread's turn ended with an error. Once a turn; past the run of looks, a look that may only raise. */
  failed(userId: string, pool: Pool, project: string, threadId: string): void {
    this.once(userId, pool, project, threadId, "failed");
  }

  /** A project's thread started waiting for a permission answer. Once a turn; past the run of looks, a look that may only raise. */
  waiting(userId: string, pool: Pool, project: string, threadId: string): void {
    this.once(userId, pool, project, threadId, "waiting");
  }

  /** Lock or shutdown: nothing pending goes. */
  close(userId?: string): void {
    for (const [k, p] of this.pending) if (!userId || k.startsWith(`${userId}/`)) { clearTimeout(p.timer); this.pending.delete(k); }
    for (const k of this.fired) if (!userId || k.startsWith(`${userId}/`)) this.fired.delete(k);
  }

  private once(userId: string, pool: Pool, project: string, threadId: string, what: "failed" | "waiting"): void {
    if (threadId === project || !this.logged(userId, pool, threadId)) return;
    const k = `${userId}/${pool}/${threadId}/${what}`;
    if (this.fired.has(k)) return;
    if (this.add(userId, pool, project, threadId, what)) this.fired.add(k);
  }

  private logged(userId: string, pool: Pool, threadId: string): boolean {
    try {
      const view = this.o.memory.openThreadView(userId, pool);
      try { const t = view.own.getThread(threadId); return !!t && !t.unlogged && !t.subagent; } finally { view.close(); }
    } catch { return false; }
  }

  private add(userId: string, pool: Pool, project: string, threadId: string, what: What): boolean {
    const k = key(userId, pool, project);
    // Threads can keep each other going with updates; failures and waits they can't cause that way.
    const capped = what === "said" || what === "update";
    if ((capped && (this.run.get(k) ?? 0) >= WATCH_RUN) || !this.o.wanted(userId, pool, project) || !this.mayQuote(userId, pool, project, threadId)) return false;
    let p = this.pending.get(k);
    if (!p) {
      p = { timer: setTimeout(() => void this.look(userId, pool, project), this.o.delayMs ?? 30_000), threads: new Map() };
      p.timer.unref?.();
      this.pending.set(k, p);
    }
    const t = p.threads.get(threadId) ?? new Set();
    t.add(what);
    p.threads.set(threadId, t);
    return true;
  }

  /** A local-only thread's words never go into a project chat whose model calls may leave the machine. */
  private mayQuote(userId: string, pool: Pool, project: string, threadId: string): boolean {
    try {
      return !this.o.restricted(userId, pool, threadId) || this.o.restricted(userId, pool, project);
    } catch { return false; }
  }

  private async look(userId: string, pool: Pool, project: string): Promise<void> {
    const k = key(userId, pool, project);
    const p = this.pending.get(k);
    if (!p) return;
    if (!this.o.wanted(userId, pool, project)) return void this.pending.delete(k);
    // A turn running there: look once it's done, so the look's entry doesn't land inside it. During an update's drain, after it.
    if (this.o.host().busy(userId, pool, project) || this.o.host().draining) {
      p.timer = setTimeout(() => void this.look(userId, pool, project), (this.o.delayMs ?? 30_000) / 2);
      p.timer.unref?.();
      return;
    }
    this.pending.delete(k);
    // Past the run only a failure or a wait gets here; such a look tells no thread, so threads can't keep it going.
    const raiseOnly = (this.run.get(k) ?? 0) >= WATCH_RUN;
    let built: ReturnType<Watcher["build"]>;
    try {
      built = this.build(userId, pool, project, new Map([...p.threads].filter(([id]) => this.mayQuote(userId, pool, project, id))), raiseOnly);
    } catch { return; /* locked */ }
    if (!built) return;
    this.run.set(k, (this.run.get(k) ?? 0) + 1);
    let answer: { tell: Tell[]; raise?: string } | undefined;
    try {
      answer = parseAnswer(await this.ask(userId, pool, project, built.prompt));
    } catch (err) {
      return this.o.log(`a look at a project's threads failed: ${(err as Error).name}`);
    }
    if (!answer) return this.o.log("a look at a project's threads got an answer that wasn't the JSON asked for");
    const told: Tell[] = [];
    try {
      const { open } = this.o.threads(userId, pool, project);
      for (const t of raiseOnly ? [] : answer.tell) {
        if (told.length >= WATCH_TELLS) break;
        if (t.thread === project || !open.includes(t.thread) || told.some((x) => x.thread === t.thread)) continue;
        // Never back to a thread the look was about, unless it asked something: it knows what happened there.
        if (p.threads.has(t.thread) && !built.asked.has(t.thread)) continue;
        try {
          await this.o.tell(userId, pool, project, t.thread, t.text);
          told.push(t);
        } catch (err) { this.o.log(`a look couldn't tell a thread: ${(err as Error).name}`); }
      }
    } catch { return; /* locked */ }
    const text = [built.summary, [
      ...(told.length ? told.map((t) => `Told [t:${t.thread}]: ${JSON.stringify(t.text)}`) : ["Told no thread."]),
      ...(answer.raise ? [`Raised: ${JSON.stringify(answer.raise)}`] : []),
    ].join("\n")].join("\n\n");
    try {
      // A raise is her turn, on the chat's own model; otherwise the look is only kept, as a delivery is.
      if (answer.raise) await this.o.host().get(userId, pool, project).send(text, { watching: true });
      else {
        // A turn the person started during the call: a delivery to a busy chat would start another, so the look waits for it to end.
        while (this.o.host().busy(userId, pool, project)) await this.o.host().get(userId, pool, project).settled();
        this.o.store(userId, pool, project, `${WATCHING_MARK}${text}`, { status: "watching" });
      }
    } catch (err) { this.o.log(`a look couldn't be kept in the project chat: ${(err as Error).name}`); }
  }

  /**
   * The prompt, with the quotes; the short summary kept in the project chat, without them; and the threads that asked
   * something (waiting for an approval, or their update was a question for the person). Undefined when nothing is left to say.
   */
  private build(userId: string, pool: Pool, project: string, threads: Map<string, Set<What>>, raiseOnly: boolean):
    { prompt: string; summary: string; asked: Set<string> } | undefined {
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      const own = view.own;
      const updates = threads.size ? recentUpdates(own.entryPage(project, { limit: 100 }).entries.map((e) => e.data)) : new Map<string, Update>();
      const quoted: string[] = [];
      const summary: string[] = [];
      const asked = new Set<string>();
      for (const [id, what] of threads) {
        const t = own.getThread(id);
        if (!t || t.unlogged) continue;
        const lines: string[] = [];
        const kinds: What[] = [];
        if (what.has("said")) {
          const said = own.lastEntry(id, ["user"])?.text ?? "";
          const reply = own.lastEntry(id, ["assistant"])?.text ?? "";
          if (said && !FROM_PARENT.test(said)) { lines.push(`- The person wrote: ${quote(said)}`); kinds.push("said"); }
          if (reply && kinds.includes("said")) lines.push(`- The thread answered: ${quote(reply)}`);
        }
        if (what.has("update")) {
          const u = updates.get(id);
          lines.push(u ? `- It posted ${u.status === "waiting" ? "a question for the person" : "an update"}: ${quote(u.text)}` : "- It posted an update.");
          kinds.push("update");
          if (u?.status === "waiting") asked.add(id);
        }
        if (what.has("failed")) { lines.push("- It stopped with an error."); kinds.push("failed"); }
        if (what.has("waiting")) { lines.push("- It is waiting for an approval."); kinds.push("waiting"); asked.add(id); }
        if (!lines.length) continue;
        quoted.push([`In [t:${id}]${t.title ? ` ${JSON.stringify(t.title)}` : ""}:`, ...lines].join("\n"));
        summary.push(`In [t:${id}]: ${kinds.map((w) => WHAT[w]).join("; ")}.`);
      }
      if (!quoted.length) return undefined;
      const chat = own.getThread(project);
      const instructions = own.pageForProject(project)?.instructions;
      const { lines } = this.o.threads(userId, pool, project);
      const before = lastTold(own.entryPage(project, { limit: 200 }).entries.map((e) => e.data));
      const prompt = [
        `You are ${this.o.name()}, watching the threads of one of your projects from its project chat [t:${project}]. Something just happened in some of them.`,
        `Project${chat?.title ? ` ${JSON.stringify(chat.title)}` : ""}.`,
        chat?.goal && `Goal, in the person's words: ${chat.goal}`,
        instructions && `The person's instructions for this project:\n${instructions}`,
        lines && `Its threads:\n${lines}`,
        `What happened:\n${quoted.join("\n\n")}`,
        before.length && `What the last looks told threads:\n${before.join("\n")}`,
        raiseOnly && "The threads have gone on without the person for a while, so this look tells no thread: reply with an empty tell, and raise only what the person must know now.",
      ].filter(Boolean).join("\n\n");
      return { prompt, summary: summary.join("\n"), asked };
    } finally {
      view.close();
    }
  }

  /** One call to the `watching` model, through the project chat's CallContext: a private or local-only project gets local models only. */
  private async ask(userId: string, pool: Pool, project: string, prompt: string): Promise<string> {
    const { models } = this.o;
    const call = models.callContext(userId, pool, project);
    const runtime = await modelRuntimeFor(models, call);
    const reply = await models.callWithFallback("watching", call, {}, async (resolution) => {
      const { model } = piModelFor(runtime, models, "watching", call, resolution);
      models.recordCall(userId, { pool, threadId: project, task: "watching", resolution });
      const r = await runtime.completeSimple(model, { systemPrompt: SYSTEM, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] });
      if (r.stopReason === "error") throw new Error(r.errorMessage ?? "the watching model failed");
      return r;
    });
    return reply.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
  }
}

const SYSTEM = [
  "Decide whether any other thread of the project needs to know what just happened, and whether the person needs to hear of it now.",
  "Tell a thread only what changes its own work, in one or two lines it can act on. Tell at most 3 threads, never the project chat or a resolved thread,",
  "and not the thread it happened in unless it asked something. Don't repeat what the last looks told. Raise something with the person only when they must decide or know now.",
  'Reply with JSON only, no other text: {"tell":[{"thread":"<thread id>","text":"<one or two lines>"}],"raise":"<one line for the person>"}.',
  'With nothing to do, reply {"tell":[]}. Leave "raise" out unless it is needed.',
].join(" ");

/** The model's answer, or undefined when it isn't the JSON asked for. */
export function parseAnswer(raw: string): { tell: Tell[]; raise?: string } | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  let v: unknown;
  try { v = JSON.parse(raw.slice(start, end + 1)); } catch { return undefined; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as { tell?: unknown; raise?: unknown };
  if (o.tell !== undefined && !Array.isArray(o.tell)) return undefined;
  const tell = ((o.tell ?? []) as unknown[]).flatMap((t): Tell[] => {
    const x = t as { thread?: unknown; text?: unknown } | null;
    if (!x || typeof x.thread !== "string" || typeof x.text !== "string" || !x.text.trim()) return [];
    const thread = x.thread.trim().replace(/^\[|\]$/g, "").replace(/^t:/, "");
    return thread ? [{ thread, text: x.text.trim().slice(0, LINE) }] : [];
  });
  const raise = typeof o.raise === "string" && o.raise.trim() ? o.raise.trim().slice(0, QUOTE) : undefined;
  return { tell, ...(raise ? { raise } : {}) };
}

type Raw = { type?: string; customType?: string; content?: unknown; details?: { status?: unknown; threads?: unknown }; message?: { role?: string; content?: unknown } };
const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n") : "");

/** A stored look's text after the mark: a look kept as a delivery, or one that raised (her turn's message). */
function lookText(e: Raw): string | undefined {
  const text = e.type === "custom_message" && e.customType === DELEGATE_MESSAGE && e.details?.status === "watching" ? textOf(e.content)
    : e.type === "message" && e.message?.role === "user" ? textOf(e.message.content) : "";
  return WATCHING.test(text) ? text : undefined;
}

/** What the last three looks told, newest last. */
function lastTold(entries: unknown[]): string[] {
  const looks = entries.map((e) => lookText(e as Raw)).filter((t): t is string => !!t).slice(-3);
  return looks.flatMap((t) => toldLines(t).map((x) => `- [t:${x.threadId}]: ${JSON.stringify(x.text)}`));
}

/** A thread's update to the project chat; `waiting` when it asked for the person. */
interface Update { text: string; status: "update" | "waiting" }

/** Each thread's newest update or question posted to the project chat. */
function recentUpdates(entries: unknown[]): Map<string, Update> {
  const out = new Map<string, Update>();
  for (const e of entries as Raw[]) {
    if (e.type !== "custom_message" || e.customType !== DELEGATE_MESSAGE) continue;
    const threads = Array.isArray(e.details?.threads) ? e.details.threads : [];
    const status = e.details?.status;
    if ((status === "update" || status === "waiting") && threads.length === 1 && typeof threads[0] === "string") {
      out.set(threads[0], { text: textOf(e.content).replace(/^[^\n]*\n/, ""), status });
    }
  }
  return out;
}

const key = (userId: string, pool: Pool, project: string) => `${userId}/${pool}/${project}`;
const quote = (s: string) => {
  const flat = s.trim();
  return JSON.stringify(flat.length > QUOTE ? `${flat.slice(0, QUOTE)}…` : flat);
};
