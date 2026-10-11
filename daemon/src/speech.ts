// Dictation and Read aloud: the routes' work. Audio and text are held in
// memory only and passed straight through; nothing is written or logged.

import type { ServerResponse } from "node:http";
import { MAX_CLIP_BYTES, pcmSeconds, renderThreadMentions, SPEECH_CONTENT_TYPE, type CallContext, type Models, type OwnerView, type Pool, type Resolution } from "@lyrica/core";
import type * as Api from "./api.ts";
import { HttpError, SECURITY_HEADERS } from "./http.ts";

/** One speech request's longest piece of text: long sentences are cut at a comma or a space. */
const PIECE = 400;

/** Which of the two languages a piece of text is in: Mandarin if it has Han characters. */
export const languageOf = (text: string): "zh" | "en" => (/[㐀-鿿豈-﫿]/.test(text) ? "zh" : "en");

/**
 * Her message as it reads aloud: code blocks, tables, images, links' URLs,
 * HTML and markdown marks dropped, and each paragraph on its own line. A code
 * block still open (a message being written) drops everything after it.
 */
export function speakable(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = undefined; continue; }
    if (f) { fence = f[1]; continue; }
    if (/^\s*\|/.test(line) || /^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) continue; // tables
    if (/^\s{4,}\S/.test(line) && !out.at(-1)) continue; // an indented code block
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(""); continue; } // a rule
    const text = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links: their words
      .replace(/<(https?:[^>]*)>/g, "") // autolinks
      .replace(/https?:\/\/\S+/g, "") // bare URLs
      .replace(/<[^>]+>/g, "") // HTML
      .replace(/^\s{0,3}#{1,6}\s+/, "") // headings
      .replace(/^\s*>\s?/, "") // quotes
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "") // list marks and task boxes
      .replace(/`([^`]*)`/g, "$1") // inline code: its words
      .replace(/(\*\*|__|~~|\*|_)(?=\S)([^\n]*?\S)\1/g, "$2") // emphasis
      .replace(/\s+/g, " ")
      .trim();
    out.push(text);
  }
  return out.join("\n").replace(/\n{2,}/g, "\n").trim();
}

/**
 * Splits speakable text into sentences, in English and Mandarin. A sentence
 * longer than PIECE is cut at a comma, else a space. `complete` is false
 * when the text may still grow: the last piece then waits for more.
 */
export function sentences(text: string, complete = true): string[] {
  const out: string[] = [];
  const re = /[^\n]*?(?:[.!?…]+["'”’)\]]*(?=\s|$)|[。！？；]+["'”’）」』]*|\n|$)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(text)) && m[0].length) {
    const s = m[0].trim();
    last = re.lastIndex;
    if (s) out.push(s);
  }
  if (last < text.length && text.slice(last).trim()) out.push(text.slice(last).trim());
  // While the text grows, its last piece may be half a sentence.
  if (!complete && out.length && !/[.!?…。！？；]["'”’)\]）」』]*$/.test(out.at(-1)!) && !text.endsWith("\n")) out.pop();
  return out.flatMap(cut);
}

function cut(s: string): string[] {
  const pieces: string[] = [];
  while (s.length > PIECE) {
    const head = s.slice(0, PIECE);
    const at = Math.max(head.lastIndexOf(", "), head.lastIndexOf("，"), head.lastIndexOf("、"));
    const end = at > PIECE / 3 ? at + 1 : head.lastIndexOf(" ") > PIECE / 3 ? head.lastIndexOf(" ") : PIECE;
    pieces.push(s.slice(0, end).trim());
    s = s.slice(end).trim();
  }
  if (s) pieces.push(s);
  return pieces;
}

/** Her stored message's text, as it reads aloud: a thread she mentions reads as its current title. */
export function messageText(parts: Api.MessagePart[], titleOf: TitleOf = () => undefined): string {
  const text = parts.filter((p): p is Extract<Api.MessagePart, { type: "text" }> => p.type === "text").map((p) => p.text).join("\n\n");
  return speakable(renderThreadMentions(text, titleOf));
}

/** A thread's current title, in the message's pool or the pool named in the mention. */
export type TitleOf = (threadId: string, pool?: Pool) => string | undefined;

/** Thread titles for mentions in a message of `pool`: a general message never names a private thread. */
export function titlesIn(o: OwnerView, pool: Pool): TitleOf {
  return (id, mentioned) => {
    const p = mentioned ?? pool;
    if (pool === "general" && p !== "general") return undefined;
    const thread = o[p].getThread(id);
    return thread && (thread.title ?? "an untitled thread");
  };
}

/** Where Read aloud gets its text: a stored message, or one still being written. */
export interface SpeechSource {
  /** The text so far, already made speakable. */
  text(): string;
  done(): boolean;
  /** Resolves when there is more text, or the message is done, or `signal` stops. */
  more(signal: AbortSignal): Promise<void>;
}

export const storedSource = (text: string): SpeechSource => ({ text: () => text, done: () => true, more: async () => {} });

/**
 * Streams a message read aloud to `res`: one sentence at a time, the next
 * one asked for while this one plays. The first sentence's refusal is thrown
 * before any header, so it answers as JSON; after that, a failure ends the
 * stream. `allowed` is checked between sentences and every few seconds, so
 * Logout and Lock stop it. One call record for the whole reading.
 */
export async function readAloud(o: {
  models: Models; ctx: CallContext; pool: Pool; threadId: string; source: SpeechSource; res: ServerResponse; allowed: () => boolean;
}): Promise<void> {
  const { models, ctx, source, res } = o;
  const stop = new AbortController();
  const closed = () => stop.abort();
  res.on("close", closed);
  const check = setInterval(() => { if (!o.allowed()) stop.abort(); }, 2_500);
  let first: Resolution | undefined;
  let bytes = 0;
  type Spoken = Awaited<ReturnType<Models["speak"]>>;
  const ask = (text: string): Promise<Spoken> => {
    const p = models.speak(ctx, text, { language: languageOf(text), signal: stop.signal });
    p.catch(() => {}); // a sentence asked ahead whose reading was stopped
    return p;
  };
  let ahead: Promise<Spoken> | undefined;
  try {
    let done = 0;
    for (;;) {
      // Wait until there is a whole sentence, or the message is done.
      let list = sentences(source.text(), source.done());
      while (list.length <= done && !source.done() && !stop.signal.aborted) {
        await source.more(stop.signal);
        list = sentences(source.text(), source.done());
      }
      if (stop.signal.aborted || !o.allowed()) break;
      if (list.length <= done) {
        if (!first) throw new HttpError(400, "there is nothing in this message to read aloud");
        break;
      }
      const spoken = await (ahead ?? ask(list[done]!));
      ahead = undefined;
      done++;
      if (!first) {
        first = spoken.resolution;
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": SPEECH_CONTENT_TYPE, "cache-control": "no-store" });
      }
      // One ahead: the next sentence is asked for while this one streams.
      const next = sentences(source.text(), source.done());
      if (next.length > done) ahead = ask(next[done]!);
      const reader = spoken.audio.getReader();
      const cancel = () => void reader.cancel().catch(() => {});
      stop.signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end || stop.signal.aborted) break;
          bytes += value.length;
          if (!res.write(value)) await new Promise<void>((resolve) => { res.once("drain", resolve); stop.signal.addEventListener("abort", () => resolve(), { once: true }); });
        }
      } finally {
        stop.signal.removeEventListener("abort", cancel);
        cancel();
      }
    }
  } catch (err) {
    if (!first) throw err; // nothing sent yet: a JSON refusal
  } finally {
    clearInterval(check);
    res.off("close", closed);
    stop.abort();
    void ahead?.then((s) => s.audio.cancel().catch(() => {}), () => {});
    if (first) {
      models.recordCall(ctx.userId, { pool: o.pool, threadId: o.threadId, task: "speech.speak", resolution: first, audioSeconds: pcmSeconds(bytes) });
      if (!res.writableEnded) res.end();
    }
  }
}

/** A clip's bytes from the request, refused if it is too long or not WAV. */
export async function readClip(r: { req: { headers: Record<string, string | string[] | undefined> }; bytes(limit: number): Promise<Buffer> }): Promise<Buffer> {
  const type = String(r.req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type && type !== "audio/wav" && type !== "audio/x-wav" && type !== "audio/wave") throw new HttpError(415, "a clip is sent as audio/wav");
  const clip = await r.bytes(MAX_CLIP_BYTES);
  if (!clip.length) throw new HttpError(400, "the clip is empty");
  return clip;
}

/** A transcription, recorded: the model and the seconds, never the audio or the text. */
export async function transcribeClip(models: Models, ctx: CallContext, pool: Pool, threadId: string, clip: Buffer, language: string | null, signal: AbortSignal): Promise<Api.Transcription> {
  const out = await models.transcribe(ctx, clip, { ...(language ? { language } : {}), signal });
  models.recordCall(ctx.userId, { pool, threadId, task: "speech.transcribe", resolution: out.resolution, ...(out.audioSeconds !== undefined ? { audioSeconds: out.audioSeconds } : {}) });
  return { text: out.text, seconds: Math.round((out.audioSeconds ?? 0) * 10) / 10, model: out.resolution.label };
}

/** Whether Dictation and Read aloud can be used in a context now, for the mic's and Read aloud's state. */
export function speechState(models: Models, ctx: CallContext): Api.Speech {
  const state = (task: "speech.transcribe" | "speech.speak"): Api.SpeechState => {
    const m = models.speechModel(task, ctx);
    return "problem" in m ? { available: false, reason: m.reason, problem: m.problem } : { available: true, label: m.label, kind: m.kind };
  };
  return { transcribe: state("speech.transcribe"), speak: state("speech.speak"), voiceCloud: !!ctx.voiceCloud, readAloudLive: models.defaultReadAloudLive(ctx.userId) };
}
