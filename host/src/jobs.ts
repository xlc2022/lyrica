// How far an image, video or text job has got (API.md, "Job progress"), for the chat's placeholder or status line.
// A client tags its job with X-Lyrica-Job; only the job's state, fraction and what it waits for are kept, and only while it runs.
import type { IncomingMessage } from "node:http";
import { invalid } from "./http.ts";

import type { QueuePhase } from "./scheduler.ts";

/** While queued, a text job also says what it waits for: other work on its GPUs (`busyWith`), or its model loading. */
export interface JobState { state: "queued" | "running"; progress: number | null; busyWith?: string; loading?: true }

/** What a running job reports through. */
export interface JobProgress { running(): void; progress(fraction: number): void; waiting(p: QueuePhase): void }

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export class Jobs {
  private readonly jobs = new Map<string, JobState>();

  /** The job's token from its request, or none; a malformed one is refused before anything runs. */
  token(req: IncomingMessage): string | undefined {
    const t = req.headers["x-lyrica-job"];
    if (t === undefined) return undefined;
    if (typeof t !== "string" || !TOKEN.test(t)) throw invalid("X-Lyrica-Job must be 16 to 64 letters, digits, - or _.");
    if (this.jobs.has(t)) throw invalid("That X-Lyrica-Job is already in use.");
    return t;
  }

  /** Runs `fn`, readable under `token` (queued until it calls `running`) until it ends. */
  async track<T>(token: string | undefined, fn: (job: JobProgress) => Promise<T>): Promise<T> {
    const job: JobState = { state: "queued", progress: null };
    if (token) this.jobs.set(token, job);
    try {
      return await fn({
        running: () => {
          job.state = "running";
          delete job.busyWith;
          delete job.loading;
        },
        waiting: (p) => {
          delete job.busyWith;
          delete job.loading;
          if (p.state === "loading") job.loading = true;
          else job.busyWith = p.busyWith;
        },
        // Never backwards: a sampler that starts over doesn't undo the bar.
        progress: (f) => { job.progress = Math.max(job.progress ?? 0, Math.min(1, Math.max(0, f))); },
      });
    } finally {
      if (token) this.jobs.delete(token);
    }
  }

  get(token: string): JobState | undefined {
    const j = this.jobs.get(token);
    return j && { ...j };
  }
}
