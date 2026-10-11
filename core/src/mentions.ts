import type { Profile, Pronouns } from "./profile.ts";

// Stored memory names users by token, so renames and pronoun changes never
// rewrite it (docs/memory.md, "Names and pronouns"). There is no subject
// pronoun token: "she is" vs "they are" would need the verb to change too.

export type UserId = string;

const FORMS = { obj: "obj", poss: "poss", "poss-pro": "possPro", refl: "refl" } as const satisfies Record<string, keyof Pronouns>;
type Form = keyof typeof FORMS;

const WRITTEN = /\{user(?::([a-z-]+))?\}/g;
const STORED = /\[\[u:([A-Za-z0-9-]+)(?::([a-z-]+))?\]\]/g;

/** `{user}`, `{user:obj}`… (as Lyrica writes them) → `[[u:ID]]`, `[[u:ID:obj]]`… */
export function toStored(text: string, speaker: UserId): string {
  return text.replace(WRITTEN, (_m, form: string | undefined) => {
    if (form === undefined) return `[[u:${speaker}]]`;
    if (form === "subj") throw new Error("there is no {user:subj}; write {user} where the subject pronoun would go");
    if (!(form in FORMS)) throw new Error(`unknown mention form {user:${form}}`);
    return `[[u:${speaker}:${form}]]`;
  });
}

/**
 * Tokens → current display names and pronouns. A pronoun that starts a
 * sentence is capitalised. Tokens for unknown users are left as they are.
 */
export function render(text: string, profiles: (id: UserId) => Profile | undefined): string {
  return text.replace(STORED, (token, id: string, form: string | undefined, offset: number) => {
    const profile = profiles(id);
    if (!profile) return token;
    if (form === undefined) return profile.displayName;
    if (!(form in FORMS)) return token;
    const word = profile.pronouns[FORMS[form as Form]];
    return startsSentence(text, offset) ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  });
}

export interface NameMatch {
  /** The name as it appears in the query. */
  name: string;
  userId: UserId;
}

/**
 * Finds users' names (current or previous) in a search query. The query is
 * not changed: the caller searches for each name OR its user's token, so
 * "Li-ion" still matches notes that say "Li-ion".
 */
export function queryTokens(query: string, profiles: Map<UserId, Profile>): NameMatch[] {
  // Current names win over previous ones; longer names win over their prefixes.
  const byName = new Map<string, UserId>();
  for (const [id, p] of profiles) byName.set(p.displayName.toLowerCase(), id);
  for (const [id, p] of profiles) {
    for (const prev of p.previousNames) if (!byName.has(prev.name.toLowerCase())) byName.set(prev.name.toLowerCase(), id);
  }
  const names = [...byName.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${names.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const seen = new Set<string>();
  const matches: NameMatch[] = [];
  for (const [name] of query.matchAll(pattern)) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ name, userId: byName.get(key)! });
  }
  return matches;
}

function startsSentence(text: string, offset: number): boolean {
  return /(^|[.!?]\s+|\n\s*)$/.test(text.slice(0, offset));
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Threads are mentioned by their permanent ID, never their title, so a rename
// shows in every past mention without rewriting anything (DESIGN.md, "Thread
// mentions"). The web draws each as a chip with the current title.

/** `[t:<id>]`, `[e:<id>#<n>]`, and from a private view `[general/t:<id>]`. */
export const THREAD_MENTION = /\[(?:(general|private)\/)?([te]):([^\]\s#]+)(?:#(\d+))?\]/g;

/** What a mention reads as where there is no chip: the thread's current title, or "a forgotten thread". */
export function renderThreadMentions(text: string, titleOf: (threadId: string, pool?: "general" | "private") => string | undefined): string {
  return text.replace(THREAD_MENTION, (_m, pool: "general" | "private" | undefined, _kind: string, id: string) => titleOf(id, pool) ?? "a forgotten thread");
}
