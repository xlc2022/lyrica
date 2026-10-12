import { describe, nextRun, WAKEUP_LIMITS, type Memory, type Pool } from "@lyrica/core";
import type { ChildThreads } from "./children.ts";
import type { ThreadHost } from "./hosted.ts";

export interface RoutineOptions {
  memory: Memory;
  host: () => ThreadHost;
  children: ChildThreads;
  /** Failure names only, never notes or model errors containing text. */
  log: (line: string) => void;
}

/** Recurring turns on lyricad's wake-up tick (principles 1 and 8). */
export class Routines {
  private readonly unlocked = new Set<string>();
  private readonly firing = new Set<string>();
  /** Last run's destination, including a fresh thread. Restarted turns are never resumed. */
  private readonly lastRun = new Map<string, string>();
  constructor(private readonly o: RoutineOptions) {}

  load(userId: string): void { this.unlocked.add(userId); }
  drop(userId: string): void {
    this.unlocked.delete(userId);
    for (const key of this.lastRun.keys()) if (key.startsWith(`${userId}/`)) this.lastRun.delete(key);
  }

  /** The last run ended; a later user turn is not that run. */
  ended(userId: string, pool: Pool, thread: string): void {
    for (const [key, target] of this.lastRun) {
      if (key.startsWith(`${userId}/${pool}/`) && target === thread) this.lastRun.delete(key);
    }
  }

  tick(now = new Date()): void {
    for (const userId of this.unlocked) for (const pool of ["general", "private"] as const) {
      const view = this.o.memory.openThreadView(userId, pool);
      try {
        for (const r of view.own.routines()) {
          if (!r.paused && Date.parse(r.nextAt) <= now.getTime()) void this.fire(userId, pool, r.id, now);
        }
      } finally { view.close(); }
    }
  }

  private async fire(userId: string, pool: Pool, id: number, now: Date): Promise<void> {
    const key = `${userId}/${pool}/${id}`;
    if (this.firing.has(key)) return;
    this.firing.add(key);
    let slot: ReturnType<ChildThreads["reserveRoutine"]>;
    try {
      const view = this.o.memory.openThreadView(userId, pool);
      let r;
      let due = 0;
      try {
        r = view.own.routines().find(r => r.id === id);
        if (!r || r.paused || !view.own.getThread(r.thread)) return;
        if (this.o.children.routineWaiting(userId, pool, r.thread)) return;
        const last = this.lastRun.get(key);
        const busy = !!last && this.o.host().busy(userId, pool, last);
        // A busy previous run is skipped even if it occupies the last slot.
        if (busy) {
          view.own.advanceRoutine(id, nextRun(r.schedule, now).toISOString());
          return;
        }
        slot = this.o.children.reserveRoutine(userId, pool, r.thread);
        if (!slot) return;
        let at: Date;
        if (r.schedule.kind === "every") {
          due = Math.floor((now.getTime() - Date.parse(r.nextAt)) / (r.schedule.hours * 3_600_000)) + 1;
          at = nextRun(r.schedule, now);
        } else {
          at = new Date(r.nextAt);
          while (at <= now) { due++; at = nextRun(r.schedule, at); }
        }
        const fired = view.own.wakeupsFired(r.thread, new Date(now.getTime() - 86_400_000).toISOString());
        if (fired.length >= WAKEUP_LIMITS.perDay) {
          view.own.advanceRoutine(id, at.toISOString());
          return;
        }
        // Record before opening a session, so concurrent ticks and wake-ups share the cap.
        view.own.advanceRoutine(id, at.toISOString(), now.toISOString());
      } finally { view.close(); }
      const label = describe(r.schedule);
      const target = r.newThread ? await this.o.children.routineThread(userId, pool, r.thread, label) : r.thread;
      if (!this.unlocked.has(userId)) return;
      this.lastRun.set(key, target);
      slot.track(target);
      this.o.children.woke(userId, pool, target);
      const missed = due > 1 ? `${due} runs were due; running once.\n\n` : "";
      await this.o.host().get(userId, pool, target).send(`${missed}${r.note}`, { routine: `[Routine, ${label}]\n\n` });
    } catch (err) {
      this.o.log(`a routine in a ${pool} thread failed: ${(err as Error).name}`);
    } finally {
      slot?.release();
      this.firing.delete(key);
    }
  }
}
