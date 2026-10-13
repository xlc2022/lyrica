/** Credential shapes removed before memory reaches encrypted storage. */
export const SECRET_REMOVED = "[secret removed]";

export const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
export const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY\2-----|$)/g;

/** Also used by machine file reads; an unfinished key is removed through EOF. */
export function removePrivateKeys(text: string, marker = SECRET_REMOVED): string {
  return text.replace(KEY_BLOCK, marker);
}

const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/g;
const HEADERS = /\b(?:authorization[ \t]*:[ \t]*(?:(?:bearer|basic)[ \t]+)?|bearer[ \t]+)[^\s"'`,;<>]+/gi;
// Keep the key (including environment variable names), remove the entire value.
const PAIRS = /((?<![A-Za-z0-9_])(?:["']?(?:[A-Za-z0-9]+[_-])*(?:token|secret|password|api_key|apikey|auth)["']?)[ \t]*[:=][ \t]*)(?:\[secret removed\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}`]+)(?![A-Za-z0-9_])/gi;

export function removeSecrets(text: string): string {
  return removePrivateKeys(text).replace(PAIRS, (_match, key: string) => key + SECRET_REMOVED).replace(HEADERS, SECRET_REMOVED).replace(TOKENS, SECRET_REMOVED);
}
