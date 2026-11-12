// Background commands (docs/workspace.md, "Background commands"): a `bash`
// call that returns at once and runs on while her turn goes on or ends. Jobs
// live in lyricad's memory, so they outlive the thread's session; their
// output is kept here only, already capped by the target, and never written
// anywhere. A restart loses them.

import type { ExecutionTarget } from "./ops.ts";
import { SHELLS, simpleCommands, unwrapped } from "./machines.ts";

/** A thread's jobs: running at once, kept after ending, the default and longest time limit (seconds), and output kept (bytes). */
export const JOB_LIMITS = { running: 4, kept: 10, timeoutS: 4 * 3600, maxTimeoutS: 24 * 3600, outputBytes: 64 * 1024 };

export type JobState = "running" | "exited" | "failed" | "timed out" | "stopped";

/** The reason on a job she stopped with `jobs stop`: its result told her, so the end leaves no notice. */
export const STOPPED_BY_HER = "stopped by her";

export interface JobInfo {
  /** `j<n>`, counted per thread. */
  id: string;
  /** A process that isn't a command of hers but holds a running slot: a local MCP server (docs/briefs/mcp-local.md), or the `browse` tool's browser. */
  kind?: "mcp" | "browser";
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
  if (j.kind === "mcp") return `${j.id} in the sandbox, ${how}: the MCP server ${j.command}`;
  if (j.kind === "browser") return `${j.id} in the sandbox, ${how}: the browse tool's browser`;
  return `${j.id} in ${j.place === "sandbox" ? "the sandbox" : j.place}, ${how}: ${j.command}`;
}

/** What lyricad tells the thread when a job ends: the job, and the last lines of its output. A local MCP server's output is never kept. */
export function jobNotice(j: JobInfo, output: string): string {
  if (j.kind === "mcp") return `${jobLine(j)}. Its tools are off until the next turn starts it again.`;
  if (j.kind === "browser") return `${jobLine(j)}. The next browse call opens it again, with its logins kept.`;
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

  /**
   * Holds one of the thread's running slots for a local MCP server (named
   * by `server`) or the thread's browser, so it counts in the process budget as a background command
   * does: `jobs` lists it, `stop` ends it through `onStop`. Refuses a fifth.
   * `release` lets the slot go without a notice (the session closed the
   * server); `died` ends it as failed, with a notice, when it stopped on its own.
   */
  hold(thread: JobThread, server: string, onStop: () => void, kind: "mcp" | "browser" = "mcp"): { id: string; release: () => void; died: (reason?: string) => void } {
    const k = key(thread);
    const list = this.byThread.get(k) ?? [];
    const running = list.filter((j) => j.state === "running");
    if (running.length >= JOB_LIMITS.running) {
      throw new Error(`this thread already has ${running.length} background commands running (${running.map((j) => j.id).join(", ")}), so ${kind === "mcp" ? `the MCP server ${server}` : "the browser"} can't start; stop one with jobs`);
    }
    const n = (this.next.get(k) ?? 0) + 1;
    this.next.set(k, n);
    const job: Job = {
      id: `j${n}`, kind, place: "sandbox", command: server, cwd: "/workspace", startedAt: new Date().toISOString(), state: "running",
      thread, controller: new AbortController(), output: [], outputBytes: 0, dropped: 0,
    };
    job.controller.signal.addEventListener("abort", () => { try { onStop(); } catch { /* already gone */ } }, { once: true });
    list.push(job);
    this.byThread.set(k, list);
    return {
      id: job.id,
      release: () => {
        if (job.state !== "running") return;
        job.state = "exited";
        const l = this.byThread.get(k);
        if (l) l.splice(l.indexOf(job), 1);
      },
      died: (reason) => this.end(job, "failed", null, reason),
    };
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
  stop(thread: JobThread, id: string, reason: string = STOPPED_BY_HER): boolean {
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
  id: j.id, ...(j.kind ? { kind: j.kind } : {}), place: j.place, command: j.command, cwd: j.cwd, startedAt: j.startedAt, state: j.state,
  ...(j.endedAt ? { endedAt: j.endedAt } : {}), ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}), ...(j.reason ? { reason: j.reason } : {}),
});

const text = (j: Job): string => `${j.dropped ? `[… ${j.dropped} bytes left out …]\n` : ""}${Buffer.concat(j.output).toString("utf8")}`;

/** Waiting with `sleep`: a fixed wait this long or longer, or a loop that sleeps this long or longer between checks in her turn, is refused (`sleepWait`). */
export const SLEEP_LIMITS = { fixedS: 60, loopS: 10 };

/** One `sleep` argument in seconds (`90`, `2.5`, `5m`, `1h`, `infinity`), or undefined when it can't be told (`$N`). */
function sleepSeconds(arg: string): number | undefined {
  if (arg === "infinity") return Infinity;
  const m = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(arg);
  return m ? Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "" | "s" | "m" | "h" | "d"] : undefined;
}

/** A command line's sleeps in seconds, nested `bash -c` lines included, and whether it loops (`while`, `until`, `for`, `select`). */
function sleeps(command: string, depth = 0): { seconds: number[]; loop: boolean } {
  const seconds: number[] = [];
  let loop = false;
  for (const parsed of simpleCommands(command)) {
    if (["while", "until", "for", "select"].includes(parsed[0] ?? "")) loop = true;
    const words = unwrapped(parsed);
    if (words[0] === "sleep") {
      const each = words.slice(1).filter((w) => !w.startsWith("-")).map(sleepSeconds);
      if (each.length && each.every((s) => s !== undefined)) seconds.push(each.reduce((a, b) => a! + b!, 0)!);
    } else if (SHELLS.has(words[0] ?? "") && depth < 3) {
      const c = words.indexOf("-c");
      if (c > 0 && words[c + 1]) { const inner = sleeps(words[c + 1]!, depth + 1); seconds.push(...inner.seconds); loop ||= inner.loop; }
    }
  }
  return { seconds, loop };
}

const inWords = (s: number) => (s === Infinity ? "forever" : s < 120 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

/** How to wait instead: on the thing itself, so she hears the moment it's done and her turn isn't held. */
export const WAIT_WAYS = [
  "Wait on the thing itself, and end your turn:",
  "- A long command: run it with bash background: true. You're told the moment it ends.",
  "- A file or log reaching some state: run the check as a loop with background: true, such as until grep -q 'finished' /workspace/scratch/run.log; do sleep 15; done. It ends, and you're told, once the state is reached.",
  "- CI on a pull request: threads watch wakes this thread when its checks finish. For a run with no pull request, gh run watch <run id> --exit-status with background: true.",
  "- A set time with nothing to wait on: threads later.",
].join("\n");

/**
 * Why a `bash` command that waits by sleeping isn't run, or undefined. In her
 * turn, a fixed sleep of `SLEEP_LIMITS.fixedS` or more (all its sleeps
 * together) or a loop that sleeps `SLEEP_LIMITS.loopS` or more between
 * checks holds the thread on a guess at how long something takes. In the
 * background, a loop is the right way to wait for a state, but a fixed sleep
 * that long is only a timer on a guess.
 */
export function sleepWait(command: string, background: boolean): string | undefined {
  const { seconds, loop } = sleeps(command);
  if (!seconds.length) return undefined;
  const total = seconds.reduce((a, b) => a + b, 0);
  if (loop && !background && Math.max(...seconds) >= SLEEP_LIMITS.loopS) {
    return `Not run: this polls in a loop that sleeps ${inWords(Math.max(...seconds))} between checks, holding your turn while it guesses.\n${WAIT_WAYS}`;
  }
  if (!loop && total >= SLEEP_LIMITS.fixedS) {
    return `Not run: this ${background ? "background command is a timer: it " : ""}sleeps ${inWords(total)} on a guess at how long something takes${background ? "" : ", holding your turn"}.\n${WAIT_WAYS}`;
  }
  return undefined;
}
