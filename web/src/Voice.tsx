// Dictation and Read aloud in the browser (DESIGN.md "Voice"). The mic records
// 16 kHz mono PCM through an AudioWorklet and sends the clip as WAV to
// lyricad, which transcribes it; Read aloud plays the raw PCM lyricad streams
// for one of her messages. The browser's own speech features are never used,
// and nothing is kept in browser storage: audio lives in memory until it is
// sent or played, then goes.
import { useCallback, useEffect, useRef, useState } from "react";
import { errorFrom, type Speech, type Transcription } from "./api.ts";
import { Icon } from "./Modes.tsx";

const RATE = 16_000;
/** A clip is at most 10 minutes; recording stops there. */
const MAX_SECONDS = 600;
const SPEECH_RATE = 24_000;

export type MicState = "idle" | "recording" | "transcribing";

/** "Allow the microphone in your browser", and the like, as a sentence for the error line. */
function micProblem(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Allow the microphone in your browser.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found.";
  return "The microphone couldn't be started.";
}

/**
 * Dictation: `start` records until `stop`, which transcribes the clip and
 * hands the text to `onText`; `discard` throws the clip away. Problems go to
 * `onError` as plain sentences. Starting stops anything being read aloud.
 */
export function useDictation({ base, onText, onError }: {
  base: string; onText: (text: string) => void; onError: (message: string) => void;
}) {
  const [state, setState] = useState<MicState>("idle");
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<{ stream: MediaStream; ctx: AudioContext; chunks: Float32Array[]; timer: ReturnType<typeof setInterval>; startedAt: number }>(undefined);
  const transcribing = useRef<AbortController>(undefined);

  const teardown = useCallback(() => {
    const r = rec.current;
    rec.current = undefined;
    if (!r) return [] as Float32Array[];
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx.close().catch(() => {});
    return r.chunks;
  }, []);

  const discard = useCallback(() => {
    teardown();
    transcribing.current?.abort();
    transcribing.current = undefined;
    setState("idle");
    setSeconds(0);
  }, [teardown]);

  const stop = useCallback(async () => {
    const r = rec.current;
    if (!r) return;
    const rate = r.ctx.sampleRate;
    const chunks = teardown();
    const samples = join(chunks, rate);
    // A press and release with nothing said isn't a clip.
    if (samples.length < RATE / 4) { setState("idle"); setSeconds(0); return; }
    setState("transcribing");
    const abort = new AbortController();
    transcribing.current = abort;
    try {
      const res = await fetch(`${base}/transcribe`, { method: "POST", credentials: "same-origin", body: new Blob([wav(samples)], { type: "audio/wav" }), signal: abort.signal });
      if (!res.ok) throw await errorFrom(res);
      const out = (await res.json()) as Transcription;
      if (!abort.signal.aborted) {
        const text = out.text.trim();
        if (text) onText(text);
      }
    } catch (e) {
      if (!abort.signal.aborted) onError((e as Error).message);
    } finally {
      if (transcribing.current === abort) {
        transcribing.current = undefined;
        setState("idle");
        setSeconds(0);
      }
    }
  }, [base, teardown, onText, onError]);

  const start = useCallback(async () => {
    if (rec.current || transcribing.current) return;
    stopReading();
    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("no microphone");
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      onError(micProblem(e));
      return;
    }
    let ctx: AudioContext;
    try {
      try { ctx = new AudioContext({ sampleRate: RATE }); } catch { ctx = new AudioContext(); }
      await ctx.audioWorklet.addModule("/dictation-worklet.js");
      const node = new AudioWorkletNode(ctx, "dictation", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const chunks: Float32Array[] = [];
      node.port.onmessage = (e: MessageEvent<Float32Array>) => { if (rec.current?.chunks === chunks) chunks.push(e.data); };
      ctx.createMediaStreamSource(stream).connect(node);
      // The node's output is silence; it is connected so the graph runs.
      node.connect(ctx.destination);
      await ctx.resume();
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        setSeconds(s);
        if (s >= MAX_SECONDS) void stop();
      }, 250);
      rec.current = { stream, ctx, chunks, timer, startedAt };
      setSeconds(0);
      setState("recording");
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      onError("The microphone couldn't be started.");
    }
  }, [onError, stop]);

  // Leaving the page throws the clip away.
  useEffect(() => discard, [discard]);

  return { state, seconds, start, stop, discard };
}

/** One array of 16 kHz samples from the recorder's blocks, resampled if the context ran at another rate. */
function join(chunks: Float32Array[], rate: number): Float32Array {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  if (rate === RATE) return all;
  const out = new Float32Array(Math.floor(n * RATE / rate));
  const step = rate / RATE;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const a = all[j] ?? 0;
    const b = all[j + 1] ?? a;
    out[i] = a + (b - a) * (x - j);
  }
  return out;
}

/** A 16 kHz mono 16-bit WAV. */
function wav(samples: Float32Array): ArrayBuffer {
  const data = samples.length * 2;
  const b = new ArrayBuffer(44 + data);
  const v = new DataView(b);
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + data, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff, true);
  return b;
}

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The mic in the message box's row: accent and pulsing while recording, muted and pulsing while transcribing. */
export function MicButton({ state, seconds, speech, onStart, onStop }: {
  state: MicState; seconds: number; speech?: Speech; onStart: () => void; onStop: () => void;
}) {
  const off = speech && !speech.transcribe.available ? speech.transcribe : undefined;
  const label = state === "recording" ? "Stop and transcribe" : state === "transcribing" ? "Transcribing" : "Dictate";
  return (
    <span className="mic" data-state={state}>
      <button type="button" className="icon" aria-label={label} aria-pressed={state === "recording"}
        title={off ? off.problem : label} disabled={!!off || state === "transcribing"}
        onClick={state === "recording" ? onStop : onStart}>
        <Icon name="mic" />
      </button>
      {state === "recording" && <span className="elapsed" aria-live="off">{clock(seconds)}</span>}
    </span>
  );
}

// --- Read aloud: one thing plays at a time, across the page ---

let playing: { url: string; stop: () => void } | undefined;
const watchers = new Set<() => void>();
const notify = () => watchers.forEach((w) => w());

/** Stops whatever is being read aloud: pressed Stop reading, the mic, sending, another Read aloud, or leaving the thread. */
export function stopReading() {
  const p = playing;
  playing = undefined;
  p?.stop();
  if (p) notify();
}

/** The URL being read aloud now, if any; the component re-renders when it changes. */
export function useReading(): string | undefined {
  const [, tick] = useState(0);
  useEffect(() => {
    const w = () => tick((n) => n + 1);
    watchers.add(w);
    return () => { watchers.delete(w); };
  }, []);
  return playing?.url;
}

/**
 * Reads her message at `url` aloud, playing lyricad's PCM as it arrives. The
 * AudioContext is made in the press itself, which iPhone requires. A refusal
 * before any audio goes to `onError` as a sentence; the reading ends on
 * Stop reading or when the stream ends.
 */
export function readAloud(url: string, onError: (message: string) => void) {
  stopReading();
  let ctx: AudioContext;
  try { ctx = new AudioContext({ sampleRate: SPEECH_RATE }); } catch { ctx = new AudioContext(); }
  const abort = new AbortController();
  let sources: AudioBufferSourceNode[] = [];
  const me = {
    url,
    stop: () => {
      abort.abort();
      sources.forEach((s) => { try { s.stop(); } catch { /* already ended */ } });
      sources = [];
      void ctx.close().catch(() => {});
    },
  };
  playing = me;
  notify();
  const done = () => { if (playing === me) { playing = undefined; me.stop(); notify(); } };
  void (async () => {
    try {
      await ctx.resume();
      const res = await fetch(url, { credentials: "same-origin", signal: abort.signal });
      if (!res.ok) throw await errorFrom(res);
      if (!res.body) throw new Error("Nothing came back to play.");
      const reader = res.body.getReader();
      let next = ctx.currentTime + 0.05;
      let rest = new Uint8Array(0);
      const play = (bytes: Uint8Array) => {
        const n = Math.floor(bytes.length / 2);
        if (!n) return;
        const buffer = ctx.createBuffer(1, Math.ceil(n * ctx.sampleRate / SPEECH_RATE), ctx.sampleRate);
        const out = buffer.getChannelData(0);
        const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
        const step = SPEECH_RATE / ctx.sampleRate;
        for (let i = 0; i < out.length; i++) {
          const j = Math.min(n - 1, Math.floor(i * step));
          out[i] = view.getInt16(j * 2, true) / 0x8000;
        }
        const s = ctx.createBufferSource();
        s.buffer = buffer;
        s.connect(ctx.destination);
        next = Math.max(next, ctx.currentTime);
        s.start(next);
        next += buffer.duration;
        s.onended = () => { sources = sources.filter((x) => x !== s); };
        sources.push(s);
      };
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end || abort.signal.aborted) break;
        const all = new Uint8Array(rest.length + value.length);
        all.set(rest); all.set(value, rest.length);
        // Whole tenths of a second, so each piece is scheduled a little ahead.
        const cut = Math.floor(all.length / 4800) * 4800;
        play(all.subarray(0, cut));
        rest = all.slice(cut);
      }
      if (!abort.signal.aborted) {
        play(rest);
        // The last piece plays out before Read aloud comes back.
        const left = Math.max(0, next - ctx.currentTime);
        await new Promise((r) => setTimeout(r, left * 1000 + 50));
      }
    } catch (e) {
      if (!abort.signal.aborted) onError((e as Error).message);
    } finally {
      done();
    }
  })();
}

/** In her message's actions: Read aloud, which is Stop reading while this message plays. */
export function ReadAloudButton({ url, speech, onError }: { url: string; speech?: Speech; onError: (message: string) => void }) {
  const reading = useReading() === url;
  const off = speech && !speech.speak.available ? speech.speak : undefined;
  const label = reading ? "Stop reading" : "Read aloud";
  return (
    <button type="button" className="icon-btn read-aloud" data-reading={reading} aria-label={label} aria-pressed={reading}
      title={off ? off.problem : label} disabled={!!off && !reading}
      onClick={() => (reading ? stopReading() : readAloud(url, onError))}>
      <Icon name={reading ? "stop" : "speaker"} />
    </button>
  );
}
