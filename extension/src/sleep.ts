import { EventEmitter } from "node:events";
import type { AgentSessionEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  citationsIn, kindOf, NoModel, CloudModelForbidden,
  type CallContext, type Memory, type ModelRef, type Models, type PersonaProposals, type PersonaStore, type Pool, type PoolView,
  type SkipReason, type SleepItem, type SleepMaterial, type SleepPhase, type SleepRunRecord, type Users,
} from "@lyrica/core";
import { Type } from "typebox";
import { createLyricaExtension, type ThreadContext } from "./index.ts";
import { openThreadSession } from "./session.ts";

// Sleep (docs/sleep.md): consolidate → dream → wake, each an agentic Pi
// session in a `sleep` thread of the pool, with the persona and memory tools
// only. Runs go one at a time, across pools and users.

export const PHASES: readonly SleepPhase[] = ["consolidate", "dream", "wake"];

export interface SleepLimits {
  /** Agent turns per phase. */
  turns: number;
  /** Input plus output tokens per phase. */
  tokens: number;
  timeoutMs: number;
  /** Pi's retries of a failed model call, on the same model. */
  retries: number;
  retryDelayMs: number;
}

export const DEFAULT_SLEEP_LIMITS: SleepLimits = { turns: 40, tokens: 600_000, timeoutMs: 20 * 60_000, retries: 2, retryDelayMs: 2000 };

export interface SleepOptions {
  users: Users;
  memory: Memory;
  models: Models;
  persona: PersonaStore;
  proposals: PersonaProposals;
  /** Whether the user's key is in memory. */
  hasKey: (userId: string) => boolean;
  /** Pi's working directory. Nothing is discovered from it. */
  cwd: string;
  limits?: Partial<SleepLimits>;
  /** Status lines only: never text. */
  log?: (line: string) => void;
}

export type SleepMode = "scheduled" | "manual";
export type SleepRun = SleepRunRecord;

interface Who { userId: string; pool: Pool; runId: string }
export type SleepEvent =
  | ({ type: "started"; reason: SleepRun["reason"] } & Who)
  | ({ type: "phase"; phase: SleepPhase; state: "started" | "done" | "stopped" } & Who)
  | ({ type: "finished"; status: SleepRun["status"]; skipReason?: SkipReason } & Who);

/** Not dreams: the wake phase never sees journal entries or sleep's own threads. */
export const hideDreams = (id: string): boolean => {
  const bare = id.replace(/^(general|private)\//, "");
  return kindOf(bare) === "journal" || /^[et]:sleep\//.test(bare);
};

/** The marker at the head of every dream, so nothing in one reads as a fact. */
export const DREAM_HEADER = "Dream journal (reflection, not a record of fact).";

const SETTING = "sleep.mode";

export class Sleep {
  readonly events = new EventEmitter();
  readonly limits: SleepLimits;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly running = new Map<string, { stopped: boolean; abort?: () => Promise<void>; done: Promise<unknown> }>();
  /** Runs in progress, so a check doesn't take one for a run cut short by a restart. */
  private readonly active = new Set<string>();
  /** No-key skips, written into the pool the next time its key is here. */
  private readonly unrecorded: { userId: string; pool: Pool; reason: SleepRun["reason"]; at: string }[] = [];

  constructor(private readonly o: SleepOptions) {
    this.limits = { ...DEFAULT_SLEEP_LIMITS, ...o.limits };
  }

  mode(userId: string): SleepMode {
    const db = this.o.users.openUserDb(userId);
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTING) as { value: string } | undefined;
      return row?.value === "manual" ? "manual" : "scheduled";
    } finally {
      db.close();
    }
  }

  setMode(userId: string, mode: SleepMode): void {
    if (mode !== "scheduled" && mode !== "manual") throw new Error("sleep mode is scheduled or manual");
    const db = this.o.users.openUserDb(userId);
    try {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(SETTING, mode);
    } finally {
      db.close();
    }
  }

  /** Sleeps one pool, after whatever run is going now. Never throws for a skip: it is the run's status. */
  run(userId: string, pool: Pool, reason: SleepRun["reason"]): Promise<SleepRun> {
    const next = this.queue.then(() => this.runNow(userId, pool, reason));
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * What would stop a run right now, without running or recording anything:
   * for manual /sleep's immediate, plain error.
   */
  async check(userId: string, pool: Pool): Promise<{ skip?: SkipReason; reason?: string }> {
    if (!this.o.hasKey(userId)) return { skip: "no-key", reason: "your key isn't available" };
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      const plan = this.plan(view);
      if (!plan) return { skip: "no-activity", reason: "nothing is new since the last sleep" };
      const down = await this.probe(userId, pool, plan.phases);
      return down ? { skip: "endpoint-down", reason: down } : {};
    } finally {
      view.close();
    }
  }

  /** Lock: the running phase stops, and the run is marked partial. Resolves once it is recorded. */
  async stop(userId: string): Promise<void> {
    const r = this.running.get(userId);
    if (!r) return;
    r.stopped = true;
    await r.abort?.().catch(() => {});
    await r.done.catch(() => {});
  }

  private emit(e: SleepEvent): void { this.events.emit("event", e); }

  private async runNow(userId: string, pool: Pool, reason: SleepRun["reason"]): Promise<SleepRun> {
    const started = Date.now();
    const at = new Date().toISOString();
    if (!this.o.hasKey(userId)) {
      this.unrecorded.push({ userId, pool, reason, at });
      this.log(`sleep ${pool}: skipped, no-key`);
      const run: SleepRun = { id: "", reason, status: "skipped", skipReason: "no-key", until: at, phases: {}, startedAt: at, finishedAt: at };
      this.emit({ type: "finished", userId, pool, runId: "", status: "skipped", skipReason: "no-key" });
      return run;
    }
    const state = { stopped: false, abort: undefined as (() => Promise<void>) | undefined, done: Promise.resolve() as Promise<unknown> };
    let finish!: () => void;
    state.done = new Promise<void>((r) => (finish = r));
    this.running.set(userId, state);
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      this.flushSkips(view, userId, pool);
      const plan = this.plan(view);
      const skip = (s: SkipReason) => {
        const id = view.own.recordSleepRun(reason, s);
        this.log(`sleep ${pool}: skipped, ${s}`);
        this.emit({ type: "finished", userId, pool, runId: id, status: "skipped", skipReason: s });
        return view.own.getSleepRun(id)!;
      };
      if (!plan) return skip("no-activity");
      if (await this.probe(userId, pool, plan.phases)) return skip("endpoint-down");

      const runId = plan.resume?.id ?? view.own.startSleepRun(reason, plan.until);
      this.active.add(runId);
      const phases = { ...(plan.resume?.phases ?? {}) };
      view.own.updateSleepRun(runId, { status: "running" });
      this.emit({ type: "started", userId, pool, runId, reason });
      let ok = true;
      for (const phase of plan.phases) {
        if (state.stopped) { ok = false; break; }
        this.emit({ type: "phase", userId, pool, runId, phase, state: "started" });
        const result = await this.phase(view, userId, pool, runId, phase, plan.material, state);
        phases[phase] = { thread: result.thread, done: result.ok };
        view.own.updateSleepRun(runId, { phases });
        this.emit({ type: "phase", userId, pool, runId, phase, state: result.ok ? "done" : "stopped" });
        if (!result.ok) { ok = false; break; }
      }
      const status = ok ? "complete" : "partial";
      view.own.updateSleepRun(runId, { status, finished: true });
      this.log(`sleep ${pool}: ${status} in ${Math.round((Date.now() - started) / 1000)} s`);
      this.emit({ type: "finished", userId, pool, runId, status });
      this.active.delete(runId);
      return view.own.getSleepRun(runId)!;
    } finally {
      view.close();
      this.running.delete(userId);
      finish();
    }
  }

  /** No-key skips from while the key was away, for scheduled users. */
  private flushSkips(view: PoolView, userId: string, pool: Pool): void {
    const mine = this.unrecorded.filter((s) => s.userId === userId && s.pool === pool);
    if (!mine.length) return;
    for (const s of mine) this.unrecorded.splice(this.unrecorded.indexOf(s), 1);
    if (this.mode(userId) === "manual" && mine.every((s) => s.reason === "scheduled")) return;
    for (const s of mine) view.own.recordSleepRun(s.reason, "no-key", s.at);
  }

  /**
   * What this run does: resume a partial run whose consolidate finished, or
   * cover everything since the watermark. Undefined when there's nothing to do.
   */
  private plan(view: PoolView): { phases: SleepPhase[]; until: string; material: SleepMaterial; resume?: SleepRun } | undefined {
    const last = view.own.listSleepRuns(20).find((r) => r.status !== "skipped");
    if (last?.status === "running" && this.active.has(last.id)) return undefined;
    if (last?.status === "running") view.own.updateSleepRun(last.id, { status: "partial", finished: true });
    const unfinished = last && last.status !== "complete" && last.phases.consolidate?.done ? last : undefined;
    if (unfinished) {
      return { phases: PHASES.filter((p) => !unfinished.phases[p]?.done), until: unfinished.until, material: emptyMaterial(), resume: unfinished };
    }
    const until = new Date().toISOString();
    const material = view.own.sleepMaterial(view.own.watermark(), until);
    material.flagged.push(...dangling(view));
    const any = material.threads.length || material.notes.length || material.edited.length || material.flagged.length;
    return any ? { phases: [...PHASES], until, material } : undefined;
  }

  /** The context for a sleep phase: the pool's rules, and that phase's model as its chat model. */
  private context(userId: string, pool: Pool, phase: SleepPhase): { call: CallContext; ref: ModelRef } {
    const base: CallContext = { userId, pool, localOnly: pool === "private" };
    const ref = this.o.models.resolveModel(`sleep.${phase}`, base);
    return { ref, call: { ...base, overrides: { chat: ref, compaction: ref } } };
  }

  /** A cheap check of each phase's endpoint. Returns why it can't run, if it can't. */
  private async probe(userId: string, pool: Pool, phases: SleepPhase[]): Promise<string | undefined> {
    const endpoints = new Set<string>();
    try {
      for (const p of phases) endpoints.add(this.context(userId, pool, p).ref.endpointId);
    } catch (err) {
      if (err instanceof NoModel || err instanceof CloudModelForbidden) return (err as Error).message;
      throw err;
    }
    for (const id of endpoints) {
      const { state } = await this.o.models.probe(userId, id).catch(() => ({ state: "down" as const }));
      if (state === "down") return `the sleep model's endpoint ${id} is down`;
    }
    return undefined;
  }

  private async phase(view: PoolView, userId: string, pool: Pool, runId: string, phase: SleepPhase, material: SleepMaterial,
    state: { stopped: boolean; abort?: () => Promise<void> }): Promise<{ thread: string; ok: boolean }> {
    const user = this.o.users.get(userId)!;
    const thread = view.own.createThread({ interface: "sleep", title: `Sleep: ${phase}` });
    const done: SleepTools["done"] = { wake: false };
    let ok = false;
    try {
      const { call } = this.context(userId, pool, phase);
      const ctx: ThreadContext = { user, pool, interface: "sleep", threadId: thread.id, view, call };
      const tools: SleepTools = { view, runId, threadId: thread.id, proposals: this.o.proposals, done };
      const { session, dispose } = await openThreadSession({
        thread: ctx, models: this.o.models, cwd: this.o.cwd,
        settings: { retry: { enabled: this.limits.retries > 0, maxRetries: this.limits.retries, baseDelayMs: this.limits.retryDelayMs } },
        extensions: [
          createLyricaExtension(ctx, {
            persona: () => this.o.persona.read(), profile: () => this.o.users.get(userId)!.profile,
            memoryTools: "read", ...(phase === "wake" ? { hide: hideDreams } : {}),
          }),
          sleepTools(phase, tools),
        ],
      });
      let turns = 0;
      let tokens = 0;
      let failed = false;
      let over = false;
      const halt = () => { over = true; void session.abort(); };
      state.abort = () => session.abort();
      const unsubscribe = session.subscribe((e: AgentSessionEvent) => {
        if (e.type === "turn_end" && ++turns >= this.limits.turns) halt();
        if (e.type === "message_end" && e.message.role === "assistant") {
          tokens += e.message.usage?.totalTokens ?? 0;
          failed = e.message.stopReason === "error" || e.message.stopReason === "aborted";
          if (tokens > this.limits.tokens) halt();
        }
      });
      const timer = setTimeout(halt, this.limits.timeoutMs);
      try {
        if (!state.stopped) await session.prompt(instruction(phase, { view, user: user.profile.displayName, material, runId }));
      } catch {
        failed = true;
      } finally {
        clearTimeout(timer);
        unsubscribe();
        state.abort = undefined;
        dispose();
      }
      ok = !failed && !over && !state.stopped && (phase !== "dream" || !!done.journal) && (phase !== "wake" || done.wake);
    } catch (err) {
      this.log(`sleep ${pool} ${phase} failed: ${(err as Error).name}`);
    }
    return { thread: thread.id, ok };
  }

  private log(line: string): void { this.o.log?.(line); }
}

/** Private pages citing general memory that has since been deleted: the private pool rewrites them. */
function dangling(view: PoolView): string[] {
  const general = view.reads.find((r) => r.pool === "general");
  if (!general) return [];
  return view.own.pageIndex().map((p) => p.id)
    .filter((id) => view.own.cameFrom(id).some((c) => c.startsWith("general/") && /^general\/[np]:/.test(c) && !general.get(c.slice(8))));
}

const emptyMaterial = (): SleepMaterial => ({ threads: [], notes: [], edited: [], flagged: [] });

// --- Instructions ---

const NOTES_SHOWN = 150;

function instruction(phase: SleepPhase, c: { view: PoolView; user: string; material: SleepMaterial; runId: string }): string {
  const { view, user, material: m } = c;
  const privateNote = view.pool === "private"
    ? `\nThis is your private memory with ${user}. You can read and cite general memory as [general/n:…]; you write only here.`
    : "";
  if (phase === "consolidate") {
    const notes = m.notes.slice(0, NOTES_SHOWN).map((n) => `- [${n.id}]${n.origin === "user" ? ` (added by ${user})` : ""} ${short(n.text)}`);
    if (m.notes.length > NOTES_SHOWN) notes.push(`- …and ${m.notes.length - NOTES_SHOWN} more: use recall.`);
    const threads = m.threads.map((t) => `- [t:${t.id}]${t.title ? ` "${t.title}"` : ""}: ${t.entries} new entries, ${t.first} to ${t.last}`);
    const edited = m.edited.map((e) => `- [${e.id}] on ${e.at.slice(0, 10)}`);
    const about = view.own.get("p:about-user");
    const aboutLine = !about ? `There is no page about ${user} yet: create p:about-user.`
      : view.own.revisions("p:about-user").some((r) => r.author.startsWith("user:"))
        ? `p:about-user has words ${user} wrote: keep them exactly, and add around them.`
        : "p:about-user exists: keep it current.";
    return [
      `It's night, and you're asleep. This is consolidation, the first part of sleep for your ${view.pool} memory. Nobody is waiting for a reply: work with your tools, then end with a line or two on what you did.${privateNote}`,
      section("Notes since you last slept", notes),
      section("Conversations with something new (skim them with read_memory)", threads),
      section(`Memories ${user} changed or added (authoritative)`, edited),
      section("Pages to rewrite (something they cited was deleted)", m.flagged.map((id) => `- [${id}]`)),
      [
        "What to do:",
        "1. Skim the conversations. If something important was never noted, note it with remember, citing the entry it came from ([e:…]). Keep this light.",
        "2. Create or update pages with write_page, one subject each, citing the notes behind each claim ([n:…]). Pages describing a folder list it in folders.",
        `3. Keep p:about-user, the page about ${user}: who they are, what they prefer, dislike and care about, citing notes. ${aboutLine}`,
        `4. What ${user} wrote or edited is authoritative: build on it, and never change their words. If newer conversation contradicts it, raise a question instead.`,
        "5. When two things contradict each other, raise a question rather than guessing.",
        "6. Rewrite the pages listed above without the deleted source.",
        "Write {user} for the person, never their name, in notes and pages.",
      ].join("\n"),
    ].filter(Boolean).join("\n\n");
  }
  if (phase === "dream") {
    return [
      `This is your time: the dream, the second part of sleep.${privateNote} Read what you like with recall and read_memory, follow whatever catches your attention, and write a journal entry with write_journal: free reflection, in your own voice. It's a dream, not a record: nothing in it becomes a fact by itself.`,
      "If something about who you are wants to change, propose it with propose_persona. If there's a thought you'd like to bring up with " +
        `${user} sometime, raise it (a few at most). Don't write WAKE: that comes next, without your dreams.`,
    ].join("\n\n");
  }
  const questions = view.own.listItems({ run: c.runId }).filter((i: SleepItem) => i.kind === "question").map((i) => `- ${i.text}`);
  const changes = view.own.sleepChanges(view.own.getSleepRun(c.runId)!.startedAt, new Date().toISOString()).pages.map((p) => `- [${p.id}]`);
  return [
    `Morning: the last part of sleep. Write WAKE with write_wake: 400 to 800 words, first person, in your own voice, not a bulleted briefing. It's what you'll wake up with in the next conversation: where things stand with ${user}, what's in motion, and what's unresolved, including the open questions below.${privateNote}`,
    "WAKE is orientation only. Leave your dreams out of it.",
    section("Open questions from tonight", questions),
    section("Pages changed tonight", changes),
  ].filter(Boolean).join("\n\n");
}

const section = (title: string, lines: string[]) => (lines.length ? `${title}:\n${lines.join("\n")}` : "");
const short = (t: string) => (t.length > 300 ? `${t.slice(0, 300)}…` : t).replace(/\s+/g, " ");

// --- The sleep-only tools ---

interface SleepTools {
  view: PoolView;
  runId: string;
  threadId: string;
  proposals: PersonaProposals;
  /** What this phase wrote: tonight's journal entry, and whether WAKE is written. */
  done: { journal?: string; wake: boolean };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** The tools for one phase: consolidate writes notes, pages and questions; dream the journal; wake WAKE. */
export function sleepTools(phase: SleepPhase, s: SleepTools): ExtensionFactory {
  const { view } = s;
  const own = view.own;
  return (pi) => {
    if (phase === "consolidate") {
      pi.registerTool({
        name: "remember",
        label: "Remember",
        description: "Save notes you missed in conversation. Each note is one fact and cites the entry it came from, like [e:web/3f7a2c#41]. Write {user} for the person.",
        promptSnippet: "save notes that were missed, citing their entry",
        parameters: Type.Object({
          notes: Type.Array(Type.Object({
            text: Type.String({ description: "One fact, citing its entry [e:…]." }),
            about: Type.Optional(Type.Array(Type.String())),
            supersedes: Type.Optional(Type.Array(Type.String())),
          }), { minItems: 1 }),
        }),
        async execute(_id, params) {
          for (const n of params.notes) {
            const entries = citationsIn(n.text, view.pool).filter((c) => /^e:/.test(c));
            if (!entries.length) throw new Error("each note cites the entry it came from, like [e:web/3f7a2c#41]");
            const gone = entries.find((e) => own.isTombstoned(e));
            if (gone) throw new Error(`what ${gone} said was deleted from memory on purpose: don't note it again`);
          }
          const ids = own.addNotes(params.notes, { author: "sleep" });
          return text(`Saved ${ids.join(", ")}.`);
        },
      });
      pi.registerTool({
        name: "write_page",
        label: "Write page",
        description: "Create or rewrite a page: your understanding of one subject, citing the notes behind it. The whole text replaces the old one.",
        promptSnippet: "create or rewrite a page, with citations",
        parameters: Type.Object({
          slug: Type.String({ description: "Short name: lowercase letters, digits and '-', like homelab or about-user." }),
          title: Type.String(),
          summary: Type.String({ description: "One line, for the page index." }),
          text: Type.String({ description: "The page, citing notes [n:…] (or other pages [p:…], entries [e:…]) for each claim." }),
          folders: Type.Optional(Type.Array(Type.String(), { description: "Folders this page describes." })),
        }),
        async execute(_id, params) {
          const cites = citationsIn(params.text, view.pool);
          if (!cites.length) throw new Error("a page cites what it rests on, like [n:20261009-a1b2c3d4]");
          // A dream is reflection: a page can't rest on one.
          if (cites.some((c) => hideDreams(c))) throw new Error("a page can't cite the journal or sleep's own threads: dreams aren't facts");
          const id = own.putPage(params, "sleep");
          return text(`Wrote ${id}.`);
        },
      });
    }
    if (phase === "dream") {
      pi.registerTool({
        name: "write_journal",
        label: "Write journal",
        description: "Write tonight's dream journal entry: free reflection, in your own voice.",
        promptSnippet: "write tonight's journal entry",
        parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) {
          const id = own.addJournal(`${DREAM_HEADER}\n\n${params.text.trim()}`, "sleep");
          s.done.journal = id;
          return text(`Wrote ${id}.`);
        },
      });
      pi.registerTool({
        name: "propose_persona",
        label: "Propose persona change",
        description: "Propose a change to one of your persona files, as its whole new text. It is reviewed before anything changes.",
        promptSnippet: "propose a change to who you are",
        parameters: Type.Object({
          path: Type.String({ description: "For example persona_topics/music.md." }),
          text: Type.String({ description: "The file's whole new text." }),
          reason: Type.String({ description: "Why, in a sentence or two." }),
        }),
        async execute(_id, params) {
          const { sent, id } = s.proposals.propose(view, s.threadId, { ...params, author: "sleep" });
          own.addItem(s.runId, { kind: "persona", text: `${params.path}: ${params.reason}`, source: `${sent ? "proposal" : "draft"}:${id}` });
          return text(sent ? "Proposed: it's with the administrators now." : "Proposed: it waits as a draft for the person to look at.");
        },
      });
    }
    if (phase === "wake") {
      pi.registerTool({
        name: "write_wake",
        label: "Write WAKE",
        description: "Write WAKE, what you'll wake up with: 400 to 800 words, first person. It replaces the old one.",
        promptSnippet: "write WAKE",
        parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) {
          own.putWake(params.text.trim(), "sleep");
          s.done.wake = true;
          return text("WAKE is written.");
        },
      });
    }
    pi.registerTool({
      name: "raise",
      label: "Raise",
      description: phase === "consolidate"
        ? "Raise a question for the person: a contradiction, or something you'd otherwise have to guess. It shows in the Sleep section and in WAKE."
        : "Note something you'd like to bring up with the person sometime. It shows in the Sleep section; they can start a chat from it.",
      promptSnippet: phase === "consolidate" ? "raise a question instead of guessing" : "keep a thought to bring up later",
      parameters: Type.Object({
        text: Type.String(),
        source: Type.Optional(Type.String({ description: "The memory it's about, like p:homelab or n:…" })),
      }),
      async execute(_id, params) {
        const kind: SleepItem["kind"] = phase === "consolidate" ? "question" : "thought";
        const source = params.source?.trim() || s.done.journal || `t:${s.threadId}`;
        own.addItem(s.runId, { kind, text: params.text, source });
        return text(kind === "question" ? "Raised the question." : "Kept it for later.");
      },
    });
  };
}

