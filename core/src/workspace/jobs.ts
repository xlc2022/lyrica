// Background commands (docs/workspace.md, "Background commands"): a `bash`
// call that returns at once and runs on while her turn goes on or ends. Jobs
// live in lyricad's memory, so they outlive the thread's session; their
// output is kept here only, already capped by the target, and never written
// anywhere. A restart loses them.

import type { ExecutionTarget } from "./ops.ts";

/** A thread's jobs: running at once, kept after ending, the default and longest time limit (seconds), and output kept (bytes). */
export const JOB_LIMITS = { running: 4, kept: 10, timeoutS: 4 * 3600, maxTimeoutS: 24 * 3600, outputBytes: 64 * 1024 };

export type JobState = "running" | "exited" | "failed" | "timed out" | "stopped";

export interface JobInfo {
  /** `j<n>`, counted per thread. */
  id: string;
  /** "sandbox" or the machine's name. */
  place: string;
  command: string;
  /** Where it runs, on its place. */
  cwd: string;
  startedAt: string;
  endedAt?: string;
  state: JobState;
  exitCode?: number | null;
  /** Why it failed or stopped, in plain words. */
  reason?: string;
}

/** The thread a job belongs to. */
export interface JobThread { userId: string; pool: string; threadId: string }

interface Job extends JobInfo {
  thread: JobThread;
  controller: AbortController;
  output: Buffer[];
  outputBytes: number;
  dropped: number;
}

const key = (t: JobThread) => `${t.userId}/${t.pool}/${t.threadId}`;

/** The last `n` lines of `text`. */
export const lastLines = (text: string, n: number): string => text.split("\n").slice(-n).join("\n");

/** How long a job ran, in words: "42 s", "12 min", "3 h 5 min". */
export function jobDuration(from: string, to: string): string {
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** One line about a job, for `jobs list` and her notices. */
export function jobLine(j: JobInfo, now = new Date().toISOString()): string {
  const how = j.state === "running" ? `running for ${jobDuration(j.startedAt, now)}`
    : `${j.state}${j.exitCode !== undefined && j.exitCode !== null ? ` with code ${j.exitCode}` : ""} after ${jobDuration(j.startedAt, j.endedAt ?? now)}${j.reason ? ` (${j.reason})` : ""}`;
  return `${j.id} in ${j.place === "sandbox" ? "the sandbox" : j.place}, ${how}: ${j.command}`;
}

/** What lyricad tells the thread when a job ends: the job, and the last lines of its output. */
export function jobNotice(j: JobInfo, output: string): string {
  const tail = lastLines(output.trimEnd(), 40);
  return `Background command ${jobLine(j)}\n${tail ? `Last output:\n${tail}` : "No output."}`;
}

/**
 * The background commands of every thread. `onEnd` hears of each job once,
 * when it exits, fails, times out or is stopped, with its kept output.
 */
export class Jobs {
  private readonly byThread = new Map<string, Job[]>();
  private readonly next = new Map<string, number>();

  constructor(private readonly onEnd: (thread: JobThread, job: JobInfo, output: string) => void = () => {}) {}

  /** Starts `command` on `target` in `cwd`. Refuses a fifth running job in the thread. */
  start(thread: JobThread, place: string, target: ExecutionTarget, command: string, cwd: string, timeoutS = JOB_LIMITS.timeoutS): JobInfo {
    const k = key(thread);
    const list = this.byThread.get(k) ?? [];
    const running = list.filter((j) => j.state === "running");
    if (running.length >= JOB_LIMITS.running) {
      throw new Error(`this thread already has ${running.length} background commands running (${running.map((j) => j.id).join(", ")}); wait for one, or stop one with jobs`);
    }
    if (!(timeoutS > 0)) throw new Error("timeout must be a positive number of seconds");
    const n = (this.next.get(k) ?? 0) + 1;
    this.next.set(k, n);
    const job: Job = {
      id: `j${n}`, place, command, cwd, startedAt: new Date().toISOString(), state: "running",
      thread, controller: new AbortController(), output: [], outputBytes: 0, dropped: 0,
    };
    list.push(job);
    this.byThread.set(k, list);
    const timeout = Math.min(timeoutS, JOB_LIMITS.maxTimeoutS);
    const timer = setTimeout(() => this.end(job, "timed out", null), timeout * 1000);
    timer.unref();
    target.ops().bash.exec(command, cwd, { onData: (d) => this.keep(job, d), signal: job.controller.signal })
      .then(({ exitCode }) => this.end(job, exitCode === 0 ? "exited" : "failed", exitCode))
      .catch((err: Error) => this.end(job, "failed", null, err.message))
      .finally(() => clearTimeout(timer));
    return info(job);
  }

  /** The thread's jobs, oldest first. */
  list(thread: JobThread): JobInfo[] {
    return (this.byThread.get(key(thread)) ?? []).map(info);
  }

  /** A job's kept output so far. */
  output(thread: JobThread, id: string): { job: JobInfo; output: string } {
    const job = this.find(thread, id);
    return { job: info(job), output: text(job) };
  }

  /** Stops a running job. False if it had already ended. */
  stop(thread: JobThread, id: string, reason = "stopped by her"): boolean {
    const job = this.find(thread, id);
    if (job.state !== "running") return false;
    this.end(job, "stopped", null, reason);
    return true;
  }

  /** Stops every running job of the user (Lock, a wipe), or of some of their threads (forgotten), and forgets them. */
  stopUser(userId: string, reason: string, threads?: { pool: string; ids: string[] }): void {
    for (const [k, list] of this.byThread) {
      const t = list[0]?.thread;
      if (!t || t.userId !== userId || (threads && (t.pool !== threads.pool || !threads.ids.includes(t.threadId)))) continue;
      for (const j of list) if (j.state === "running") this.end(j, "stopped", null, reason);
      this.byThread.delete(k);
      this.next.delete(k);
    }
  }

  /** Every running job's thread, for shutdown: ids only. */
  running(): (JobThread & { id: string })[] {
    return [...this.byThread.values()].flat().filter((j) => j.state === "running").map((j) => ({ ...j.thread, id: j.id }));
  }

  private find(thread: JobThread, id: string): Job {
    const job = this.byThread.get(key(thread))?.find((j) => j.id === id);
    if (!job) throw new Error(`no background command ${id} in this thread`);
    return job;
  }

  private keep(job: Job, data: Buffer): void {
    job.output.push(data);
    job.outputBytes += data.length;
    // The target caps output already; this only bounds what a job holds here.
    while (job.output.length > 1 && job.outputBytes - job.output[0]!.length >= JOB_LIMITS.outputBytes) {
      job.outputBytes -= job.output[0]!.length;
      job.dropped += job.output.shift()!.length;
    }
  }

  private end(job: Job, state: JobState, exitCode: number | null, reason?: string): void {
    if (job.state !== "running") return;
    Object.assign(job, { state, endedAt: new Date().toISOString(), ...(state === "stopped" || state === "timed out" ? {} : { exitCode }), ...(reason ? { reason } : {}) });
    job.controller.abort();
    const list = this.byThread.get(key(job.thread));
    if (list) {
      const ended = list.filter((j) => j.state !== "running");
      for (const old of ended.slice(0, Math.max(0, ended.length - JOB_LIMITS.kept))) list.splice(list.indexOf(old), 1);
    }
    try { this.onEnd(job.thread, info(job), text(job)); } catch { /* the thread is gone or locked */ }
  }
}

const info = (j: Job): JobInfo => ({
  id: j.id, place: j.place, command: j.command, cwd: j.cwd, startedAt: j.startedAt, state: j.state,
  ...(j.endedAt ? { endedAt: j.endedAt } : {}), ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}), ...(j.reason ? { reason: j.reason } : {}),
});

const text = (j: Job): string => `${j.dropped ? `[… ${j.dropped} bytes left out …]\n` : ""}${Buffer.concat(j.output).toString("utf8")}`;
