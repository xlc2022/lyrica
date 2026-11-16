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

function removeTokens(text: string): string {
  let out = "";
  let kept = 0;
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
      out += text.slice(kept, at) + SECRET_REMOVED;
      kept = TOKEN_START.lastIndex = at + token[0].length;
      continue;
    }
    if (run) { run.lastIndex = at; run.exec(text); dead[kind] = run.lastIndex; }
    TOKEN_START.lastIndex = at + 1;
  }
  return kept ? out + text.slice(kept) : text;
}

const HEADERS = /\b(?:authorization[ \t]*:[ \t]*(?:(?:bearer|basic)[ \t]+)?|bearer[ \t]+)[^\s"'`,;<>]+/gi;
// Keep the key (including environment variable names), remove the entire value.
// The match starts at the key word itself (after any non-alphanumeric, so
// "GH_TOKEN" matches at "TOKEN"); the rest of the name stays as it is, and the
// scan can't rescan a long "a-a-a-…" name from each of its dashes.
const PAIRS = /((?<![A-Za-z0-9])["']?(?:token|secret|password|api_key|apikey|auth)["']?[ \t]*[:=][ \t]*)(?:\[secret removed\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}`]+)(?![A-Za-z0-9_])/gi;

export function removeSecrets(text: string): string {
  return removeTokens(removePrivateKeys(text).replace(PAIRS, (_match, key: string) => key + SECRET_REMOVED).replace(HEADERS, SECRET_REMOVED));
}
