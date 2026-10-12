// A URL as the API shows it: query values whose names look like a
// credential are hidden, so an MCP server or endpoint saved with a key in
// its address doesn't show the key back (to its owner, or to other users of
// a shared endpoint). What is stored is left as it is, and the rest of the
// URL is shown exactly as stored.

const SECRET_PARAM = /key|token|secret|sig|auth|pass|credential/i;
export const HIDDEN = "•••";

/** Each `name=value` in the query, as written. */
function params(raw: string): { start: number; end: number; name: string; value: string }[] {
  const q = raw.indexOf("?");
  if (q < 0) return [];
  const hash = raw.indexOf("#", q);
  const query = raw.slice(q + 1, hash < 0 ? undefined : hash);
  const out: { start: number; end: number; name: string; value: string }[] = [];
  let at = q + 1;
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      let name: string;
      try { name = decodeURIComponent(part.slice(0, eq).replace(/\+/g, " ")); } catch { name = part.slice(0, eq); }
      out.push({ start: at + eq + 1, end: at + part.length, name, value: part.slice(eq + 1) });
    }
    at += part.length + 1;
  }
  return out;
}

/** Replaces values in `raw` by position, last first, so earlier positions stay right. */
function splice(raw: string, swaps: { start: number; end: number; value: string }[]): string {
  return swaps.sort((a, b) => b.start - a.start).reduce((s, w) => s.slice(0, w.start) + w.value + s.slice(w.end), raw);
}

export function redactUrl(raw: string): string {
  return splice(raw, params(raw).filter((p) => SECRET_PARAM.test(p.name) && p.value).map((p) => ({ ...p, value: HIDDEN })));
}

const origin = (u: string): string | undefined => { try { return new URL(u).origin; } catch { return undefined; } };
const hidden = (v: string) => v === HIDDEN || v === encodeURIComponent(HIDDEN);

/**
 * A URL sent back from the interface: each hidden value is the stored URL's,
 * so an edit to another part keeps the key. Only on the same origin: a key
 * never follows a URL to another host.
 */
export function unredactUrl(next: string, stored: string): string {
  if (!origin(next) || origin(next) !== origin(stored)) return next;
  const kept = new Map(params(stored).map((p) => [p.name, p.value]));
  return splice(next, params(next).filter((p) => hidden(p.value) && kept.has(p.name)).map((p) => ({ ...p, value: kept.get(p.name)! })));
}
