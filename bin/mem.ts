// `lyrica mem`: her memory at the prompt, as the web's memory browser has it.
// A client of lyricad over its socket. Text passes through this process and
// the terminal only: editing is a line editor here, never $EDITOR and a temp
// file, and export prints to standard output (docs/briefs/terminal-clients.md).
import type { MemoryDetail, MemoryExport, MemoryHistory, MemoryHit, Pool, UserMap } from "@lyrica/daemon/api";
import { type Client, Interrupted, type Io, printable, signIn, socketPath, take, terminalIo, value } from "./client.ts";

export const MEM_USAGE = `  lyrica mem search <words> | show <id> | history <id> | edit <id> | restore <id> <revision>
  lyrica mem archive <id> | unarchive <id> | delete <id> | note [<text>] | forget <words> | export <id>…
      [--private] [--login <login>]   (her memories at the prompt; an id is pool/id as search shows it)`;

/** Entry point for `lyrica mem`. */
export async function mem(args: string[], opts: { socket?: string; runtime?: string }, io: Io = terminalIo()): Promise<void> {
  const pool: Pool = take(args, "--private") ? "private" : "general";
  const login = value(args, "--login");
  const [sub, ...rest] = args;
  if (!sub || !(sub in COMMANDS)) throw new Error(`usage:\n${MEM_USAGE}`);
  const client = await signIn(io, socketPath(opts), login);
  try {
    await COMMANDS[sub]!({ io, client, pool, rest });
  } catch (err) {
    if (err instanceof Interrupted) return;
    throw err;
  } finally {
    await client.logout();
  }
}

interface Ctx { io: Io; client: Client; pool: Pool; rest: string[] }

const COMMANDS: Record<string, (c: Ctx) => Promise<void>> = {
  search: async ({ io, client, pool, rest }) => {
    const hits = await search(client, pool, words(rest));
    if (!hits.length) return io.err("No memories match.");
    for (const h of hits) io.out(`${hitLine(h)}\n`);
  },
  show: async ({ io, client, pool, rest }) => {
    const d = await detail(client, ref(rest[0], pool));
    const { item } = d;
    io.out(printable(`${item.pool}/${item.id}  ${item.kind}${item.archived ? ", archived" : ""}  ${item.updatedAt.slice(0, 16).replace("T", " ")}\n`));
    if (item.title) io.out(printable(`${render(item.title, d.users)}\n`));
    io.out(printable(`\n${render(item.text, d.users)}\n`));
    if (d.cameFrom.length) io.out(printable(`\nCame from: ${d.cameFrom.map((id) => linkLabel(d, id)).join("; ")}\n`));
    if (d.usedIn.length) io.out(printable(`Used in: ${d.usedIn.map((u) => linkLabel(d, u.id)).join("; ")}\n`));
  },
  history: async ({ io, client, pool, rest }) => {
    const r = ref(rest[0], pool);
    const { entries, detail: { users } } = await client.get<MemoryHistory>(memPath(client, r, "/history?limit=100"));
    for (const v of entries) io.out(printable(`${v.id}  ${v.createdAt.slice(0, 16).replace("T", " ")}  ${v.author}  ${firstLine(render(v.body.text, users))}\n`));
  },
  edit: async ({ io, client, pool, rest }) => {
    const r = ref(rest[0], pool);
    const d = await detail(client, r);
    const lines = render(d.item.text, d.users, true).split("\n");
    const edited = await editLines(io, lines);
    if (!edited) return io.err("Nothing was changed.");
    const saved = await client.call<MemoryDetail>("PATCH", memPath(client, r), { text: unrender(edited.join("\n"), d.users) });
    io.err(`Saved as a new revision of ${saved.item.pool}/${saved.item.id}.`);
  },
  restore: async ({ io, client, pool, rest }) => {
    const r = ref(rest[0], pool);
    const revision = Number(rest[1]);
    if (!Number.isInteger(revision)) throw new Error("restore needs a revision number from lyrica mem history");
    await client.post(memPath(client, r, "/restore"), { revision });
    io.err(`Restored revision ${revision}, as a new revision.`);
  },
  archive: async (c) => archive(c, true),
  unarchive: async (c) => archive(c, false),
  delete: async ({ io, client, pool, rest }) => {
    const r = ref(rest[0], pool);
    const d = await detail(client, r);
    io.err(printable(firstLine(render(d.item.text, d.users))));
    if (!(await confirm(io, "Delete this memory and its revisions for good? [y/N] "))) return io.err("Nothing was deleted.");
    await client.call("DELETE", memPath(client, r));
    io.err("Deleted. A tombstone keeps sleep from writing it again.");
  },
  note: async ({ io, client, pool, rest }) => {
    const text = rest.join(" ").trim() || (await io.ask("Note: ")).trim();
    if (!text) return io.err("Nothing was saved.");
    const saved = await client.post<MemoryDetail>(client.u(`/memory/${pool}/notes`), { text });
    io.err(`Saved ${saved.item.pool}/${saved.item.id}.`);
  },
  forget: async ({ io, client, pool, rest }) => {
    const hits = (await search(client, pool, words(rest))).filter((h) => h.kind === "note" || h.kind === "page");
    if (!hits.length) return io.err("No memories match.");
    hits.forEach((h, i) => io.err(`${String(i + 1).padStart(3)}. ${hitLine(h)}`));
    const chosen = pickMany((await io.ask("Forget which [all, none, or numbers]: ")).trim(), hits.length);
    if (!chosen.length) return io.err("Nothing was forgotten.");
    const picked = chosen.map((i) => hits[i]!);
    if (!(await confirm(io, `Forget ${picked.length} ${picked.length === 1 ? "memory" : "memories"} for good? [y/N] `))) return io.err("Nothing was forgotten.");
    for (const p of ["general", "private"] as const) {
      const ids = picked.filter((h) => h.pool === p).map((h) => h.id);
      if (ids.length) await client.post(client.u(`/memory/${p}/forget`), { ids });
    }
    io.err(`Forgot ${picked.length}. Pages that cited them are rewritten at the next sleep.`);
  },
  export: async ({ io, client, pool, rest }) => {
    if (!rest.length) throw new Error("export needs one or more ids");
    const items = rest.map((x) => ref(x, pool));
    const out = await client.post<MemoryExport>(client.u("/memory/export"), { items });
    io.out(out.markdown.endsWith("\n") ? out.markdown : `${out.markdown}\n`);
    if (out.skipped) io.err(`${out.skipped} skipped: only notes and pages export.`);
  },
};

function words(rest: string[]): string {
  const q = rest.join(" ").trim();
  if ([...q].length < 2) throw new Error("search needs at least two characters");
  return q;
}

/** `general/n:…`, `private/p:…`, or a bare id in the pool the flags chose. */
export function ref(arg: string | undefined, pool: Pool): { pool: Pool; id: string } {
  if (!arg) throw new Error("this needs a memory id, as lyrica mem search shows it");
  const m = /^(general|private)\/(.+)$/.exec(arg);
  return m ? { pool: m[1] as Pool, id: m[2]! } : { pool, id: arg };
}

function memPath(client: Client, r: { pool: Pool; id: string }, rest = ""): string {
  return client.u(`/memory/${r.pool}/${encodeURIComponent(r.id)}${rest}`);
}

async function search(client: Client, pool: Pool, q: string): Promise<MemoryHit[]> {
  return client.get<MemoryHit[]>(client.u(`/memory/search?q=${encodeURIComponent(q)}&pool=${pool}&limit=50`));
}

async function detail(client: Client, r: { pool: Pool; id: string }): Promise<MemoryDetail> {
  return client.get<MemoryDetail>(memPath(client, r));
}

async function archive({ io, client, pool, rest }: Ctx, archived: boolean): Promise<void> {
  const r = ref(rest[0], pool);
  await client.post(memPath(client, r, "/archive"), { archived });
  io.err(archived ? "Archived: she stops using it until it's unarchived." : "Unarchived.");
}

function hitLine(h: MemoryHit): string {
  const when = h.updatedAt ? `  ${h.updatedAt.slice(0, 10)}` : "";
  return printable(`${h.pool}/${h.id}  ${h.kind}${when}  ${firstLine(h.title ?? h.snippet)}`);
}

function linkLabel(d: MemoryDetail, id: string): string {
  const link = d.links[id];
  return link ? `${id} (${firstLine(render(link.title ?? link.snippet, d.users))})` : id;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

const STORED = /\[\[u:([A-Za-z0-9-]+)(?::([a-z-]+))?\]\]/g;

/**
 * Mention tokens → names. For editing (`braces`), each is `{Name}` or
 * `{Name:obj}`, which `unrender` turns back into the token on save.
 */
export function render(text: string, users: UserMap, braces = false): string {
  return text.replace(STORED, (token, id: string, form?: string) => {
    const name = users[id]?.displayName;
    if (!name) return braces ? token : "a former user";
    if (braces) return `{${name}${form ? `:${form}` : ""}}`;
    if (!form) return name;
    const key = ({ obj: "obj", poss: "poss", "poss-pro": "possPro", refl: "refl" } as const)[form as "obj"];
    return key ? users[id]!.pronouns[key] : token;
  });
}

/** `{Name}` and `{Name:form}` for a user in the map → their token; anything else stays as typed. */
export function unrender(text: string, users: UserMap): string {
  const byName = new Map<string, string>();
  const twice = new Set<string>();
  for (const [id, u] of Object.entries(users)) {
    const k = u.displayName.toLowerCase();
    if (byName.has(k)) twice.add(k);
    byName.set(k, id);
  }
  return text.replace(/\{([^{}:\n]+)(?::(obj|poss|poss-pro|refl))?\}/g, (m, name: string, form?: string) => {
    const k = name.trim().toLowerCase();
    const id = twice.has(k) ? undefined : byName.get(k);
    return id ? `[[u:${id}${form ? `:${form}` : ""}]]` : m;
  });
}

/** "all", "none", or numbers (1-based, spaces or commas) → 0-based indexes. */
export function pickMany(answer: string, count: number): number[] {
  const a = answer.toLowerCase();
  if (!a || a === "none" || a === "n") return [];
  if (a === "all") return [...Array(count).keys()];
  const out = new Set<number>();
  for (const part of a.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > count) throw new Error(`${part} isn't in the list`);
    out.add(n - 1);
  }
  return [...out].sort((x, y) => x - y);
}

async function confirm(io: Io, question: string): Promise<boolean> {
  const a = (await io.ask(question)).trim().toLowerCase();
  return a === "y" || a === "yes";
}

/**
 * The line editor: the text numbered by line, edited in place in this
 * process. A number edits that line, `a` adds one at the end, `i N` inserts
 * before line N, `d N` deletes it, `s` saves and `q` leaves without saving.
 */
export async function editLines(io: Io, start: string[]): Promise<string[] | undefined> {
  const lines = [...start];
  const show = () => lines.forEach((l, i) => io.err(printable(`${String(i + 1).padStart(3)}  ${l}`)));
  show();
  io.err("A number edits that line; a adds a line, i N inserts before N, d N deletes N, p shows it again, s saves, q leaves.");
  for (;;) {
    const cmd = (await io.ask("edit> ")).trim();
    const [word, arg] = cmd.split(/\s+/);
    const n = Number(arg ?? word);
    const inRange = (x: number) => Number.isInteger(x) && x >= 1 && x <= lines.length;
    if (word === "s") return lines.join("\n") === start.join("\n") ? undefined : lines;
    if (word === "q") return undefined;
    if (word === "p") { show(); continue; }
    if (word === "a") { lines.push(await io.ask("+ ")); continue; }
    if (word === "i" && Number.isInteger(n) && n >= 1 && n <= lines.length + 1) { lines.splice(n - 1, 0, await io.ask("+ ")); continue; }
    if (word === "d" && inRange(n)) { lines.splice(n - 1, 1); continue; }
    if (arg === undefined && inRange(n)) { lines[n - 1] = await io.ask(`${n}: `, { initial: lines[n - 1] }); continue; }
    io.err("Type a line number, a, i N, d N, p, s or q.");
  }
}
