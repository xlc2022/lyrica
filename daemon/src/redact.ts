// A URL as the API shows it: query values whose names look like a
// credential are hidden, so an MCP server or endpoint saved with a key in
// its address doesn't show the key back (to its owner, or to other users of
// a shared endpoint). What is stored is left as it is.

const SECRET_PARAM = /key|token|secret|sig|auth|pass|credential/i;
export const HIDDEN = "•••";

export function redactUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return raw; }
  let changed = false;
  for (const [name, value] of [...url.searchParams]) {
    if (SECRET_PARAM.test(name) && value) { url.searchParams.set(name, HIDDEN); changed = true; }
  }
  return changed ? url.toString() : raw;
}

/** A URL sent back from the interface: each hidden value is the stored URL's, so an edit to another part keeps the key. */
export function unredactUrl(next: string, stored: string): string {
  let url: URL;
  let before: URL;
  try { url = new URL(next); before = new URL(stored); } catch { return next; }
  let changed = false;
  for (const [name, value] of [...url.searchParams]) {
    const kept = before.searchParams.get(name);
    if (value === HIDDEN && kept !== null) { url.searchParams.set(name, kept); changed = true; }
  }
  return changed ? url.toString() : next;
}
