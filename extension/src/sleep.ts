import { EventEmitter } from "node:events";
import type { AgentSessionEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  aboutToTidy, citationsIn, CORE_LIMIT, danglingPages, emptySleepMaterial, kindOf, NoModel, CloudModelForbidden, projectSlug, sleepInstruction,
  type CallContext, type Memory, type ModelRef, type Models, type PersonaProposals, type PersonaStore, type Pool, type PoolView,
  type SkipReason, type SleepItem, type SleepMaterial, type SleepLimit, type SleepPhase, type SleepRunRecord, type Users,
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
  /** Input plus output tokens per phase, at least: see `windows`. */
  tokens: number;
  /** A phase may use this many of its model's context windows instead, when that's more, paid models included (DESIGN.md, Sleep). */
  windows: number;
  timeoutMs: number;
  /** Pi's retries of a failed model call, on the same model. */
  retries: number;
  retryDelayMs: number;
}

export const DEFAULT_SLEEP_LIMITS: SleepLimits = { turns: 40, tokens: 600_000, windows: 4, timeoutMs: 20 * 60_000, retries: 2, retryDelayMs: 2000 };

/** How long a phase's thread is kept. What sleep wrote stays; the transcript would keep copies of memories deleted since. */
export const SLEEP_THREAD_AGE_MS = 36 * 3600_000;

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
const FALLBACK = "sleep.fallback";

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
    return this.setting(userId, SETTING) === "manual" ? "manual" : "scheduled";
  }

  setMode(userId: string, mode: SleepMode): void {
    if (mode !== "scheduled" && mode !== "manual") throw new Error("sleep mode is scheduled or manual");
    this.setting(userId, SETTING, mode);
  }

  /** Fallback for sleep's phases, on unless turned off. Off, each phase uses its list's first model only. */
  fallback(userId: string): boolean { return this.setting(userId, FALLBACK) !== "off"; }
  setFallback(userId: string, on: boolean): void {
    if (typeof on !== "boolean") throw new Error("sleep fallback is true or false");
    this.setting(userId, FALLBACK, on ? "on" : "off");
  }

  private setting(userId: string, key: string, value?: string): string | undefined {
    const db = this.o.users.openUserDb(userId);
    try {
      if (value !== undefined) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
      return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
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

  /**
   * Forgets phase threads older than SLEEP_THREAD_AGE_MS, in every pool whose
   * key is here. Their memories are kept, and each leaves a thread tombstone,
   * so an item whose source was one still leads somewhere. Returns how many went.
   */
  prune(now = new Date()): number {
    const before = new Date(now.getTime() - SLEEP_THREAD_AGE_MS).toISOString();
    let n = 0;
    for (const u of this.o.users.all()) {
      if (!this.o.hasKey(u.id)) continue;
      for (const pool of ["general", "private"] as const) {
        const view = this.o.memory.openThreadView(u.id, pool);
        try {
          const old = view.own.listThreads({ includeHidden: true }).filter((t) => t.interface === "sleep" && t.createdAt < before);
          old.forEach((t, i) => view.own.forgetThread(t.id, "sleep", { keepMemories: true, optimize: i === old.length - 1 }));
          n += old.length;
        } finally {
          view.close();
        }
      }
    }
    return n;
  }

  /** Users with a sleep run going now: what an update's drain waits for. */
  working(): string[] { return [...this.running.keys()]; }

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
        phases[phase] = { thread: result.thread, done: result.ok, ...(result.limit ? { limit: result.limit } : {}) };
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
      return { phases: PHASES.filter((p) => !unfinished.phases[p]?.done), until: unfinished.until, material: emptySleepMaterial(), resume: unfinished };
    }
    const until = new Date().toISOString();
    const material = view.own.sleepMaterial(view.own.watermark(), until);
    material.flagged.push(...danglingPages(view));
    // In private, general's page about the user changing is reason enough to sleep: it may now repeat the private one.
    const any = material.threads.length || material.notes.length || material.edited.length || material.flagged.length || aboutToTidy(view);
    return any ? { phases: [...PHASES], until, material } : undefined;
  }

  /**
   * The context for a sleep phase: the pool's rules, and that phase's model as
   * its chat model. The model's machine is asked first, so a list falls back
   * past one that is off (unless the user turned sleep's Fallback off); throws
   * Offline when none answers.
   */
  private async context(userId: string, pool: Pool, phase: SleepPhase): Promise<{ call: CallContext; ref: { offeringId: string } }> {
    const base: CallContext = { userId, pool, localOnly: pool === "private", fallback: this.fallback(userId) };
    const { ref } = await this.o.models.resolveLive(`sleep.${phase}`, base, {}, { probeLast: true });
    return { ref, call: { ...base, overrides: { chat: [ref], compaction: [ref] } } };
  }

  /** A cheap check of each phase's model. Returns why it can't run, if it can't. */
  private async probe(userId: string, pool: Pool, phases: SleepPhase[]): Promise<string | undefined> {
    try {
      for (const p of phases) await this.context(userId, pool, p);
    } catch (err) {
      // Offline (every machine in the list is away) is a NoModel.
      if (err instanceof NoModel || err instanceof CloudModelForbidden) return (err as Error).message;
      throw err;
    }
    return undefined;
  }

  private async phase(view: PoolView, userId: string, pool: Pool, runId: string, phase: SleepPhase, material: SleepMaterial,
    state: { stopped: boolean; abort?: () => Promise<void> }): Promise<{ thread: string; ok: boolean; limit?: SleepLimit }> {
    const user = this.o.users.get(userId)!;
    const thread = view.own.createThread({ interface: "sleep", title: `Sleep: ${phase}` });
    const done: SleepTools["done"] = { wake: false };
    let ok = false;
    let limit: SleepLimit | undefined;
    try {
      const { call, ref } = await this.context(userId, pool, phase);
      const window = this.o.models.offering(userId, ref.offeringId)?.offering.contextWindow ?? 0;
      const budget = Math.max(this.limits.tokens, this.limits.windows * window);
      const ctx: ThreadContext = { user, pool, interface: "sleep", threadId: thread.id, view, call };
      const tools: SleepTools = { view, runId, threadId: thread.id, proposals: this.o.proposals, done, user: user.profile.displayName, pagesFirst: material.notes.length > 0,
        projectThreads: new Set(material.threads.flatMap((t) => (t.project ? [`t:${t.id}`, `t:${t.project}`] : []))) };
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
      const halt = (why: SleepLimit) => { limit ??= why; void session.abort(); };
      state.abort = () => session.abort();
      const unsubscribe = session.subscribe((e: AgentSessionEvent) => {
        if (e.type === "turn_end" && ++turns >= this.limits.turns) halt("turns");
        if (e.type === "message_end" && e.message.role === "assistant") {
          tokens += e.message.usage?.totalTokens ?? 0;
          failed = e.message.stopReason === "error" || e.message.stopReason === "aborted";
          if (tokens > budget) halt("tokens");
        }
      });
      const timer = setTimeout(() => halt("time"), this.limits.timeoutMs);
      try {
        if (!state.stopped) await session.prompt(sleepInstruction(phase, { view, user: user.profile.displayName, material, runId }));
      } catch {
        failed = true;
      } finally {
        clearTimeout(timer);
        unsubscribe();
        state.abort = undefined;
        dispose();
      }
      if (limit) this.log(`sleep ${pool} ${phase} stopped at its ${limit} limit`);
      ok = !failed && !limit && !state.stopped && (phase !== "dream" || !!done.journal) && (phase !== "wake" || done.wake);
    } catch (err) {
      this.log(`sleep ${pool} ${phase} failed: ${(err as Error).name}`);
    }
    return { thread: thread.id, ok, ...(limit ? { limit } : {}) };
  }

  private log(line: string): void { this.o.log?.(line); }
}

// --- The sleep-only tools ---

interface SleepTools {
  view: PoolView;
  runId: string;
  threadId: string;
  proposals: PersonaProposals;
  /** What this phase wrote: tonight's journal entry, and whether WAKE is written. */
  done: { journal?: string; wake: boolean };
  /** The person's display name, written as {user} wherever sleep writes it. */
  user: string;
  /** Consolidation has notes to build pages from, so pages come before skimming conversations. */
  pagesFirst: boolean;
  /** Projects' conversations, which their pages are written from, so readable before any page. */
  projectThreads: Set<string>;
}

/** Conversation reads (an entry or thread, or recall) consolidation gets once it has written a page. */
export const GAP_READS = 12;
/** The turn by which consolidation with notes to build from is told to write pages, if it hasn't. */
export const PAGES_NUDGE_TURN = 6;
const PAGES_FIRST = "Write the pages first, from the notes you were shown: p:about-user, and each project's page, with write_page. Then skim the conversations for anything missed.";
const READS_DONE = `That's ${GAP_READS} reads of conversation tonight, which is enough: write what you have and finish.`;

/** The person's whole display name as {user}. Only the whole name: a first name alone can be a date ("May 3rd") or someone else. */
export function asUserToken(text: string, name: string): string {
  const n = name.trim();
  if (n.length < 2) return text;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\w{])${esc}(?![\\w}])`, "g"), "{user}");
}

const words = (t: string) => new Set(t.toLowerCase().replace(/\[[^\]]*\]/g, " ").replace(/\{user[^}]*\}/g, " user ").match(/[\p{L}\p{N}]+/gu) ?? []);
/** Two notes say the same thing: most of their words are shared. */
export function nearCopy(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.6;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** The tools for one phase: consolidate writes notes, pages and questions; dream the journal; wake WAKE. */
export function sleepTools(phase: SleepPhase, s: SleepTools): ExtensionFactory {
  const { view } = s;
  const own = view.own;
  return (pi) => {
    let pages = 0;
    if (phase === "consolidate") {
      // Pages come first, built from the notes shown; then a few reads of conversation for gaps. A refusal says what to do instead.
      let reads = 0;
      let turns = 0;
      pi.on("tool_call", (e) => {
        const id = e.toolName === "read_memory" ? String((e.input as { id?: unknown }).id ?? "") : "";
        const conversation = e.toolName === "recall" || /^(general\/)?[et]:/.test(id);
        if (!conversation) return;
        if (!pages) return s.pagesFirst && !s.projectThreads.has(id) ? { block: true, reason: PAGES_FIRST } : undefined;
        if (++reads > GAP_READS) return { block: true, reason: READS_DONE };
      });
      pi.on("turn_end", () => {
        if (++turns === PAGES_NUDGE_TURN && s.pagesFirst && !pages) {
          pi.sendMessage({ customType: "lyrica-sleep-nudge", content: PAGES_FIRST, display: false }, { deliverAs: "steer" });
        }
      });
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
          const notes = params.notes.map((n) => ({ ...n, text: asUserToken(n.text, s.user) }));
          const copies: string[] = [];
          const fresh = notes.filter((n) => {
            const entries = citationsIn(n.text, view.pool).filter((c) => /^e:/.test(c));
            if (!entries.length) throw new Error("each note cites the entry it came from, like [e:web/3f7a2c#41]");
            const gone = entries.find((e) => own.isTombstoned(e));
            if (gone) throw new Error(`what ${gone} said was deleted from memory on purpose: don't note it again`);
            // A note from the same entry that already says this is the note: cite it instead.
            const same = entries.flatMap((e) => own.usedIn(e)).find((id) => id.startsWith("n:") && nearCopy(n.text, own.get(id, { raw: true })?.text ?? ""));
            if (same) copies.push(same);
            return !same;
          });
          const ids = fresh.length ? own.addNotes(fresh, { author: "sleep" }) : [];
          const already = copies.length ? `${ids.length ? " " : ""}Already noted, so not saved again: ${[...new Set(copies)].map((id) => `[${id}]`).join(", ")}.` : "";
          return text(`${ids.length ? `Saved ${ids.join(", ")}.` : ""}${already}`);
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
          // A project's page belongs to a logged project in this pool: never one in another pool, or one kept out of memory.
          if (params.slug.startsWith("project-")) {
            const project = own.listThreads({ includeHidden: true }).find((t) => t.project && projectSlug(t.id) === params.slug);
            if (!project && !own.get(`p:${params.slug}`)) throw new Error("pages named project-… are projects' pages, and there's no such project here");
            if (project?.unlogged) throw new Error("that project isn't logged in memory, so it keeps no page");
          }
          // The person's own words on the page stay as they wrote them.
          const theirs = own.revisions(`p:${params.slug}`).some((r) => r.author.startsWith("user:"));
          const page = theirs ? params : { ...params, title: asUserToken(params.title, s.user), summary: asUserToken(params.summary, s.user), text: asUserToken(params.text, s.user) };
          const id = own.putPage(page, "sleep");
          pages++;
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
          const id = own.addJournal(`${DREAM_HEADER}\n\n${asUserToken(params.text.trim(), s.user)}`, "sleep");
          s.done.journal = id;
          return text(`Wrote ${id}.`);
        },
      });
      pi.registerTool({
        name: "propose_persona",
        label: "Propose persona change",
        description: `Propose a change to one of your persona files, as its whole new text. It is reviewed before anything changes. SOUL, STYLE and REGISTER together hold at most ${CORE_LIMIT} characters; most growth belongs in a topic file.`,
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
          own.putWake(asUserToken(params.text.trim(), s.user), "sleep");
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
        own.addItem(s.runId, { kind, text: asUserToken(params.text, s.user), source });
        return text(kind === "question" ? "Raised the question." : "Kept it for later.");
      },
    });
  };
}

