// Speech: the HTTP of a transcription and of one sentence spoken, in
// OpenAI's shapes (`/v1/audio/transcriptions` and `/v1/audio/speech`). Audio
// stays in memory: nothing here writes a file or logs audio or text.

import { hostError, HostRefused } from "./host.ts";

/** Voice to cloud is off, and the model that would hear the audio is a cloud model. Nothing was sent. */
export class VoiceCloudOff extends Error {}
/** The audio Read aloud streams: raw PCM, signed 16-bit little-endian, mono, at 24 kHz. */
export const SPEECH_FORMAT = { encoding: "s16le", sampleRate: 24_000, channels: 1 } as const;
export const SPEECH_CONTENT_TYPE = "audio/pcm;rate=24000;encoding=s16le;channels=1";
/** The longest clip Dictation takes: ten minutes of 16 kHz mono 16-bit WAV, with room for its header. */
export const MAX_CLIP_SECONDS = 600;
export const MAX_CLIP_BYTES = MAX_CLIP_SECONDS * 16_000 * 2 + 1024;
/** The longest text one speech request takes (OpenAI's limit). */
export const MAX_SPEAK_CHARS = 4096;

const auth = (apiKey?: string): Record<string, string> => (apiKey ? { authorization: `Bearer ${apiKey}` } : {});

/**
 * A failed answer as an error: a host's own (its away codes fall back, see
 * `isUnreachable`), 5xx and 429 from any other endpoint as away too, and
 * anything else as the reason, plainly.
 */
async function failure(res: Response, what: string): Promise<Error> {
  const host = await hostError(res);
  if (host) return new HostRefused(host.code, host.message);
  if (res.status >= 500 || res.status === 429) return new HostRefused("unavailable", `${what} answered ${res.status}`);
  let message = "";
  try {
    const body = (await res.json()) as { error?: { message?: unknown } | string };
    message = typeof body.error === "string" ? body.error : String(body.error?.message ?? "");
  } catch { /* no JSON */ }
  return new Error(`${what} refused the request (${res.status}${message ? `: ${message.slice(0, 200)}` : ""})`);
}


/** A multipart/form-data body, built in memory so it can be sent again at a host's next address. */
function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Uint8Array }): { body: Uint8Array<ArrayBuffer>; type: string } {
  const boundary = `lyrica-${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(enc.encode(`--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(enc.encode(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${file.name}"\r\ncontent-type: ${file.type}\r\n\r\n`));
  parts.push(file.data, enc.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.length; }
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

export interface SpeechTarget {
  fetch: typeof fetch;
  /** The endpoint's base URL, ending in /v1. */
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  /** For messages: the endpoint's name. */
  name: string;
}

/** Sends a WAV clip for transcription; the text comes back. */
export async function transcribeAt(t: SpeechTarget, wav: Uint8Array, opts: { language?: string; signal?: AbortSignal } = {}): Promise<string> {
  const form = multipart({ model: t.modelId, response_format: "json", ...(opts.language ? { language: opts.language } : {}) }, { name: "clip.wav", type: "audio/wav", data: wav });
  const res = await t.fetch(`${t.baseUrl}/audio/transcriptions`, {
    method: "POST", headers: { ...auth(t.apiKey), "content-type": form.type }, body: form.body,
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await failure(res, t.name);
  const body = (await res.json().catch(() => undefined)) as { text?: unknown } | undefined;
  if (typeof body?.text !== "string") throw new Error(`${t.name} didn't send a transcription back`);
  return body.text.trim();
}

/**
 * Asks for one piece of text spoken, as raw PCM (SPEECH_FORMAT). Resolves
 * once the audio starts; the stream ends with the audio, and cancelling it
 * cancels the request.
 */
export async function speakAt(t: SpeechTarget, text: string, opts: { voice?: string; speed?: number; signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
  const stop = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
  // Until the first bytes arrive: a host that hangs counts as away.
  const first = setTimeout(() => stop.abort(new DOMException("no audio in time", "TimeoutError")), 30_000);
  let res: Response;
  try {
    res = await t.fetch(`${t.baseUrl}/audio/speech`, {
      method: "POST", headers: { ...auth(t.apiKey), "content-type": "application/json" }, signal,
      body: JSON.stringify({ model: t.modelId, input: text, ...(opts.voice ? { voice: opts.voice } : {}), ...(opts.speed !== undefined ? { speed: opts.speed } : {}), response_format: "pcm" }),
    });
  } catch (e) {
    // No audio in time: a machine that stopped answering, so the next model tries.
    throw stop.signal.aborted && !opts.signal?.aborted ? Object.assign(new Error(`${t.name} didn't answer in time`), { name: "TimeoutError" }) : e;
  } finally {
    clearTimeout(first);
  }
  if (!res.ok || !res.body) throw await failure(res, t.name);
  const reader = res.body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) c.close(); else c.enqueue(value);
      } catch (e) {
        c.error(e);
      }
    },
    cancel() {
      stop.abort();
      return reader.cancel().catch(() => {});
    },
  });
}

/** Seconds of audio in a WAV clip, from its header; undefined if it isn't one this reads. */
export function wavSeconds(wav: Uint8Array): number | undefined {
  const at = wavData(wav);
  if (!at) return undefined;
  return at.bytes / (at.rate * at.channels * (at.bits / 8));
}

/** Where a WAV clip's samples are, and their format; undefined for anything that isn't PCM WAV. */
export function wavData(wav: Uint8Array): { rate: number; channels: number; bits: number; bytes: number } | undefined {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
  if (wav.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  let fmt: { rate: number; channels: number; bits: number } | undefined;
  for (let o = 12; o + 8 <= wav.length;) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt " && size >= 16) {
      if (v.getUint16(o + 8, true) !== 1) return undefined; // PCM only
      fmt = { channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    }
    if (id === "data") {
      if (!fmt || !fmt.rate || !fmt.channels || !fmt.bits) return undefined;
      return { ...fmt, bytes: Math.min(size, wav.length - o - 8) };
    }
    o += 8 + size + (size % 2);
  }
  return undefined;
}

/** Seconds of SPEECH_FORMAT audio in a number of bytes. */
export const pcmSeconds = (bytes: number): number => bytes / (SPEECH_FORMAT.sampleRate * 2 * SPEECH_FORMAT.channels);
