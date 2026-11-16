// Command output (docs/workspace.md, "Command output"): every bash call's and background job's whole output, kept
// with its thread in the pool's own database, so it is encrypted with the pool and goes when the thread does. She
// reads it in pages with `jobs output`; the person scrolls it in the conversation and the Jobs dropdown. Principle 1:
// what her commands printed is part of the conversation, and nothing of it is ever written in plaintext.
import { RE2JS } from "re2js";
import type { Db } from "../db.ts";

export const OUTPUTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS command_outputs (
  thread     TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  call       TEXT,
  kind       TEXT NOT NULL,
  name       TEXT,
  place      TEXT NOT NULL,
  command    TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  state      TEXT NOT NULL,
  exit_code  INTEGER,
  reason     TEXT,
  bytes      INTEGER NOT NULL,
  dropped    INTEGER NOT NULL,
  output     BLOB NOT NULL,
  PRIMARY KEY (thread, id)
);
CREATE INDEX IF NOT EXISTS command_outputs_call ON command_outputs (thread, call);
`;

/**
 * keepBytes: the most of one command's output kept, its first `headBytes` and the rest from its end; threadBytes:
 * the most a thread keeps in all, its oldest outputs emptied past it; page: the lines `jobs output` gives by default
 * and at most, and the characters a page holds; matches: the lines a search gives at most.
 */
export const OUTPUT_LIMITS = {
  keepBytes: 16 * 1024 * 1024,
  headBytes: 1024 * 1024,
  threadBytes: 256 * 1024 * 1024,
  pageLines: 200,
  maxPageLines: 2000,
  pageChars: 60_000,
  matches: 200,
} as const;

export type OutputKind = "call" | "job";
export type OutputState = "running" | "exited" | "failed" | "timed out" | "stopped";

/** One command and what it printed. */
export interface CommandOutput {
  /** `c<n>` for a bash call, `j<n>` for a background job, counted per thread. */
  id: string;
  /** The tool call that ran it or started it. */
  call?: string;
  kind: OutputKind;
  /** A job's name, as she gave it. */
  name?: string;
  /** "sandbox" or the machine's name. */
  place: string;
  command: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  state: OutputState;
  exitCode?: number | null;
  reason?: string;
  /** Everything it printed, in bytes, and how much of that the middle cut left out. */
  bytes: number;
  dropped: number;
}

/** How the Jobs dropdown orders them. */
export type OutputSort = "newest" | "oldest" | "running" | "longest";

/** What it printed, as kept: the first part and the end, with a marker where the middle was left out. */
export const cutMarker = (dropped: number): string => `\n[… ${dropped.toLocaleString("en-US")} bytes left out here …]\n`;

/**
 * A command's output as it arrives, kept within OUTPUT_LIMITS.keepBytes: its first `headBytes` as they came, then a
 * window of its latest bytes. `text()` joins them with the cut marker when anything fell out between.
 */
export class KeptOutput {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  bytes = 0;
  dropped = 0;

  constructor(private readonly keep = OUTPUT_LIMITS.keepBytes, private readonly headMax = OUTPUT_LIMITS.headBytes) {}

  push(data: Buffer): void {
    this.bytes += data.length;
    let d = data;
    if (this.headLen < this.headMax) {
      const take = d.subarray(0, this.headMax - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      d = d.subarray(take.length);
      if (!d.length) return;
    }
    this.tail.push(d);
    this.tailLen += d.length;
    const room = this.keep - this.headMax;
    while (this.tailLen > room) {
      const first = this.tail[0]!;
      const over = this.tailLen - room;
      if (first.length <= over) { this.tail.shift(); this.tailLen -= first.length; this.dropped += first.length; }
      else { this.tail[0] = first.subarray(over); this.tailLen -= over; this.dropped += over; }
    }
  }

  /** Everything kept, as bytes. */
  buffer(): Buffer {
    const parts = [...this.head];
    if (this.dropped) parts.push(Buffer.from(cutMarker(this.dropped)));
    return Buffer.concat([...parts, ...this.tail]);
  }
}

interface Row {
  id: string; call: string | null; kind: OutputKind; name: string | null; place: string; command: string; cwd: string;
  started_at: string; ended_at: string | null; state: OutputState; exit_code: number | null; reason: string | null;
  bytes: number; dropped: number;
}

const COLUMNS = "id, call, kind, name, place, command, cwd, started_at, ended_at, state, exit_code, reason, bytes, dropped";

const fromRow = (r: Row): CommandOutput => ({
  id: r.id, ...(r.call ? { call: r.call } : {}), kind: r.kind, ...(r.name ? { name: r.name } : {}), place: r.place, command: r.command, cwd: r.cwd,
  startedAt: r.started_at, ...(r.ended_at ? { endedAt: r.ended_at } : {}), state: r.state,
  ...(r.exit_code !== null || r.ended_at ? { exitCode: r.exit_code } : {}), ...(r.reason ? { reason: r.reason } : {}),
  bytes: r.bytes, dropped: r.dropped,
});

/** How long a command ran, in milliseconds (one still running, until now). */
const ran = (o: CommandOutput, now: number) => (o.endedAt ? Date.parse(o.endedAt) : now) - Date.parse(o.startedAt);

/** Orders outputs for the Jobs dropdown: newest first unless asked otherwise; ties by start. */
export function sortOutputs(list: CommandOutput[], sort: OutputSort, now = Date.now()): CommandOutput[] {
  const byStart = (a: CommandOutput, b: CommandOutput) => b.startedAt.localeCompare(a.startedAt);
  const cmp: Record<OutputSort, (a: CommandOutput, b: CommandOutput) => number> = {
    newest: byStart,
    oldest: (a, b) => -byStart(a, b),
    running: (a, b) => Number(b.state === "running") - Number(a.state === "running") || byStart(a, b),
    longest: (a, b) => ran(b, now) - ran(a, now) || byStart(a, b),
  };
  return [...list].sort(cmp[sort]);
}

/**
 * Turns a running command's output into text for the open views piece by piece, holding back a character cut between
 * two pieces until the rest of it comes. `at` and `to` are the bytes of output before and after the text it gives.
 */
export class LiveText {
  private held = Buffer.alloc(0);
  piece(at: number, data: Buffer): { at: number; to: number; data: string } {
    const buf = this.held.length ? Buffer.concat([this.held, data]) : data;
    let cut = buf.length;
    // A UTF-8 lead byte within the last three whose sequence runs past the end: hold it and what follows.
    for (let i = buf.length - 1; i >= Math.max(0, buf.length - 3); i--) {
      const b = buf[i]!;
      if ((b & 0xc0) === 0x80) continue;
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      if (i + need > buf.length) cut = i;
      break;
    }
    const start = at - this.held.length;
    this.held = Buffer.from(buf.subarray(cut));
    return { at: start, to: start + cut, data: buf.subarray(0, cut).toString("utf8") };
  }
}

/** One thread pool's kept command output. */
export class CommandOutputs {
  constructor(private readonly db: Db, private readonly threadBytes: number = OUTPUT_LIMITS.threadBytes) {}

  /** The highest number used for `prefix` ("c" or "j") in the thread, so numbers go on after a restart. */
  lastNumber(thread: string, prefix: "c" | "j"): number {
    const r = this.db.prepare(`SELECT MAX(CAST(substr(id, 2) AS INTEGER)) AS n FROM command_outputs WHERE thread = ? AND substr(id, 1, 1) = ?`).get(thread, prefix) as { n: number | null };
    return r.n ?? 0;
  }

  /** Keeps a command and its output, replacing what was kept for it; then empties the thread's oldest past its limit. */
  save(thread: string, o: CommandOutput, output: Buffer): void {
    this.db.prepare(`INSERT OR REPLACE INTO command_outputs (thread, ${COLUMNS}, output)
      VALUES (@thread, @id, @call, @kind, @name, @place, @command, @cwd, @startedAt, @endedAt, @state, @exitCode, @reason, @bytes, @dropped, @output)`).run({
      thread, id: o.id, call: o.call ?? null, kind: o.kind, name: o.name ?? null, place: o.place, command: o.command, cwd: o.cwd,
      startedAt: o.startedAt, endedAt: o.endedAt ?? null, state: o.state, exitCode: o.exitCode ?? null, reason: o.reason ?? null,
      bytes: o.bytes, dropped: o.dropped, output,
    });
    const rows = this.db.prepare("SELECT id, length(output) AS size FROM command_outputs WHERE thread = ? ORDER BY started_at DESC").all(thread) as { id: string; size: number }[];
    let total = 0;
    for (const r of rows) {
      total += r.size;
      if (total > this.threadBytes && r.id !== o.id && r.size) {
        this.db.prepare("UPDATE command_outputs SET output = ?, dropped = bytes WHERE thread = ? AND id = ?").run(Buffer.from(cutMarker(r.size)), thread, r.id);
      }
    }
  }

  get(thread: string, id: string): CommandOutput | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM command_outputs WHERE thread = ? AND id = ?`).get(thread, id) as Row | undefined;
    return r && fromRow(r);
  }

  /** The output kept for a command, by its id. */
  text(thread: string, id: string): string | undefined {
    const r = this.db.prepare("SELECT output FROM command_outputs WHERE thread = ? AND id = ?").get(thread, id) as { output: Buffer } | undefined;
    return r?.output.toString("utf8");
  }

  /** The command a tool call ran, if it kept one. */
  byCall(thread: string, call: string): CommandOutput | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM command_outputs WHERE thread = ? AND call = ?`).get(thread, call) as Row | undefined;
    return r && fromRow(r);
  }

  /** The thread's commands of one kind; `q` (case ignored) matches the name, the command or anything kept of the output. */
  list(thread: string, kind: OutputKind, q?: string): CommandOutput[] {
    const needle = q?.trim().toLowerCase();
    const rows = needle
      ? this.db.prepare(`SELECT ${COLUMNS} FROM command_outputs WHERE thread = @thread AND kind = @kind
          AND (instr(lower(coalesce(name, '')), @q) OR instr(lower(command), @q) OR instr(lower(CAST(output AS TEXT)), @q))`).all({ thread, kind, q: needle })
      : this.db.prepare(`SELECT ${COLUMNS} FROM command_outputs WHERE thread = ? AND kind = ?`).all(thread, kind);
    return (rows as Row[]).map(fromRow);
  }
}

/** The longest `pattern` she may give. */
export const PATTERN_CHARS = 200;

/**
 * A page of kept output for her: from line `from` (1-based), or the lines matching `pattern`, numbered either way.
 * `pattern` is a regular expression (case ignored) run by RE2's linear-time engine (re2js), never JavaScript's own,
 * whose backtracking could hold lyricad's one thread for minutes: no lookaround or backreferences, and no pattern is
 * slow. A line too long for a page is cut with a marker, and a page always holds at least one line, so `from` moves on.
 */
export function outputPage(text: string, o: { from?: number; lines?: number; pattern?: string } = {}): string {
  const all = text.replace(/\n$/, "").split("\n");
  const total = all.length;
  const width = String(total).length;
  const room = OUTPUT_LIMITS.pageChars - width - 64;
  const num = (i: number) => {
    const l = all[i]!;
    return `${String(i + 1).padStart(width)}  ${l.length > room ? `${l.slice(0, room)} [… ${(l.length - room).toLocaleString("en-US")} more characters]` : l}`;
  };
  const fit = (lines: string[]) => {
    let size = 0;
    const out: string[] = [];
    for (const l of lines) { size += l.length + 1; if (size > OUTPUT_LIMITS.pageChars && out.length) break; out.push(l); }
    return out;
  };
  if (o.pattern) {
    if (o.pattern.length > PATTERN_CHARS) throw new Error(`pattern is longer than ${PATTERN_CHARS} characters`);
    let re: RE2JS;
    try { re = RE2JS.compile(o.pattern, RE2JS.CASE_INSENSITIVE); } catch (e) {
      throw new Error(`pattern isn't a regular expression this search reads (${(e as Error).message.replace(/^error parsing regexp: /, "")}); lookaround and backreferences aren't supported`);
    }
    const hits = all.flatMap((l, i) => (re.matcher(l).find() ? [i] : []));
    if (!hits.length) return `No line of ${total.toLocaleString("en-US")} matches ${o.pattern}.`;
    const shown = fit(hits.slice(0, OUTPUT_LIMITS.matches).map(num));
    return `${hits.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} lines match${shown.length < hits.length ? `; the first ${shown.length}` : ""}:\n${shown.join("\n")}`;
  }
  const from = Math.min(Math.max(1, Math.floor(o.from ?? 1)), total);
  const want = Math.min(Math.max(1, Math.floor(o.lines ?? OUTPUT_LIMITS.pageLines)), OUTPUT_LIMITS.maxPageLines);
  const shown = fit(all.slice(from - 1, from - 1 + want).map((_, k) => num(from - 1 + k)));
  const to = from + shown.length - 1;
  return `Lines ${from.toLocaleString("en-US")}-${to.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}${to < total ? `; from: ${to + 1} goes on` : ""}:\n${shown.join("\n")}`;
}
