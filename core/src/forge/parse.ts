// Readers shared by the forge modules (github.ts, forgejo.ts): each checks one
// field of a recorded answer and throws, naming it, when the shape is wrong.

export type Obj = Record<string, unknown>;

export function asObj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what} is not an object`);
  return v as Obj;
}

export function asList(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what} is not a list`);
  return v;
}

export function strOf(o: Obj, key: string, what: string): string {
  const s = o[key];
  if (typeof s !== "string" || s === "") throw new Error(`${what}.${key} is missing`);
  return s;
}

export function numOf(o: Obj, key: string, what: string): number {
  const n = o[key];
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`${what}.${key} is not a whole number`);
  return n;
}

/** The first of `keys` holding a usable timestamp. Gitea leaves submitted_at at
 * the zero time until a review is submitted; GitHub leaves optional ones out. */
export function timeOf(o: Obj, keys: string[], what: string): string {
  for (const key of keys) {
    const s = o[key];
    if (typeof s === "string" && s !== "" && !s.startsWith("0001-")) return s;
  }
  throw new Error(`${what} has no ${keys.join(" or ")}`);
}

/** Who merged the pull, when the forge says; anything else reads as unknown. */
export function mergedByOf(user: unknown): { mergedBy?: string } {
  const login = user && typeof user === "object" ? (user as { login?: unknown }).login : undefined;
  return typeof login === "string" && login ? { mergedBy: login } : {};
}
