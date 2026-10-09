// Mention tokens in memory text. Reading shows current names and pronouns
// (core's render); editing shows `[[Name]]` and `[[Name:obj]]`, which go back
// to `[[u:ID]]` tokens on save, so a later rename still applies.
import type { UserMap } from "./api.ts";
import { render } from "../../core/src/mentions.ts";

export function readable(text: string, users: UserMap): string {
  return render(text, (id) => (users[id] ? { ...users[id], previousNames: [] } : undefined));
}

const STORED = /\[\[u:([A-Za-z0-9-]+)(:[a-z-]+)?\]\]/g;
const EDITABLE = /\[\[([^\]:[]+)(:[a-z-]+)?\]\]/g;

export function toEditable(text: string, users: UserMap): string {
  return text.replace(STORED, (token, id: string, form = "") => (users[id] ? `[[${users[id].displayName}${form}]]` : token));
}

export function fromEditable(text: string, users: UserMap): string {
  const byName = new Map(Object.entries(users).map(([id, x]) => [x.displayName, id]));
  return text.replace(EDITABLE, (whole, name: string, form = "") => {
    const id = byName.get(name.trim());
    return id ? `[[u:${id}${form}]]` : whole;
  });
}
