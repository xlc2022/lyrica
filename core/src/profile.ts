export interface Pronouns {
  subj: string;
  obj: string;
  poss: string;
  possPro: string;
  refl: string;
}

export interface Profile {
  displayName: string;
  pronouns: Pronouns;
  /** Earlier display names, oldest first. `until` is the ISO date of the rename. */
  previousNames: { name: string; until: string }[];
  /** Persona colour in the web UI, "#rrggbb". */
  accent?: string;
  /** One or two letters. */
  monogram?: string;
}

export const PRONOUN_PRESETS = {
  she: { subj: "she", obj: "her", poss: "her", possPro: "hers", refl: "herself" },
  he: { subj: "he", obj: "him", poss: "his", possPro: "his", refl: "himself" },
  they: { subj: "they", obj: "them", poss: "their", possPro: "theirs", refl: "themself" },
} as const satisfies Record<string, Pronouns>;

/** "she/her", or every form for custom pronouns. */
export function pronounLabel(p: Pronouns): string {
  const preset = Object.values(PRONOUN_PRESETS).some((q) => samePronouns(p, q));
  return preset ? `${p.subj}/${p.obj}` : [p.subj, p.obj, p.poss, p.possPro, p.refl].join("/");
}

export function samePronouns(a: Pronouns, b: Pronouns): boolean {
  return a.subj === b.subj && a.obj === b.obj && a.poss === b.poss && a.possPro === b.possPro && a.refl === b.refl;
}

export function checkProfile(p: Profile): void {
  if (!p.displayName.trim()) throw new Error("display name must not be empty");
  for (const [form, value] of Object.entries(p.pronouns)) {
    if (!value.trim()) throw new Error(`pronoun form ${form} must not be empty`);
  }
  if (p.accent !== undefined && !/^#[0-9a-f]{6}$/i.test(p.accent)) throw new Error("the accent colour looks like #rrggbb");
  if (p.monogram !== undefined && !/^\p{L}{1,2}$/u.test(p.monogram)) throw new Error("a monogram is one or two letters");
}
