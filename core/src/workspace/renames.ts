// A file renamed or moved in the Files panel keeps its links (DESIGN, "Files and images"): every stored mention of
// its old path, as a thread writes it, is rewritten to the new one. Pure text work; the store and the workspace
// decide where it runs.

/**
 * One way a thread writes the file: its old path and its new one. `link`: a path relative to the thread's folder,
 * rewritten only as a markdown link's target, since bare it could be anything.
 */
export interface Respelling { from: string; to: string; link?: true }

/** What ends a path in prose (as the web's PATH): a space, a quote, a bracket, a pipe, a comma or a semicolon. */
const END = String.raw`\s"'\x60<>()[\]{}|,;`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The old path where it starts a word (or follows `file://`, or a link's `](`), followed by its end, a folder's
 * `/`, or trailing punctuation: `/workspace/a.png.` is the file, `/workspace/a.png.bak` another one.
 */
function pattern(r: Respelling): RegExp {
  const before = r.link ? String.raw`(?<=\]\(\s*<?)` : String.raw`(?:(?<=file:\/\/)|(?<![\w.~/:%-]))`;
  const after = String.raw`(?=$|[/${END}]|[:.!?]+(?:$|[${END}])${r.link ? String.raw`|[#?>]` : ""})`;
  return new RegExp(before + escape(r.from) + after, "g");
}

/** Each respelling, with its percent-encoded twin when that differs (a markdown link to `My%20photo.png`). */
function withEncoded(swaps: Respelling[]): Respelling[] {
  const out: Respelling[] = [];
  for (const s of swaps) {
    if (!s.from || s.from === s.to) continue;
    out.push(s);
    const from = encodeURI(s.from), to = encodeURI(s.to);
    if (from !== s.from) out.push({ ...s, from, to });
  }
  // Longest first: a folder's children aren't rewritten through a shorter spelling first.
  return out.sort((a, b) => b.from.length - a.from.length);
}

/** A rewriter for these respellings; the identity when there are none. */
export function pathRewriter(swaps: Respelling[]): (text: string) => string {
  const all = withEncoded(swaps).map((s) => ({ re: pattern(s), to: s.to, from: s.from }));
  if (!all.length) return (text) => text;
  return (text) => {
    let out = text;
    for (const s of all) if (out.includes(s.from)) out = out.replace(s.re, () => s.to);
    return out;
  };
}

/** The plain strings that must appear in a text for the rewriter to change it: what a store looks for first. */
export function needles(swaps: Respelling[]): string[] {
  return [...new Set(withEncoded(swaps).map((s) => s.from))];
}

/**
 * Every string in a stored Pi message, rewritten. An image's bytes and her reasoning are left as they are: one is
 * not text, and a provider checks the other against its signature.
 */
export function rewriteStrings(value: unknown, rewrite: (s: string) => string): unknown {
  if (typeof value === "string") return rewrite(value);
  if (Array.isArray(value)) return value.map((v) => rewriteStrings(v, rewrite));
  if (value && typeof value === "object") {
    const type = (value as { type?: unknown }).type;
    if (type === "image" || type === "thinking" || type === "redacted_thinking") return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteStrings(v, rewrite)]));
  }
  return value;
}
