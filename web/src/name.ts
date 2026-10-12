// Her name for this deployment (DESIGN.md "Her name"): from GET /api/state, in every state, default Lyrica.
// One helper in place of literals; App sets it before anything that says her name renders, and a rename
// (Administration → Persona) refreshes the state and remounts the shell, so every label follows.
let name = "Lyrica";

/** Her name, as the interface says it. */
export const her = (): string => name;

export function setHer(n: string): void {
  name = n.trim() || "Lyrica";
  document.title = name;
}
