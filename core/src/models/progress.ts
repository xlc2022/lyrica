// Principle 1: how far a model host's image or video job has got (host/API.md, "Job progress"), read while the
// call runs so the chat can show it. Only the job's state and fraction come back; nothing is logged.
import { randomBytes } from "node:crypto";

/**
 * Where a job is: waiting for the host's GPU, or running, with its fraction when the host knows it. A queued text
 * job also says what it waits for: other work on its GPUs (`busyWith`, in plain words), or its model loading.
 */
export interface JobProgress { queued: boolean; progress?: number; busyWith?: string; loading?: true }

/** How often a running job is read. */
export const PROGRESS_EVERY_MS = 2_000;
/** A host that hasn't known the job after this many reads (one older than job progress) isn't asked again. */
const UNKNOWN_TRIES = 5;

/**
 * Runs `call` with its job tagged (the headers to send), reading the job's progress every `every` ms until the
 * call ends, and reporting each change. Without `onProgress` the call runs untagged.
 */
export async function withProgress<T>(t: { fetch: typeof fetch; baseUrl: string }, onProgress: ((p: JobProgress) => void) | undefined,
  call: (headers: Record<string, string>) => Promise<T>, every = PROGRESS_EVERY_MS): Promise<T> {
  if (!onProgress) return call({});
  const token = randomBytes(16).toString("base64url");
  const stop = new AbortController();
  let known = false, misses = 0, last = "";
  const read = async () => {
    const res = await t.fetch(`${t.baseUrl}/host/v1/jobs/${token}`, { redirect: "error", signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]) });
    if (res.status === 404 && !known) { await res.body?.cancel(); return ++misses < UNKNOWN_TRIES; }
    if (!res.ok) { await res.body?.cancel(); return true; }
    const body = await res.json() as { state?: unknown; progress?: unknown; busyWith?: unknown; loading?: unknown };
    known = true;
    const queued = body.state === "queued";
    const p: JobProgress = { queued, ...(typeof body.progress === "number" && body.progress >= 0 && body.progress <= 1 ? { progress: body.progress } : {}),
      ...(queued && body.loading === true ? { loading: true as const } : queued && typeof body.busyWith === "string" ? { busyWith: body.busyWith.slice(0, 80) } : {}) };
    const key = JSON.stringify(p);
    if (key !== last) { last = key; onProgress(p); }
    return true;
  };
  void (async () => {
    while (!stop.signal.aborted) {
      await new Promise((r) => setTimeout(r, every).unref());
      if (stop.signal.aborted) break;
      // A read that fails is skipped: the next one may answer.
      if (!await read().catch(() => true)) break;
    }
  })();
  try { return await call({ "x-lyrica-job": token }); }
  finally { stop.abort(); }
}
