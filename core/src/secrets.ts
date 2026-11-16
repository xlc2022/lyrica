/** Credential shapes removed before memory reaches encrypted storage. */
export const SECRET_REMOVED = "[secret removed]";

export const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
export const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY\2-----|$)/g;

/** Also used by machine file reads; an unfinished key is removed through EOF. */
export function removePrivateKeys(text: string, marker = SECRET_REMOVED): string {
  return text.replace(KEY_BLOCK, marker);
}

// Each token shape, tried where its prefix starts a word. A shape that fails at one
// start fails at every later start in the same run of its characters, because it
// must take that run to its end; the scan skips those starts, so crafted output
// like "eyJ-eyJ-…" costs linear time instead of quadratic.
const TOKEN_START = /\b(?:gh[pousr]_|github_pat_|sk-|xox[abpr]-|AKIA|AIza|eyJ)/g;
const TOKEN_AT = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/y;
const RUN: Record<string, RegExp> = { xox: /[A-Za-z0-9-]*/y, eyJ: /[A-Za-z0-9_-]*/y };

/** Where each token is in `text`, in order. */
function tokenSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const dead: Record<string, number> = {};
  TOKEN_START.lastIndex = 0;
  for (let m = TOKEN_START.exec(text); m; m = TOKEN_START.exec(text)) {
    const at = m.index;
    const kind = m[0].slice(0, 3);
    const run = RUN[kind];
    if (run && at < (dead[kind] ?? -1)) { TOKEN_START.lastIndex = at + 1; continue; }
    TOKEN_AT.lastIndex = at;
    const token = TOKEN_AT.exec(text);
    if (token) {
      spans.push([at, at + token[0].length]);
      TOKEN_START.lastIndex = at + token[0].length;
      continue;
    }
    if (run) { run.lastIndex = at; run.exec(text); dead[kind] = run.lastIndex; }
    TOKEN_START.lastIndex = at + 1;
  }
  return spans;
}

const HEADERS = /\b(authorization[ \t]*:[ \t]*(?:(?:bearer|basic)[ \t]+)?|bearer[ \t]+)[^\s"'`,;<>]+/gi;
// Keep the key (including environment variable names), remove the entire value.
// The match starts at the key word itself (after any non-alphanumeric, so
// "GH_TOKEN" matches at "TOKEN"); the rest of the name stays as it is, and the
// scan can't rescan a long "a-a-a-…" name from each of its dashes.
const PAIRS = /((?<![A-Za-z0-9])["']?(?:token|secret|password|api_key|apikey|auth)["']?[ \t]*[:=][ \t]*)(?:\[secret removed\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}`]+)(?![A-Za-z0-9_])/gi;

/** How far back from a match's end the next key word can begin and still reach past it: across the space or quote that ends a value. */
const REACH = 32;

/**
 * What `re` (a key or header word in group 1, then its value) removes in
 * `text`: the value alone when `keepKey`. A value can end in the start of
 * another key ("auth: authorization: abc"), so after each match the scan
 * resumes near its end rather than after it, which keeps it linear.
 */
function valueSpans(text: string, re: RegExp, keepKey: boolean): [number, number][] {
  const spans: [number, number][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const value = m.index + m[1]!.length, end = m.index + m[0].length;
    spans.push([keepKey ? value : m.index, end]);
    re.lastIndex = Math.max(value, end - REACH);
  }
  return spans;
}

/**
 * Each detector reads the same text and what any of them finds is removed,
 * overlaps merged into one marker. Run one after another, a pair's value
 * could swallow the start of a header ("X-Auth-Token: Bearer abc" kept "abc").
 */
export function removeSecrets(text: string): string {
  const t = removePrivateKeys(text);
  // A marker already there counts as found, so a match ending inside one takes it whole rather than leaving "removed]".
  const markers: [number, number][] = [];
  for (let at = t.indexOf(SECRET_REMOVED); at >= 0; at = t.indexOf(SECRET_REMOVED, at + SECRET_REMOVED.length)) markers.push([at, at + SECRET_REMOVED.length]);
  const spans = [...markers, ...valueSpans(t, PAIRS, true), ...valueSpans(t, HEADERS, false), ...tokenSpans(t)].sort((a, b) => a[0] - b[0]);
  let out = "";
  let kept = 0;
  for (let i = 0; i < spans.length; ) {
    let [start, end] = spans[i++]!;
    while (i < spans.length && spans[i]![0] < end) end = Math.max(end, spans[i++]![1]);
    out += t.slice(kept, start) + SECRET_REMOVED;
    kept = end;
  }
  return out + t.slice(kept);
}
