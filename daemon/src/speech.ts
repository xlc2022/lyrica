// Dictation and Read aloud: the routes' work. Audio and text are held in
// memory only and passed straight through; nothing is written or logged.

import type { ServerResponse } from "node:http";
import { MAX_CLIP_BYTES, pcmSeconds, renderThreadMentions, SPEECH_CONTENT_TYPE, type CallContext, type Models, type OwnerView, type Pool, type Resolution } from "@lyrica/core";
import type * as Api from "./api.ts";
import { HttpError, SECURITY_HEADERS } from "./http.ts";

/** One speech request's longest piece of text: long sentences are cut at a comma or a space. */
const PIECE = 400;
/** The longest piece of several sentences, in characters: about 100 to 300 of Kokoro's tokens. */
const GROUP_EN = 300;
const GROUP_ZH = 100;

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
    if (/^\s*\|/.test(line) || /^\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*(?:\|\s*)?$/.test(line)) continue; // tables
    if (/^\s{4,}\S/.test(line) && !out.at(-1)) continue; // an indented code block
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(""); continue; } // a rule
    const text = line
      // No class below runs past the bracket that opens another, so an unclosed "[[[…" or "<<<…" is read once.
      .replace(/!\[[^[\]]*\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "") // images
      .replace(/\[([^[\]]*)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "$1") // links: their words
      .replace(/<(https?:[^<>]*)>/g, "") // autolinks
      .replace(/https?:\/\/\S+/g, "") // bare URLs
      .replace(/<[^<>]+>/g, "") // HTML
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
  return paragraphSentences(text, complete).map((s) => s.text);
}

/** A sentence and the paragraph it is in, counted from 0. */
export interface Sentence { text: string; paragraph: number }

/** `sentences`, each with its paragraph: a line of speakable text is a paragraph. */
export function paragraphSentences(text: string, complete = true): Sentence[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => splitSentences(line, complete || i < lines.length - 1).map((s) => ({ text: s, paragraph: i })));
}

/**
 * How many of `list`'s sentences, from `from`, are read in one request.
 * The first sentence goes alone, so the voice starts soon. After it, the
 * sentences of one paragraph in one language go together up to a length:
 * Kokoro's voices sound best at 100 to 200 tokens and flat on a short line
 * (its VOICES.md), and each request starts its intonation afresh.
 */
export function piece(list: readonly Sentence[], from: number): number {
  if (from === 0) return Math.min(1, list.length);
  const head = list[from];
  if (!head) return 0;
  const lang = languageOf(head.text);
  const most = lang === "zh" ? GROUP_ZH : GROUP_EN;
  let n = 1;
  let length = head.text.length;
  for (let next = list[from + n]; next && next.paragraph === head.paragraph && languageOf(next.text) === lang && length + 1 + next.text.length <= most; next = list[from + n]) {
    length += 1 + next.text.length;
    n++;
  }
  return n;
}

/** The text of `n` sentences read as one piece: English joined with spaces, Mandarin without. */
export function pieceText(list: readonly Sentence[], from: number, n: number): string {
  const parts = list.slice(from, from + n).map((s) => s.text);
  return parts.join(languageOf(parts[0] ?? "") === "zh" ? "" : " ");
}

function splitSentences(text: string, complete: boolean): string[] {
  const out: string[] = [];
  // A run of marks is tried from its first mark only, so "!!!!…" isn't rescanned from each.
  const re = /[^\n]*?(?:(?<![.!?…])[.!?…]+["'”’)\]]*(?=\s|$)|[。！？；]+["'”’）」』]*|\n|$)/g;
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

/**
 * Her stored message's text, as it reads aloud: a thread she mentions reads
 * as its current title. Each of its tone notes (`notes`, by offset into the
 * text parts joined with nothing between) is a mark where it was written (`toneMarks`).
 */
export function messageText(parts: Api.MessagePart[], titleOf: TitleOf = () => undefined, notes: readonly ToneNote[] = []): string {
  const texts = parts.filter((p): p is Extract<Api.MessagePart, { type: "text" }> => p.type === "text").map((p) => p.text);
  return speakable(renderThreadMentions(markTones(texts, notes).join("\n\n"), titleOf));
}

/** A tone note (docs/briefs/voice-tone.md): how the paragraph starting at `at` is meant to sound. */
export interface ToneNote { at: number; note: string }

/** Tone notes travel through `speakable` as private-use marks: U+E000 plus the note's place in its list. */
const MARK = 0xe000;
const MARKS = 64;
const isMark = (code: number) => code >= MARK && code < MARK + MARKS;

/**
 * `texts` with each note's mark at the end of the line it was written in
 * (a mark at a line's start would hide a heading's or a list's mark from
 * `speakable`). A mark-like character of her own reads as a space, so marks are only Lyrica's.
 */
export function markTones(texts: readonly string[], notes: readonly ToneNote[]): string[] {
  let base = 0;
  return texts.map((raw) => {
    let text = "";
    for (let i = 0; i < raw.length; i++) text += isMark(raw.charCodeAt(i)) ? " " : raw[i];
    const marks: { at: number; i: number }[] = [];
    notes.slice(0, MARKS).forEach((n, i) => {
      let at = n.at - base;
      if (at < 0 || at >= text.length) return;
      while (at < text.length && text[at] === "\n") at++;
      const end = text.indexOf("\n", at);
      marks.push({ at: end < 0 ? text.length : end, i });
    });
    base += raw.length;
    // From the end, so earlier places stay put; marks at one place end up in the notes' order.
    for (const m of marks.sort((a, b) => b.at - a.at || b.i - a.i)) text = text.slice(0, m.at) + String.fromCharCode(MARK + m.i) + text.slice(m.at);
    return text;
  });
}

/**
 * Speakable text with its marks taken out, and each paragraph's (line's)
 * note: the last one marked in it, else the one before it.
 */
export function unmarkTones(text: string, notes: readonly ToneNote[]): { text: string; tones: (string | undefined)[] } {
  const tones: (string | undefined)[] = [];
  let tone: string | undefined;
  const lines = text.split("\n").map((line) => {
    let out = "";
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      if (isMark(code)) tone = notes[code - MARK]?.note ?? tone;
      else out += line[i];
    }
    tones.push(tone);
    return out.trim();
  });
  return { text: lines.join("\n"), tones };
}

/** What the voice is told for a paragraph with a note. */
export const toneInstruct = (note: string) => `Speak naturally, ${note}, at an even pace.`;

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
  /** The text so far, already made speakable, with its tone notes' marks (`messageText`). */
  text(): string;
  /** Its tone notes so far, which the marks count into. */
  tones(): readonly ToneNote[];
  done(): boolean;
  /** Resolves when there is more text, or the message is done, or `signal` stops. */
  more(signal: AbortSignal): Promise<void>;
}

export const storedSource = (text: string, notes: readonly ToneNote[] = []): SpeechSource => ({ text: () => text, tones: () => notes, done: () => true, more: async () => {} });

/**
 * Streams a message read aloud to `res`: the first sentence alone, then a
 * paragraph's sentences at a time (`piece`), the next piece asked for while
 * this one plays. The first sentence's refusal is thrown
 * before any header, so it answers as JSON; after that, a failure ends the
 * stream. `allowed` is checked between sentences and every few seconds, so
 * Logout and Lock stop it. Each piece is read in its paragraph's tone note,
 * if it has one. One call record for the whole reading.
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
  const ask = (text: string, tone: string | undefined): Promise<Spoken> => {
    const p = models.speak(ctx, text, { language: languageOf(text), ...(tone ? { instruct: toneInstruct(tone) } : {}), signal: stop.signal });
    p.catch(() => {}); // a piece asked ahead whose reading was stopped
    return p;
  };
  let ahead: { spoken: Promise<Spoken>; n: number } | undefined;
  try {
    let done = 0;
    const read = () => {
      const { text, tones } = unmarkTones(source.text(), source.tones());
      return { list: paragraphSentences(text, source.done()), tones };
    };
    const askAt = (r: ReturnType<typeof read>, from: number) => {
      const n = piece(r.list, from);
      return { spoken: ask(pieceText(r.list, from, n), r.tones[r.list[from]!.paragraph]), n };
    };
    for (;;) {
      // Wait until there is a whole sentence, or the message is done.
      let now = read();
      let list = now.list;
      while (list.length <= done && !source.done() && !stop.signal.aborted) {
        await source.more(stop.signal);
        now = read();
        list = now.list;
      }
      if (stop.signal.aborted || !o.allowed()) break;
      if (list.length <= done) {
        if (!first) throw new HttpError(400, "there is nothing in this message to read aloud");
        break;
      }
      const asked = ahead ?? askAt(now, done);
      ahead = undefined;
      const spoken = await asked.spoken;
      done += asked.n;
      if (!first) {
        first = spoken.resolution;
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": SPEECH_CONTENT_TYPE, "cache-control": "no-store" });
      }
      // One ahead: the next piece is asked for while this one streams.
      const next = read();
      if (next.list.length > done) ahead = askAt(next, done);
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
    void ahead?.spoken.then((s) => s.audio.cancel().catch(() => {}), () => {});
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
  return { transcribe: state("speech.transcribe"), speak: state("speech.speak"), readAloudLive: models.defaultReadAloudLive(ctx.userId) };
}
