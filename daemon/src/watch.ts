import { FROM_PARENT, WATCHING, type Memory, type Pool } from "@lyrica/core";
import type { ThreadHost } from "./hosted.ts";

// Watching threads (DESIGN, Projects): after the person writes in one of a
// project's threads, or a thread posts an update, the project chat takes one
// quiet turn a little later, batched across threads, showing what was said,
// so she can tell the threads it affects. Nothing here is stored: what the
// look quotes is read from the pool when it fires.

export interface WatchOptions {
  memory: Memory;
  host: () => ThreadHost;
  /** Whether the project wants watching now: the setting on, and not paused or hidden. */
  wanted: (userId: string, pool: Pool, project: string) => boolean;
  /** Whether the thread's model calls are kept local (private, or local-only). */
  restricted: (userId: string, pool: Pool, threadId: string) => boolean;
  /** How long after the first trigger the look goes, to batch what follows. */
  delayMs?: number;
}

/** Looks in a row, with no word from the person anywhere in the project, before watching waits for one. */
export const WATCH_RUN = 3;
const QUOTE = 500;

interface Pending { timer: ReturnType<typeof setTimeout>; threads: Map<string, { said: boolean; update: boolean }> }

export class Watcher {
  private readonly pending = new Map<string, Pending>();
  /** Looks since the person last wrote in the project, by `user/pool/project`. */
  private readonly run = new Map<string, number>();

  constructor(private readonly o: WatchOptions) {}

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
        theirs = !!last && !FROM_PARENT.test(last) && !WATCHING.test(last);
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
    try {
      const view = this.o.memory.openThreadView(userId, pool);
      try { if (view.own.getThread(threadId)?.unlogged !== false) return; } finally { view.close(); }
    } catch { return; }
    this.add(userId, pool, project, threadId, "update");
  }

  /** Lock or shutdown: nothing pending goes. */
  close(userId?: string): void {
    for (const [k, p] of this.pending) if (!userId || k.startsWith(`${userId}/`)) { clearTimeout(p.timer); this.pending.delete(k); }
  }

  private add(userId: string, pool: Pool, project: string, threadId: string, what: "said" | "update"): void {
    const k = key(userId, pool, project);
    if ((this.run.get(k) ?? 0) >= WATCH_RUN || !this.o.wanted(userId, pool, project) || !this.mayQuote(userId, pool, project, threadId)) return;
    let p = this.pending.get(k);
    if (!p) {
      p = { timer: setTimeout(() => void this.look(userId, pool, project), this.o.delayMs ?? 30_000), threads: new Map() };
      p.timer.unref?.();
      this.pending.set(k, p);
    }
    const t = p.threads.get(threadId) ?? { said: false, update: false };
    t[what] = true;
    p.threads.set(threadId, t);
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
    // A turn running there: look once it's done, rather than join a message the person wrote.
    if (this.o.host().busy(userId, pool, project)) {
      p.timer = setTimeout(() => void this.look(userId, pool, project), (this.o.delayMs ?? 30_000) / 2);
      p.timer.unref?.();
      return;
    }
    this.pending.delete(k);
    let text: string;
    try {
      text = this.digest(userId, pool, new Map([...p.threads].filter(([id]) => this.mayQuote(userId, pool, project, id))));
    } catch { return; /* locked */ }
    if (!text) return;
    this.run.set(k, (this.run.get(k) ?? 0) + 1);
    try {
      await this.o.host().get(userId, pool, project).send(text, { watching: true });
    } catch { /* offline or locked: the cards still show it */ }
  }

  private digest(userId: string, pool: Pool, threads: Map<string, { said: boolean; update: boolean }>): string {
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      const own = view.own;
      const parts: string[] = [];
      for (const [id, t] of threads) {
        if (!own.getThread(id) || own.getThread(id)!.unlogged) continue;
        const lines = [`In [t:${id}]:`];
        if (t.said) {
          const said = own.lastEntry(id, ["user"])?.text ?? "";
          const reply = own.lastEntry(id, ["assistant"])?.text ?? "";
          if (said && !FROM_PARENT.test(said)) lines.push(`- The person wrote: ${quote(said)}`);
          if (reply) lines.push(`- The thread answered: ${quote(reply)}`);
        }
        if (t.update) lines.push("- It posted an update here (above).");
        if (lines.length > 1) parts.push(lines.join("\n"));
      }
      return parts.join("\n\n");
    } finally {
      view.close();
    }
  }
}

const key = (userId: string, pool: Pool, project: string) => `${userId}/${pool}/${project}`;
const quote = (s: string) => {
  const flat = s.trim();
  return JSON.stringify(flat.length > QUOTE ? `${flat.slice(0, QUOTE)}…` : flat);
};
