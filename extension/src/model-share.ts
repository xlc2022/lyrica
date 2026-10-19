import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai";

// Principles 1 and 2: a local server shares one context cache among the
// requests it serves at once (LM Studio's is unified), so threads that each
// fit can overflow it together, and all of them fail. Requests to one local
// model take turns by what they could fill, across every thread, subagent and
// project chat in this daemon (one scope: its Models).

/** Requests to one model at once, by the context it is served with (the operator's tiers), and never more than the server's own slots. */
export function concurrentLimit(window: number, slots?: number): number {
  return Math.min(window >= 500_000 ? 4 : window >= 200_000 ? 2 : 1, slots ?? Infinity);
}

interface Share { used: number; running: number; queue: { need: number; window: number; slots?: number; go: () => void }[] }
/** Each daemon's shares, by its Models: a daemon started again in the same process starts with none. */
const scopes = new WeakMap<object, Map<string, Share>>();

function fits(s: Share, need: number, window: number, slots?: number): boolean {
  return s.running === 0 || (s.running < concurrentLimit(window, slots) && s.used + need <= window);
}

function next(shares: Map<string, Share>, key: string, s: Share): void {
  // First come, first served: a big request at the head isn't overtaken for ever by small ones.
  while (s.queue.length && fits(s, s.queue[0]!.need, s.queue[0]!.window, s.queue[0]!.slots)) s.queue.shift()!.go();
  if (!s.running && !s.queue.length) shares.delete(key);
}

/**
 * Waits until a request that could fill `need` tokens fits beside the ones
 * running on `key` (a local server's model) within its `window`, then holds
 * that much until the returned release is called. One request alone always
 * runs. A request whose signal aborts while it waits leaves the queue.
 */
export function shareModel(scope: object, key: string, need: number, window: number, signal?: AbortSignal, slots?: number): Promise<() => void> {
  let shares = scopes.get(scope);
  if (!shares) scopes.set(scope, shares = new Map());
  const s = shares.get(key) ?? { used: 0, running: 0, queue: [] };
  shares.set(key, s);
  return new Promise((resolve, reject) => {
    const take = () => {
      s.used += need; s.running++;
      let done = false;
      const release = () => { if (done) return; done = true; signal?.removeEventListener("abort", release); s.used -= need; s.running--; next(shares, key, s); };
      // An aborted request gives its share back at once, even if its stream never ends.
      signal?.addEventListener("abort", release, { once: true });
      resolve(release);
    };
    if (!s.queue.length && fits(s, need, window, slots)) return take();
    const entry = { need, window, slots, go: () => { signal?.removeEventListener("abort", leave); take(); } };
    const leave = () => { const i = s.queue.indexOf(entry); if (i >= 0) s.queue.splice(i, 1); next(shares, key, s); reject(signal!.reason ?? new Error("aborted")); };
    if (signal?.aborted) return leave();
    signal?.addEventListener("abort", leave, { once: true });
    s.queue.push(entry);
  });
}

/** Requests running and waiting on `key`, for tests. */
export function modelShare(scope: object, key: string): { running: number; waiting: number; used: number } {
  const s = scopes.get(scope)?.get(key);
  return { running: s?.running ?? 0, waiting: s?.queue.length ?? 0, used: s?.used ?? 0 };
}

type Event = Parameters<AssistantMessageEventStream["push"]>[0];

/**
 * The stream of a request that first waits for its share of the model, and
 * gives it back when the reply ends however it ends. A wait that is aborted
 * ends as an aborted reply; a request that throws, or ends with no reply,
 * ends as an error reply.
 */
export function sharedStream(wait: Promise<() => void>, start: () => AssistantMessageEventStream, failed: (reason: "aborted" | "error", message: string) => Event): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    let release: (() => void) | undefined;
    try {
      release = await wait;
    } catch {
      out.push(failed("aborted", "Stopped while waiting for the model."));
      out.end();
      return;
    }
    let ended = false;
    try {
      for await (const event of start()) {
        out.push(event);
        if (event.type === "done" || event.type === "error") ended = true;
      }
    } catch (err) {
      if (!ended) out.push(failed("error", err instanceof Error ? err.message : String(err)));
      ended = true;
    } finally {
      release();
      if (!ended) out.push(failed("error", "The model's reply ended early."));
      out.end();
    }
  })();
  return out;
}

/**
 * LM Studio's words when the requests it serves together fill its cache.
 * Pi compacts and retries only on the overflow texts it knows, and this isn't
 * one, so the reply's error gets llama.cpp's known words added.
 */
const SHARED_OVERFLOW = /context size has been exceeded/i;
export const OVERFLOW_NOTE = " (exceeds the available context size)";

export function markOverflow(source: AssistantMessageEventStream): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of source) {
      if (event.type === "error" && SHARED_OVERFLOW.test(event.error.errorMessage ?? "") && !event.error.errorMessage!.includes(OVERFLOW_NOTE)) {
        out.push({ ...event, error: { ...event.error, errorMessage: event.error.errorMessage + OVERFLOW_NOTE } });
      } else out.push(event);
    }
    out.end();
  })();
  return out;
}
