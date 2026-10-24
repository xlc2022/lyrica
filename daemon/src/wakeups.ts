import { FORGE_WAKES_PER_DAY, WAKEUP_LIMITS, wakeupMark, type Memory, type Pool } from "@lyrica/core";
import type { ThreadContext } from "@lyrica/extension";
import type { WakeupInfo } from "./api.ts";
import type { ChildThreads } from "./children.ts";
import type { ThreadHost } from "./hosted.ts";

// Wake-ups (DESIGN.md, Projects): a thread's note to itself, which starts a
// turn there at its time. Stored in the thread's pool, so the note is as
// encrypted as the thread and survives a restart; due times are held in
// memory for unlocked users, and lyricad's tick fires them. A wake-up of a
// locked user fires at unlock, marked with when it was due.


interface Due extends WakeupInfo { pool: Pool; thread: string }

/** The note of a turn a plan's usage limit cut off: it carries on once the plan resets, or when the user falls back. */
export const PLAN_LIMIT_RESUME = "Your model's plan reached its usage limit, which cut your last turn off. Carry on with what you were doing.";
/** The note of a thread whose claude delegate run the Claude plan's usage limit stopped: it carries on once that plan resets, or when the user falls back. */
export const CLAUDE_LIMIT_RESUME = "The Claude plan reached its usage limit, which stopped a claude delegate run of yours. Carry on with it now: continue the run with delegate action message (delegate status lists it). If the user chose to fall back until the plan resets, the claude role is refused, so hand its job to the coder role instead, with what its thread shows so far.";
const limitMark = (note: string) => (note === PLAN_LIMIT_RESUME ? { planLimit: true as const } : note === CLAUDE_LIMIT_RESUME ? { planLimit: true as const, claudeCode: true as const } : {});

/** A wake-up this much past its time says when it was due. */
const LATE_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

export interface WakeupOptions {
  memory: Memory;
  host: () => ThreadHost;
  children: ChildThreads;
  /** For failures that aren't the user's: never the note. */
  log: (line: string) => void;
}

export class Wakeups {
  /** Pending wake-ups of unlocked users, by user. */
  private readonly due = new Map<string, Due[]>();
  private readonly firing = new Set<string>();

  constructor(private readonly o: WakeupOptions) {}

  /** At unlock: the user's pending wake-ups, from both pools. */
  load(userId: string): void {
    const all: Due[] = [];
    for (const pool of ["general", "private"] as const) {
      const view = this.o.memory.openThreadView(userId, pool);
      try {
        for (const w of view.own.wakeups()) all.push({ id: w.id, dueAt: w.dueAt, pool, thread: w.thread, ...limitMark(w.note) });
      } finally {
        view.close();
      }
    }
    this.due.set(userId, all);
  }

  /** At Lock: their due times leave memory; the pool keeps the wake-ups. */
  drop(userId: string): void {
    this.due.delete(userId);
  }

  /** A thread's pending wake-ups, soonest first. */
  list(userId: string, pool: Pool, thread: string): WakeupInfo[] {
    return (this.due.get(userId) ?? []).filter((d) => d.pool === pool && d.thread === thread)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id - b.id).map(({ id, dueAt, planLimit, claudeCode }) => ({ id, dueAt, ...(planLimit ? { planLimit } : {}), ...(claudeCode ? { claudeCode } : {}) }));
  }

  /** The user's threads waiting for a plan's usage limit to reset. */
  waitingForPlans(userId: string): { pool: Pool; thread: string; dueAt: string; claudeCode?: true }[] {
    return (this.due.get(userId) ?? []).filter((d) => d.planLimit).map(({ pool, thread, dueAt, claudeCode }) => ({ pool, thread, dueAt, ...(claudeCode ? { claudeCode } : {}) }));
  }

  /** The user fell back from a limited plan: these threads' waiting turns (or, for Claude Code's plan, their claude runs') carry on now. */
  resumeNow(userId: string, threads: { pool: Pool; thread: string }[], claudeCode = false, now = new Date()): void {
    for (const d of this.due.get(userId) ?? []) {
      if (d.planLimit && !d.claudeCode === !claudeCode && threads.some((t) => t.pool === d.pool && t.thread === d.thread)) { d.dueAt = now.toISOString(); void this.fire(userId, d, now); }
    }
  }

  /** Her `threads later`: a wake-up for the thread she's in, `minutes` from now. */
  set(from: ThreadContext, minutes: number, note: string, now = new Date()): { dueAt: string } {
    const own = from.view.own;
    const pending = own.wakeups(from.threadId).filter((w) => !w.source);
    if (pending.length >= WAKEUP_LIMITS.pending) {
      throw new Error(`this thread has ${pending.length} wake-ups waiting already (${pending.map((w) => `${w.dueAt.slice(0, 16)}Z`).join(", ")}); drop them with cancel: true, or wait for one`);
    }
    const fired = own.wakeupsFired(from.threadId, new Date(now.getTime() - DAY_MS).toISOString());
    if (fired.length >= WAKEUP_LIMITS.perDay) {
      const resets = new Date(Date.parse(fired[0]!) + DAY_MS).toISOString();
      throw new Error(`this thread's wake-ups and routines fired ${fired.length} times in the last day; the next can be set after ${resets.slice(0, 16)}Z`);
    }
    const dueAt = new Date(now.getTime() + minutes * 60_000).toISOString();
    const id = own.addWakeup(from.threadId, dueAt, note, now.toISOString());
    const userId = from.user.id;
    this.due.set(userId, [...this.due.get(userId) ?? [], { id, dueAt, pool: from.pool, thread: from.threadId }]);
    this.changed(userId, from.pool, from.threadId);
    return { dueAt };
  }

  /** A wake-up lyricad sets for a thread (a plan's limit cut its turn off), outside her own wake-up limits. */
  resume(userId: string, pool: Pool, thread: string, dueAt: Date, note: string): void {
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      // One such resume per thread: a later cut-off moves it rather than adding another.
      const moved = view.own.wakeups(thread).filter((w) => w.note === note).map((w) => (view.own.removeWakeups(thread, w.id), w.id));
      const id = view.own.addWakeup(thread, dueAt.toISOString(), note, new Date().toISOString());
      const due = (this.due.get(userId) ?? []).filter((d) => d.pool !== pool || !moved.includes(d.id));
      this.due.set(userId, [...due, { id, dueAt: dueAt.toISOString(), pool, thread, ...limitMark(note) }]);
    } finally {
      view.close();
    }
    this.changed(userId, pool, thread);
  }

  /** Her `threads later` with `cancel`: the thread's pending wake-ups go. */
  cancel(from: ThreadContext): number {
    // CI and review wakes stay: they aren't hers to drop.
    const kept = new Set(from.view.own.wakeups(from.threadId).filter((w) => w.source).map((w) => w.id));
    const n = from.view.own.removeWakeups(from.threadId);
    const list = this.due.get(from.user.id);
    if (list) this.due.set(from.user.id, list.filter((d) => d.pool !== from.pool || d.thread !== from.threadId || kept.has(d.id)));
    this.changed(from.user.id, from.pool, from.threadId);
    return n;
  }

  /** The user removed one from the thread's facts line. Returns whether it was there. */
  remove(userId: string, pool: Pool, thread: string, id: number): boolean {
    const view = this.o.memory.openThreadView(userId, pool);
    let n: number;
    try {
      n = view.own.removeWakeups(thread, id);
    } finally {
      view.close();
    }
    this.due.set(userId, (this.due.get(userId) ?? []).filter((d) => !(d.pool === pool && d.thread === thread && d.id === id)));
    this.changed(userId, pool, thread);
    return n > 0;
  }

  /** Forgotten threads: their due times go (the store drops the rows with the thread). */
  forget(userId: string, pool: Pool, threads: string[]): void {
    const list = this.due.get(userId);
    if (list) this.due.set(userId, list.filter((d) => d.pool !== pool || !threads.includes(d.thread)));
  }

  /** lyricad's tick: fires what is due, for every unlocked user. */
  tick(now = new Date()): void {
    for (const [userId, list] of this.due) {
      for (const d of list) if (Date.parse(d.dueAt) <= now.getTime()) void this.fire(userId, d, now);
    }
  }

  /** A forge poll's note (docs/briefs/ci-wakes.md): the poller already stored its wake-up; fire it through the same guards as a scheduled one. */
  wake(userId: string, pool: Pool, thread: string, id: number, now = new Date()): void {
    const d: Due = { id, dueAt: now.toISOString(), pool, thread };
    this.due.set(userId, [...this.due.get(userId) ?? [], d]);
    void this.fire(userId, d, now);
  }

  /**
   * One wake-up: its note becomes the thread's next turn, or joins the
   * running one, marked. It waits while the thread can't start a turn (a
   * child past the at-once limit, a queued thread, a paused project's).
   */
  private async fire(userId: string, d: Due, now: Date): Promise<void> {
    const key = `${userId}/${d.pool}/${d.id}`;
    if (this.firing.has(key) || !this.o.children.mayWake(userId, d.pool, d.thread)) return;
    this.firing.add(key);
    try {
      const view = this.o.memory.openThreadView(userId, d.pool);
      let w;
      try {
        w = view.own.getThread(d.thread) ? view.own.wakeups(d.thread).find((x) => x.id === d.id) : undefined;
        // Hers and routines' share one cap; CI and review wakes have their own, so a busy pull request can't use hers up or wait on it.
        if (w && view.own.wakeupsFired(d.thread, new Date(now.getTime() - DAY_MS).toISOString(), w.source).length >= (w.source ? FORGE_WAKES_PER_DAY : WAKEUP_LIMITS.perDay)) return;
        if (w) view.own.fireWakeup(d.id, now.toISOString());
      } finally {
        view.close();
      }
      this.due.set(userId, (this.due.get(userId) ?? []).filter((x) => x !== d));
      if (!w) return;
      this.changed(userId, d.pool, d.thread);
      this.o.children.woke(userId, d.pool, d.thread);
      const late = now.getTime() - Date.parse(w.dueAt) > LATE_MS ? w.dueAt : undefined;
      await this.o.host().get(userId, d.pool, d.thread).send(w.note, { wakeup: wakeupMark(w.setAt, late) });
    } catch (err) {
      this.o.log(`a wake-up in a ${d.pool} thread failed: ${(err as Error).name}`);
    } finally {
      this.firing.delete(key);
    }
  }

  /** The thread's views, and its project chat's card, hear of the change. */
  private changed(userId: string, pool: Pool, thread: string): void {
    const host = this.o.host();
    host.peek(userId, pool, thread)?.publish({ type: "wakeups", wakeups: this.list(userId, pool, thread) });
    const parent = this.o.children.parentOf(userId, pool, thread);
    if (parent) host.changed(userId, pool, parent, thread);
  }
}
