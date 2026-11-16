import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai";

// Tone notes (docs/briefs/voice-tone.md): when the Read aloud model takes a
// tone, she opens a paragraph whose feeling changes with <tone>…</tone>. The
// tag is lifted out of her reply as it streams, so no text, live or stored,
// ever holds one; the notes are kept apart for Read aloud alone (principles 1 and 6).

const OPEN = "<tone>", CLOSE = "</tone>";
/** A note's longest text; anything longer between the marks isn't a note, and stays as she wrote it. */
export const MAX_TONE = 80;
/** The most notes kept for one reply. */
export const MAX_TONES = 64;

/** A tone note: `at` is where its paragraph starts in the reply's text blocks, joined with nothing between them. */
export interface ToneNote { at: number; note: string }

/** Her system prompt's line when the Read aloud model takes a tone. */
export const TONE_GUIDE = `Your replies may be read aloud in a voice that follows a tone. When a paragraph's feeling differs from the one before, open it with a tone note of at most eight English words, such as ${OPEN}gently amused${CLOSE} or ${OPEN}quiet and tender${CLOSE}. Notes are taken out before anyone sees the reply, so never mention them. With no note the voice stays calm.`;

const prefixAtEnd = (text: string, tag: string): number => {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) if (text.endsWith(tag.slice(0, n))) return n;
  return 0;
};

/**
 * Lifts tone tags out of one text block as it arrives, with a scan that reads
 * each character a bounded number of times (no regex over her output).
 * `push` returns the text to show; `finish` returns the rest, dropping a tag
 * left half-written.
 */
export class ToneScanner {
  private pending = "";
  private inTag = false;
  private tag = "";
  /** After a tag: the spaces that followed it are dropped, and its line's end if it had a line to itself. */
  private trim = false;
  private trimLine = false;
  /** The last character shown, "\n" at the start: whether a tag opens a line. */
  private last = "\n";
  constructor(private readonly found: (offset: number, note: string) => void, private emitted = 0) {}

  push(delta: string): string {
    let text = this.pending + delta;
    this.pending = "";
    let out = "";
    let i = 0;
    // Where the open tag's note starts in `text`, or -1 when it opened in an earlier piece (its start is in `tag`).
    let from = -1;
    const LIMIT = MAX_TONE + CLOSE.length;
    while (i < text.length) {
      if (this.inTag) {
        // Only a note's length is looked through for its end, so each character is read a bounded number of times.
        const scan = this.tag + text.slice(i, i + LIMIT - this.tag.length);
        const end = scan.indexOf(CLOSE);
        if (end >= 0) {
          i += end + CLOSE.length - this.tag.length;
          const note = scan.slice(0, end).replace(/\s+/g, " ").trim();
          this.inTag = false;
          this.tag = "";
          if (note) this.found(this.emitted + out.length, note);
          this.trim = true;
          this.trimLine = (out.at(-1) ?? this.last) === "\n";
        } else if (scan.length >= LIMIT) {
          // Not a note: what she wrote stays, read again from after the mark.
          out += this.clean(OPEN);
          if (from < 0) { text = this.tag + text.slice(i); i = 0; } else i = from;
          this.inTag = false;
          this.tag = "";
          from = -1;
        } else {
          this.tag = scan;
          i = text.length;
        }
        continue;
      }
      const start = text.indexOf(OPEN, i);
      if (start >= 0) {
        out += this.clean(text.slice(i, start));
        i = from = start + OPEN.length;
        this.inTag = true;
        continue;
      }
      const keep = Math.min(prefixAtEnd(text, OPEN), text.length - i);
      out += this.clean(text.slice(i, text.length - keep));
      this.pending = text.slice(text.length - keep);
      i = text.length;
    }
    this.emitted += out.length;
    if (out) this.last = out.at(-1)!;
    return out;
  }

  /** The end of the block: a held "<to" that never became a tag is text; a tag never closed is dropped. */
  finish(): string {
    const out = this.inTag ? "" : this.clean(this.pending);
    this.pending = "";
    this.inTag = false;
    this.tag = "";
    this.emitted += out.length;
    return out;
  }

  get offset(): number { return this.emitted; }

  private clean(text: string): string {
    if (!this.trim) return text;
    let i = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (c === " " || c === "\t") i++;
      else if (c === "\n" && this.trimLine) { this.trimLine = false; i++; }
      else break;
    }
    if (i < text.length) this.trim = false;
    return text.slice(i);
  }
}

/**
 * The stream with tone tags lifted out of its text blocks, in every event
 * and in the final message. Each note is added to `notes` as it is found,
 * so a reply read aloud while it is written has them too; `done` is given
 * the final message, the object Pi stores.
 */
export function liftTones(source: AssistantMessageEventStream, notes: ToneNote[], done?: (message: AssistantMessage) => void): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    const texts = new Map<number, string>();
    const scanners = new Map<number, ToneScanner>();
    let emitted = 0;
    const found = (at: number, note: string) => { if (notes.length < MAX_TONES) notes.push({ at, note }); };
    const scanner = (i: number) => {
      let s = scanners.get(i);
      if (!s) { s = new ToneScanner(found, emitted); scanners.set(i, s); texts.set(i, ""); }
      return s;
    };
    const view = (m: AssistantMessage): AssistantMessage => ({ ...m, content: m.content.map((b, i) => (b.type === "text" && texts.has(i) ? { ...b, text: texts.get(i)! } : b)) });
    const add = (i: number, text: string) => { texts.set(i, texts.get(i)! + text); emitted += text.length; };
    try {
      for await (const event of source) {
        if (event.type === "text_start") {
          scanner(event.contentIndex);
          out.push({ ...event, partial: view(event.partial) });
        } else if (event.type === "text_delta") {
          const s = scanner(event.contentIndex);
          const delta = s.push(event.delta);
          add(event.contentIndex, delta);
          if (delta) out.push({ ...event, delta, partial: view(event.partial) });
        } else if (event.type === "text_end") {
          const s = scanner(event.contentIndex);
          const rest = s.finish();
          add(event.contentIndex, rest);
          const partial = view(event.partial);
          if (rest) out.push({ type: "text_delta", contentIndex: event.contentIndex, delta: rest, partial });
          out.push({ ...event, content: texts.get(event.contentIndex)!, partial });
        } else if (event.type === "done") {
          for (const [i, s] of scanners) add(i, s.finish());
          const message = view(event.message);
          done?.(message);
          out.push({ ...event, message });
        } else if (event.type === "error") {
          for (const [i, s] of scanners) add(i, s.finish());
          const message = view(event.error);
          done?.(message);
          out.push({ ...event, error: message });
        } else out.push({ ...event, partial: view(event.partial) } as typeof event);
      }
    } finally {
      out.end();
    }
  })();
  return out;
}

type StreamFn = (...args: never[]) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** Each finished reply's notes, in memory, by the message object Pi stores, until `record.ts` stores them apart. */
const FINISHED = new WeakMap<object, ToneNote[]>();

/** A finished reply's notes, by the message object Pi stores. */
export function tonesOf(message: unknown): ToneNote[] | undefined {
  return message && typeof message === "object" ? FINISHED.get(message) : undefined;
}

/**
 * One session's tone notes: the reply being written's, as found. While
 * `on()` is false, replies stream as the model wrote them.
 */
export class Tones {
  /** The notes of the reply being written now. */
  live: ToneNote[] = [];
  constructor(readonly on: () => boolean) {}

  /** Pi's stream function, with tags lifted out of every reply while `on()`. */
  wrap<F extends StreamFn>(stream: F): F {
    return (async (...args: Parameters<F>) => {
      const source = await stream(...args);
      if (!this.on()) { this.live = []; return source; }
      const notes: ToneNote[] = [];
      this.live = notes;
      return liftTones(source, notes, (message) => { if (notes.length) FINISHED.set(message, notes); });
    }) as F;
  }
}
