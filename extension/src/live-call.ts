import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Offering } from "@lyrica/core";

/**
 * The model request a turn is waiting on, as counts and times only (never
 * text): what the chat shows in place of its dots until her words start.
 * `ms` is how long ago the request went out, when this was sent, so a view
 * keeps the clock going with no clock of the daemon's.
 */
export interface LiveCall {
  ms: number;
  /** The whole prompt in tokens: the server's count once it says, else the context's estimate. */
  prompt?: number;
  /** The prompt's tokens its server took from its cache, when it says. */
  cached?: number;
  /** Of the prompt's new tokens (not cached), how many are read so far, while its server says (llama.cpp). */
  read?: number;
  /** Prompt tokens read per second, while its server says. */
  readRate?: number;
  /** Tokens written so far, once the first arrived. */
  output?: number;
  /** Tokens written per second, when its server counts them. */
  outputRate?: number;
  /** The output is Lyrica's count from the characters written, not the server's. */
  counted?: true;
  /** What is being written: thinking or a tool call (text shows itself). */
  writing?: "thinking" | "tool";
}

/** How often a changing request is sent, at most. */
export const LIVE_CALL_EVERY_MS = 500;

/** Characters to a token, for output a server doesn't count. */
const CHARS_PER_TOKEN = 4;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const rate = (v: unknown): number | undefined => { const n = num(v); return n === undefined ? undefined : Math.round(n * 10) / 10; };

/**
 * The fields that make a server say more while it streams: llama.cpp's
 * prompt progress and per-token timings, vLLM's usage on every chunk. Other
 * servers get none: what they don't know is counted or left out.
 */
export function liveFields(o: Pick<Offering, "server" | "llamaServer">, params: Record<string, unknown>): Record<string, unknown> {
  if (o.server === "llama.cpp" || o.llamaServer) return { return_progress: true, timings_per_token: true };
  if (o.server === "vllm") return { stream_options: { ...(params.stream_options as object | undefined), include_usage: true, continuous_usage_stats: true } };
  return {};
}

/**
 * One thread's model request as it runs, sent at most every 500 ms while it
 * changes, and null when it ends. Reads only numbers from the server's
 * chunks; a delta's text is measured by its length and dropped.
 */
export class LiveCallMeter {
  private call: { since: number; prompt?: number; cached?: number; read?: number; readRate?: number; output?: number; outputRate?: number; chars: number; exact: boolean; writing?: "thinking" | "tool" } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sentAt = 0;
  private sentPhase = "";

  constructor(private readonly send: (c: LiveCall | null) => void, private readonly now: () => number = Date.now, private readonly every = LIVE_CALL_EVERY_MS) {}

  /** A request went out, with the context's estimate of its prompt. */
  request(prompt: number | null | undefined): void {
    this.clear();
    this.call = { since: this.now(), ...(num(prompt) ? { prompt: Math.round(prompt!) } : {}), chars: 0, exact: false };
    this.flush();
  }

  /** A server's chunk, as parsed: its prompt progress, timings and usage, where it has them. */
  chunk(data: unknown): void {
    const c = this.call;
    if (!c || !data || typeof data !== "object") return;
    const d = data as { prompt_progress?: Record<string, unknown>; timings?: Record<string, unknown>; usage?: Record<string, unknown> | null };
    let changed = false;
    const p = d.prompt_progress;
    if (p && typeof p === "object") {
      // llama.cpp: `processed` counts the cached tokens too, and `time_ms` runs from the read's start.
      const total = num(p.total), cache = num(p.cache) ?? 0, processed = num(p.processed), ms = num(p.time_ms);
      if (total !== undefined && processed !== undefined) {
        const read = Math.max(0, processed - cache);
        Object.assign(c, { prompt: total, cached: cache, read }, ms && read ? { readRate: Math.round((read / ms) * 10_000) / 10 } : {});
        changed = true;
      }
    }
    const t = d.timings;
    if (t && typeof t === "object") {
      const out = num(t.predicted_n);
      if (out) { c.output = out; c.exact = true; const r = rate(t.predicted_per_second); if (r) c.outputRate = r; changed = true; }
      const pr = rate(t.prompt_per_second), cache = num(t.cache_n), read = num(t.prompt_n);
      if (pr && c.readRate === undefined) c.readRate = pr;
      if (cache !== undefined && c.cached === undefined) c.cached = cache;
      if (read !== undefined && c.read === undefined) c.read = read;
    }
    const u = d.usage;
    if (u && typeof u === "object") {
      const prompt = num(u.prompt_tokens), out = num(u.completion_tokens);
      if (prompt) { c.prompt = prompt; changed = true; }
      // A count of 0 mid-stream is a server that counts only at the end.
      if (out) { c.output = out; c.exact = true; changed = true; }
    }
    if (changed) this.changed();
  }

  /** What the line says: the prompt's estimate, its read, or the output. A change of it is sent at once. */
  private phase(): string {
    const c = this.call;
    return !c ? "" : c.output !== undefined || c.chars ? `out:${c.writing ?? ""}` : c.read !== undefined ? "read" : "prompt";
  }

  /** Pi's delta: what kind, and how many characters. Counts output while the server doesn't. */
  delta(kind: "text" | "thinking" | "tool", chars: number): void {
    const c = this.call;
    if (!c) return;
    c.chars += chars;
    c.writing = kind === "text" ? undefined : kind;
    this.changed();
  }

  /** The request ended, answered or not. */
  end(): void {
    if (!this.call) return;
    this.clear();
    this.call = undefined;
    this.send(null);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private changed(): void {
    if (this.phase() !== this.sentPhase) { this.flush(); return; }
    // While her words stream they show themselves, and the line is hidden: nothing more until the phase changes.
    if (this.timer || this.phase() === "out:") return;
    const wait = this.sentAt + this.every - this.now();
    if (wait <= 0) { this.flush(); return; }
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, wait);
    this.timer.unref?.();
  }

  private flush(): void {
    this.clear();
    const c = this.call;
    if (!c) return;
    const now = this.now();
    this.sentAt = now;
    this.sentPhase = this.phase();
    const counted = !c.exact && c.chars > 0 ? Math.max(1, Math.round(c.chars / CHARS_PER_TOKEN)) : undefined;
    const output = c.exact ? c.output : counted;
    this.send({
      ms: Math.max(0, now - c.since),
      ...(c.prompt !== undefined ? { prompt: c.prompt } : {}),
      ...(c.cached ? { cached: c.cached } : {}),
      ...(c.read !== undefined ? { read: c.read } : {}),
      ...(c.readRate !== undefined ? { readRate: c.readRate } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(c.exact && c.outputRate !== undefined ? { outputRate: c.outputRate } : {}),
      ...(counted !== undefined ? { counted: true as const } : {}),
      ...(c.writing ? { writing: c.writing } : {}),
    });
  }
}

/** Feeds a meter from Pi's events: each request, the server's chunks, the deltas and the reply's end. */
export function registerLiveCall(pi: ExtensionAPI, meter: LiveCallMeter): void {
  pi.on("before_provider_request", (_e, ctx) => { meter.request(ctx.getContextUsage()?.tokens); return undefined; });
  pi.on("provider_stream_event", (e) => meter.chunk(e.data));
  pi.on("message_update", (e) => {
    const a = e.assistantMessageEvent;
    if (a.type === "text_delta") meter.delta("text", a.delta.length);
    else if (a.type === "thinking_delta") meter.delta("thinking", a.delta.length);
    else if (a.type === "toolcall_delta") meter.delta("tool", a.delta.length);
  });
  pi.on("message_end", (e) => { if (e.message.role === "assistant") meter.end(); });
  pi.on("agent_end", () => meter.end());
}

export function createLiveCallExtension(meter: LiveCallMeter): ExtensionFactory {
  return (pi) => registerLiveCall(pi, meter);
}
