// Clips made in the background (DESIGN.md, "Videos"): a clip holds a model host's GPU for minutes, so her
// image tool hands it here and her turn ends. When it is made, or fails, its thread hears of it.
import type { ClipMade } from "@lyrica/extension";
import type { Pool } from "@lyrica/core";

export interface ClipThread { userId: string; pool: Pool; threadId: string }

export interface ClipJobsOptions {
  /** A clip was made: its thread gets the notice and the part the chat shows. */
  done(t: ClipThread, made: ClipMade): void;
  /** A clip failed, or was stopped (`stopped` with the reason): its thread is told why. */
  failed(t: ClipThread, message: string, stopped?: boolean): void;
  log(line: string): void;
}

/** The clips being made, each with its own abort, so Lock or a shutdown stops them. */
export class ClipJobs {
  private readonly running = new Map<AbortController, ClipThread>();

  constructor(private readonly o: ClipJobsOptions) {}

  start(t: ClipThread, make: (signal: AbortSignal) => Promise<ClipMade>): void {
    const controller = new AbortController();
    this.running.set(controller, t);
    void make(controller.signal).then(
      (made) => { if (!controller.signal.aborted) this.o.done(t, made); },
      (err: Error) => this.o.failed(t, controller.signal.aborted ? String(controller.signal.reason ?? "stopped") : err.message, controller.signal.aborted),
    ).catch((err: Error) => this.o.log(`a clip's notice wasn't delivered: ${err.name}`))
      .finally(() => this.running.delete(controller));
  }

  /** How many clips a thread is waiting for. */
  count(userId: string, pool: Pool, threadId: string): number {
    return [...this.running.values()].filter((t) => t.userId === userId && t.pool === pool && t.threadId === threadId).length;
  }

  /**
   * Stops a user's clips (Lock), some of their threads' (forgotten), or everyone's (shutdown), before the
   * clip is saved. Their threads are told they stopped; a forgotten one hears nothing.
   */
  stop(reason: string, userId?: string, threads?: { pool: Pool; ids: string[] }): void {
    for (const [controller, t] of this.running) {
      if (userId && t.userId !== userId) continue;
      if (threads && (t.pool !== threads.pool || !threads.ids.includes(t.threadId))) continue;
      controller.abort(reason);
    }
  }
}
