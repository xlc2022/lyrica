// Principles 2 and 6: two of her threads that change one file agree who does
// what, as people's threads do, instead of writing over each other. The tool
// holds the write; nothing relies on her remembering to check.
import type { Pool } from "@lyrica/core";

/** How long a write marks a file as another thread's work. */
export const SAME_FILE_MS = 2 * 60 * 60_000;

export interface SameFileOptions {
  /** Whether the thread still exists in its pool. */
  exists(userId: string, pool: Pool, threadId: string): boolean;
  /** Whether the thread is in a turn now: only then is there anyone to agree with, so only then is a write held. */
  busy?(userId: string, pool: Pool, threadId: string): boolean;
  /** Tells `to` that `from` is about to change the file too: steered into its turn, or kept for its next. */
  tell(userId: string, pool: Pool, to: string, from: string, text: string): void;
  /** These threads were held or let go: their project's views redraw them. */
  changed?(userId: string, pool: Pool, threads: string[]): void;
  now?: () => number;
}

interface Write { thread: string; at: number }
/** A hold not yet settled: which thread is on the other side, and the file (as the held thread named it). */
export interface Hold { other: string; path: string; key: string; at: number }

/**
 * Who last wrote each file, in memory only (keys are paths, never content,
 * and a restart forgets them). A thread about to change a file another
 * thread in the same pool changed within SAME_FILE_MS is held once while
 * that thread is working, and the other thread is told; its next write to
 * the file goes through. Both show as Blocked until then, or until one
 * messages the other. If the other thread isn't working, the write goes
 * through and it is told for its next turn.
 */
export class SameFile {
  private readonly writes = new Map<string, Write>();
  /** `user/pool/key/thread/other`: this thread was held for that one's work on the file, so it may go on. */
  private readonly told = new Set<string>();
  /** Both sides of each unsettled hold, by `user/pool/thread`: shown as Blocked until the write goes through or one messages the other. */
  private readonly holds = new Map<string, Hold>();

  constructor(private readonly o: SameFileOptions) {}

  /**
   * Before `thread` writes the file `key` (Workspace.fileKey) shown to it as
   * `path`: the text it gets instead, or undefined to go ahead (and the write
   * is recorded as its own).
   */
  claim(userId: string, pool: Pool, thread: string, key: string | undefined, path: string): string | undefined {
    if (!key) return undefined;
    const now = this.o.now?.() ?? Date.now();
    const k = `${userId}/${pool}/${key}`;
    this.expire(now);
    const last = this.writes.get(k);
    const mark = last && `${k}/${thread}/${last.thread}`;
    if (last && last.thread !== thread && !this.told.has(mark!) && this.o.exists(userId, pool, last.thread)) {
      // Told once each way: the other side may now go on too, without being held or told again for this one.
      this.told.add(mark!);
      this.told.add(`${k}/${last.thread}/${thread}`);
      const minutes = Math.max(1, Math.round((now - last.at) / 60_000));
      // A thread that isn't working can't agree on anything: it hears of the change for its next turn, and the write goes through.
      if (this.o.busy && !this.o.busy(userId, pool, last.thread)) {
        this.o.tell(userId, pool, last.thread, thread,
          `[t:${thread}] changed ${path}, which you changed ${minutes} min ago, while you weren't working. Check it still fits your work before you change the file again.`);
        this.writes.set(k, { thread, at: now });
        return undefined;
      }
      this.hold(userId, pool, thread, last.thread, path, k, now);
      this.o.tell(userId, pool, last.thread, thread,
        `[t:${thread}] is about to change ${path}, which you changed ${minutes} min ago. Agree with it who changes what before either of you changes the file again.`);
      return `Not changed yet: [t:${last.thread}] changed ${path} ${minutes} min ago, and it has been told you're on the same file. `
        + `Agree with it who changes what (in a project, message it with threads), then make your change; it goes through next time.`;
    }
    this.writes.set(k, { thread, at: now });
    const h = this.holds.get(`${userId}/${pool}/${thread}`);
    if (h?.key === k) this.settle(userId, pool, thread, h.other);
    return undefined;
  }

  /** The thread's unsettled hold, if it has one: as held, or as the thread the other was held for. */
  held(userId: string, pool: Pool, thread: string): { other: string; path: string } | undefined {
    const h = this.holds.get(`${userId}/${pool}/${thread}`);
    if (!h) return undefined;
    if ((this.o.now?.() ?? Date.now()) - h.at >= SAME_FILE_MS) { this.settle(userId, pool, thread, h.other); return undefined; }
    return { other: h.other, path: h.path };
  }

  /** One thread messaged another: a hold between them is theirs to settle now, so neither shows as held. */
  messaged(userId: string, pool: Pool, from: string, to: string): void {
    if (this.holds.get(`${userId}/${pool}/${from}`)?.other === to) this.settle(userId, pool, from, to);
  }

  private hold(userId: string, pool: Pool, thread: string, other: string, path: string, key: string, at: number): void {
    this.holds.set(`${userId}/${pool}/${thread}`, { other, path, key, at });
    this.holds.set(`${userId}/${pool}/${other}`, { other: thread, path, key, at });
    this.o.changed?.(userId, pool, [thread, other]);
  }

  private settle(userId: string, pool: Pool, thread: string, other: string): void {
    for (const [a, b] of [[thread, other], [other, thread]]) {
      if (this.holds.get(`${userId}/${pool}/${a}`)?.other === b) this.holds.delete(`${userId}/${pool}/${a}`);
    }
    this.o.changed?.(userId, pool, [thread, other]);
  }

  /**
   * After `thread`'s command changed the file `key`, found by the sweep for
   * files newer than the command's start (`since`): a command can't be held
   * before it runs, so when another thread changed the file within
   * SAME_FILE_MS, before the command started, both are told now. Either way
   * the change is recorded as this thread's, so the other's next write is held.
   * A change by another thread while the command ran is nobody's for sure: left as it is.
   */
  changed(userId: string, pool: Pool, thread: string, key: string | undefined, path: string, since: number): void {
    if (!key) return;
    const now = this.o.now?.() ?? Date.now();
    const k = `${userId}/${pool}/${key}`;
    this.expire(now);
    const last = this.writes.get(k);
    if (last && last.thread !== thread && last.at >= since) return;
    const mark = last && `${k}/${thread}/${last.thread}`;
    if (last && last.thread !== thread && !this.told.has(mark!) && this.o.exists(userId, pool, last.thread)) {
      this.told.add(mark!);
      this.told.add(`${k}/${last.thread}/${thread}`);
      const minutes = Math.max(1, Math.round((since - last.at) / 60_000));
      this.o.tell(userId, pool, last.thread, thread,
        `[t:${thread}] changed ${path} with a command, which you changed ${minutes} min before. Agree with it who changes what before either of you changes the file again.`);
      this.o.tell(userId, pool, thread, last.thread,
        `Your command changed ${path}, which [t:${last.thread}] changed ${minutes} min before, and it has been told. `
        + `Agree with it who changes what (in a project, message it with threads) before either of you changes the file again.`);
    }
    this.writes.set(k, { thread, at: now });
  }

  private expire(now: number): void {
    for (const [w, v] of this.writes) {
      if (now - v.at < SAME_FILE_MS) continue;
      this.writes.delete(w);
      for (const t of this.told) if (t.startsWith(`${w}/`)) this.told.delete(t);
    }
  }
}
