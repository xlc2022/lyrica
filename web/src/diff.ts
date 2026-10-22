// Line differences for the changes view (docs/ux.md §6, "The changes a thread made"): Myers's algorithm over the
// lines, the changed lines paired so their words can be highlighted, and the unchanged stretches folded. Computed
// in the browser from the two sides the daemon sends; nothing is stored.
import { wordDiff, type DiffOp } from "./memory.ts";

export type Line =
  | { kind: "same"; a: number; b: number; text: string }
  | { kind: "del"; a: number; text: string; ops?: DiffOp[] }
  | { kind: "ins"; b: number; text: string; ops?: DiffOp[] };

/** Past this many edits two sides are shown as one removed and one added, not matched line by line. */
const MAX_EDITS = 2000;
/** Unchanged lines kept around a change. */
export const CONTEXT = 3;
/** How many folded lines one press shows. */
export const FOLD_STEP = 20;

const splitLines = (s: string): string[] => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/**
 * The lines of `before` and `after`, each once, as kept, removed or added. A removed run followed by an added run
 * is a change: its lines are paired in order and each pair gets its word differences (`ops`).
 */
export function lineDiff(before: string, after: string): Line[] {
  const a = splitLines(before), b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: Line[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: "same", a: i + 1, b: i + 1, text: a[i]! });
  const midA = a.slice(head, a.length - tail), midB = b.slice(head, b.length - tail);
  for (const op of myers(midA, midB)) {
    if (op.kind === "same") out.push({ kind: "same", a: head + op.i + 1, b: head + op.j + 1, text: midA[op.i]! });
    else if (op.kind === "del") out.push({ kind: "del", a: head + op.i + 1, text: midA[op.i]! });
    else out.push({ kind: "ins", b: head + op.j + 1, text: midB[op.j]! });
  }
  for (let i = 0; i < tail; i++) out.push({ kind: "same", a: a.length - tail + i + 1, b: b.length - tail + i + 1, text: a[a.length - tail + i]! });
  pairWords(out);
  return out;
}

type Op = { kind: "same"; i: number; j: number } | { kind: "del"; i: number } | { kind: "ins"; j: number };

/** Myers's shortest edit script, with the whole middle replaced once it would take more than MAX_EDITS edits. */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  if (!n && !m) return [];
  const replace = (): Op[] => [...a.map((_, i) => ({ kind: "del" as const, i })), ...b.map((_, j) => ({ kind: "ins" as const, j }))];
  const max = Math.min(n + m, MAX_EDITS);
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 3);
  const off = max + 1;
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    const next = new Int32Array(v);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      next[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    trace.push(next);
    v = next;
  }
  if (found < 0) return replace();
  // Walk the trace back from the end, then reverse.
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && prev[off + k - 1]! < prev[off + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[off + prevK]!, prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ kind: "same", i: x, j: y }); }
    if (down) { y--; ops.push({ kind: "ins", j: y }); } else { x--; ops.push({ kind: "del", i: x }); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ kind: "same", i: x, j: y }); }
  return ops.reverse();
}

/** Each removed run followed by an added run: the lines paired in order get their words compared. */
function pairWords(lines: Line[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== "del") { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j]!.kind === "del") j++;
    let k = j;
    while (k < lines.length && lines[k]!.kind === "ins") k++;
    const pairs = Math.min(j - i, k - j);
    for (let p = 0; p < pairs; p++) {
      const del = lines[i + p] as Extract<Line, { kind: "del" }>, ins = lines[j + p] as Extract<Line, { kind: "ins" }>;
      const ops = wordDiff(del.text, ins.text);
      // Only a line that kept something is worth marking: a wholly different line reads better plain.
      if (ops.some((o) => o.kind === "same" && o.text.trim())) {
        del.ops = ops.filter((o) => o.kind !== "ins");
        ins.ops = ops.filter((o) => o.kind !== "del");
      }
    }
    i = k;
  }
}

/** One stretch of the diff as shown: lines, or a fold of unchanged ones (`from` to `to` in `lines`, exclusive). */
export type Block = { kind: "lines"; from: number; to: number } | { kind: "fold"; from: number; to: number };

/**
 * The diff cut into shown stretches and folds: unchanged runs longer than twice the context fold, keeping CONTEXT
 * lines on each side of a change; `opened` holds how many lines each fold (by its start) has been unfolded from
 * its top. A file with no change at all (both sides equal) is one fold.
 */
export function blocks(lines: Line[], opened: ReadonlyMap<number, number>): Block[] {
  const out: Block[] = [];
  let i = 0;
  const push = (b: Block) => { const last = out.at(-1); if (last?.kind === "lines" && b.kind === "lines" && last.to === b.from) last.to = b.to; else out.push(b); };
  while (i < lines.length) {
    if (lines[i]!.kind !== "same") { push({ kind: "lines", from: i, to: i + 1 }); i++; continue; }
    let j = i;
    while (j < lines.length && lines[j]!.kind === "same") j++;
    const before = i === 0 ? 0 : CONTEXT, after = j === lines.length ? 0 : CONTEXT;
    if (j - i <= before + after + 1) { push({ kind: "lines", from: i, to: j }); i = j; continue; }
    if (before) push({ kind: "lines", from: i, to: i + before });
    const start = i + before, end = j - after;
    const shown = Math.min(opened.get(start) ?? 0, end - start);
    if (shown) push({ kind: "lines", from: start, to: start + shown });
    if (start + shown < end) out.push({ kind: "fold", from: start + shown, to: end });
    if (after) push({ kind: "lines", from: end, to: j });
    i = j;
  }
  return out;
}

/** Side-by-side rows: a kept line on both sides, a change's pairs beside each other, the rest facing a blank. */
export type Row = { left?: Line; right?: Line };

export function sideBySide(lines: Line[], from: number, to: number): Row[] {
  const rows: Row[] = [];
  let i = from;
  while (i < to) {
    const l = lines[i]!;
    if (l.kind === "same") { rows.push({ left: l, right: l }); i++; continue; }
    let j = i;
    while (j < to && lines[j]!.kind === "del") j++;
    let k = j;
    while (k < to && lines[k]!.kind === "ins") k++;
    for (let p = 0; p < Math.max(j - i, k - j); p++) rows.push({ left: i + p < j ? lines[i + p] : undefined, right: j + p < k ? lines[j + p] : undefined });
    i = k;
  }
  return rows;
}
