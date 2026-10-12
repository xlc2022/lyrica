// Her name for this deployment (DESIGN.md "Her name"): from GET /api/state, in every state, default Lyrica.
// One helper in place of literals; App sets it before anything that says her name renders, and a rename
// (Administration → Her name) refreshes the state and remounts the shell, so every label follows.
let name = "Lyrica";

/** Her name, as the interface says it. */
export const her = (): string => name;

export function setHer(n: string): void {
  name = n.trim() || "Lyrica";
  document.title = name;
}

/** Mirrors core/src/persona.ts checkName: trim, count code points, and reject control or line separators. */
export function checkName(name: unknown): string {
  const n = String(name ?? "").trim();
  if (!n || [...n].length > 40) throw new Error("Her name is 1 to 40 characters.");
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(n)) throw new Error("Her name is one line of text.");
  return n;
}
