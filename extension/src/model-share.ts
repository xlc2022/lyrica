import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai";

// Principles 1 and 2: a local server shares one context cache among the
// requests it serves at once (LM Studio's is unified), so threads that each
// fit can overflow it together, and all of them fail. Requests to one local
// model take turns by what they could fill, across every thread, subagent and
// project chat in this daemon (one scope: its Models).
//
// Principle 8: a server with fewer slots than busy threads keeps only a few
// prompts cached. Handed out first come, first served, a thread's next call
// (after its tools run) usually lands on a slot holding another thread's
// prompt and reads its whole context again at prefill speed. So a thread's
// slot is kept for it a short while after each call, though never against a
// request that has already waited too long.

/** How long a slot stays kept for the thread that just used it, so its next call finds its prompt cached. */
export const KEEP_WARM_MS = 15_000;
/** No slot is kept against a request that has waited this long. */
export const MAX_PASSED_MS = 120_000;

interface Entry { need: number; window: number; slots?: number; since: number; go: () => void }
interface Kept { need: number; timer: NodeJS.Timeout }
interface Share {
  used: number;
  running: number;
  queue: Entry[];
  /** Slots kept for the thread that last used them, with the room their next call takes. */
  kept: Map<object, Kept>;
}
/** Each daemon's shares, by its Models: a daemon started again in the same process starts with none. */
const scopes = new WeakMap<object, Map<string, Share>>();

function fits(s: Share, need: number, window: number, slots?: number): boolean {
  // At most the slots the server says it serves at once, kept ones counted; none said, no limit but the cache.
  const busy = s.running + s.kept.size;
  return busy === 0 || (busy < (slots ?? Infinity) && s.used + need <= window);
}

function next(shares: Map<string, Share>, key: string, s: Share): void {
  // First come, first served: a big request at the head isn't overtaken for ever by small ones.
  while (s.queue.length && fits(s, s.queue[0]!.need, s.queue[0]!.window, s.queue[0]!.slots)) s.queue.shift()!.go();
  if (!s.running && !s.queue.length && !s.kept.size) shares.delete(key);
}

function unkeep(s: Share, holder: object): void {
  const k = s.kept.get(holder);
  if (!k) return;
  clearTimeout(k.timer);
  s.kept.delete(holder);
  s.used -= k.need;
}

/**
 * Waits until a request that could fill `need` tokens fits beside the ones
 * running on `key` (a local server's model) within its `window`, then holds
 * that much until the returned release is called. One request alone always
 * runs. A request whose signal aborts while it waits leaves the queue.
 * `holder` (the thread's model runtime) keeps its slot warm between its calls
 * when the server reports `slots`.
 */
export function shareModel(scope: object, key: string, need: number, window: number, signal?: AbortSignal, slots?: number, holder?: object): Promise<() => void> {
  let shares = scopes.get(scope);
  if (!shares) scopes.set(scope, shares = new Map());
  const s: Share = shares.get(key) ?? { used: 0, running: 0, queue: [], kept: new Map() };
  shares.set(key, s);
  return new Promise((resolve, reject) => {
    const take = () => {
      s.used += need; s.running++;
      let done = false;
      const release = (keep: boolean) => {
        if (done) return; done = true;
        signal?.removeEventListener("abort", onAbort);
        s.running--;
        // Its slot stays its own a while, unless someone has waited too long already.
        const head = s.queue[0];
        if (keep && holder && slots && !(head && Date.now() - head.since >= MAX_PASSED_MS)) {
          const timer = setTimeout(() => { unkeep(s, holder); next(shares, key, s); }, KEEP_WARM_MS);
          timer.unref?.();
          s.kept.set(holder, { need, timer });
        } else s.used -= need;
        next(shares, key, s);
      };
      // An aborted request gives its share back at once, even if its stream never ends, and keeps no slot.
      const onAbort = () => release(false);
      signal?.addEventListener("abort", onAbort, { once: true });
      resolve(() => release(true));
    };
    // Its own kept slot is free for it whoever waits.
    if (holder && s.kept.has(holder)) {
      unkeep(s, holder);
      if (fits(s, need, window, slots)) return take();
    } else if (!s.queue.length && fits(s, need, window, slots)) return take();
    const entry: Entry = { need, window, slots, since: Date.now(), go: () => { signal?.removeEventListener("abort", leave); take(); } };
    const leave = () => { const i = s.queue.indexOf(entry); if (i >= 0) s.queue.splice(i, 1); next(shares, key, s); reject(signal!.reason ?? new Error("aborted")); };
    if (signal?.aborted) return leave();
    signal?.addEventListener("abort", leave, { once: true });
    s.queue.push(entry);
  });
}

/** Requests running and waiting on `key`, for tests. */
export function modelShare(scope: object, key: string): { running: number; waiting: number; used: number; kept: number } {
  const s = scopes.get(scope)?.get(key);
  return { running: s?.running ?? 0, waiting: s?.queue.length ?? 0, used: s?.used ?? 0, kept: s?.kept.size ?? 0 };
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
