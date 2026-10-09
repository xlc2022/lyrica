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

/** Turns users' names (current or previous) in a search query into their name tokens. */
export function queryTokens(query: string, profiles: Map<UserId, Profile>): string {
  // Current names win over previous ones; longer names win over their prefixes.
  const byName = new Map<string, UserId>();
  for (const [id, p] of profiles) byName.set(p.displayName.toLowerCase(), id);
  for (const [id, p] of profiles) {
    for (const prev of p.previousNames) if (!byName.has(prev.name.toLowerCase())) byName.set(prev.name.toLowerCase(), id);
  }
  const names = [...byName.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return query;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${names.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return query.replace(pattern, (name) => `[[u:${byName.get(name.toLowerCase())}]]`);
}

function startsSentence(text: string, offset: number): boolean {
  return /(^|[.!?]\s+|\n\s*)$/.test(text.slice(0, offset));
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
