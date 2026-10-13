// Reading and rewriting the references in one database's lists: presets,
// thread choices, saved workflows and model groups.

import type { Db } from "../db.ts";
import type { Column, ModelRef, Pool, Task } from "../types.ts";

/** A preset's (or a column's) entry for a task: an ordered list, or another task's list. */
export type Entry = ModelRef[] | { same: Task };

/** Where a list names a model or a group. */
export type Use =
  | { where: "preset"; presetId: string; name: string; task: Task }
  | { where: "column"; column: Column; task: Task }
  | { where: "thread"; pool: Pool; threadId: string; task: Task }
  | { where: "workflow"; name: string }
  | { where: "group"; groupId: string; name: string };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export const refId = (r: ModelRef): string => ("offeringId" in r ? r.offeringId : r.groupId);
export const isList = (e: Entry | undefined): e is ModelRef[] => Array.isArray(e);

const hasTable = (db: Db, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** Every offering or group ID a database's lists name, with where. Saved workflows may name models by offering ID. */
export function collectRefs(db: Db): Map<string, Use[]> {
  const out = new Map<string, Use[]>();
  const add = (id: string, use: Use) => out.set(id, [...(out.get(id) ?? []), use]);
  if (hasTable(db, "model_presets")) {
    for (const r of db.prepare("SELECT id, name, entries FROM model_presets").all() as { id: string; name: string; entries: string }[]) {
      const table = JSON.parse(r.entries) as Record<string, Entry>;
      for (const [task, e] of Object.entries(table)) if (isList(e)) for (const ref of e) add(refId(ref), { where: "preset", presetId: r.id, name: r.name, task: task as Task });
    }
    for (const r of db.prepare("SELECT column, entries FROM model_columns").all() as { column: Column; entries: string }[]) {
      const table = JSON.parse(r.entries) as Record<string, Entry>;
      for (const [task, e] of Object.entries(table)) if (isList(e)) for (const ref of e) add(refId(ref), { where: "column", column: r.column, task: task as Task });
    }
  }
  if (hasTable(db, "thread_models")) {
    for (const r of db.prepare("SELECT pool, thread, task, entry FROM thread_models").all() as { pool: Pool; thread: string; task: Task; entry: string }[]) {
      for (const ref of JSON.parse(r.entry) as ModelRef[]) add(refId(ref), { where: "thread", pool: r.pool, threadId: r.thread, task: r.task });
    }
  }
  if (hasTable(db, "delegate_workflows")) {
    for (const r of db.prepare("SELECT name, spec FROM delegate_workflows").all() as { name: string; spec: string }[]) {
      for (const id of new Set(r.spec.match(UUID_G) ?? [])) add(id, { where: "workflow", name: r.name });
    }
  }
  for (const r of db.prepare("SELECT id, name, members FROM model_groups").all() as { id: string; name: string; members: string }[]) {
    for (const id of JSON.parse(r.members) as string[]) add(id, { where: "group", groupId: r.id, name: r.name });
  }
  return out;
}

/** A list through `map` (from → to, or null for removed): undefined if untouched, null if left empty. */
function mapList(list: ModelRef[], map: Map<string, string | null>, touched: (from: string) => void): ModelRef[] | null | undefined {
  if (!list.some((r) => map.has(refId(r)))) return undefined;
  const next: ModelRef[] = [];
  for (const r of list) {
    let to: string | null = refId(r);
    if (map.has(to)) { touched(to); to = map.get(to)!; }
    if (to && !next.some((n) => refId(n) === to)) next.push("groupId" in r ? { groupId: to } : { offeringId: to });
  }
  return next.length ? next : null;
}

/** A group's members through `map`. Returns the new list, or undefined if untouched. A group left empty stays, flagged in Clean up. */
export function mapMembers(members: string[], map: Map<string, string | null>): string[] | undefined {
  if (!members.some((m) => map.has(m))) return undefined;
  const next: string[] = [];
  for (const m of members) {
    const to = map.has(m) ? map.get(m)! : m;
    if (to && !next.includes(to)) next.push(to);
  }
  return next;
}

/** Saved settings follow a model to its replacement (which keeps its own if it has some); a removed model's go. */
export function moveSettings(db: Db, map: Map<string, string | null>): void {
  if (!hasTable(db, "offering_settings")) return;
  for (const [from, to] of map) {
    if (!db.prepare("SELECT 1 FROM offering_settings WHERE offering = ?").get(from)) continue;
    // When the target already has its own values, they stay and the source's are dropped: someone set them for that model.
    if (to && !db.prepare("SELECT 1 FROM offering_settings WHERE offering = ?").get(to)) db.prepare("UPDATE offering_settings SET offering = ? WHERE offering = ?").run(to, from);
    else db.prepare("DELETE FROM offering_settings WHERE offering = ?").run(from);
  }
}

/**
 * Rewrites a database's lists through `map`: presets, the two columns' Custom
 * entries, thread choices, saved workflows and groups. A list left empty is
 * cleared. Returns the lines for the user's notice.
 */
export function rewrite(db: Db, map: Map<string, string | null>, oldLabel: (id: string) => string, newLabel: (id: string) => string | undefined): string[] {
  const places = new Map<string, Set<string>>();
  const threads = new Map<string, Set<string>>();
  const note = (into: Map<string, Set<string>>, from: string, where: string) => into.set(from, (into.get(from) ?? new Set()).add(where));
  if (hasTable(db, "model_presets")) {
    const rewriteTable = (table: Record<string, Entry>, where: (task: string) => string): boolean => {
      let changed = false;
      for (const [task, e] of Object.entries(table)) {
        if (!isList(e)) continue;
        const next = mapList(e, map, (from) => note(places, from, where(task)));
        if (next === null) { delete table[task]; changed = true; }
        else if (next) { table[task] = next; changed = true; }
      }
      return changed;
    };
    const savePreset = db.prepare("UPDATE model_presets SET entries = ? WHERE id = ?");
    for (const r of db.prepare("SELECT id, name, entries FROM model_presets").all() as { id: string; name: string; entries: string }[]) {
      const table = JSON.parse(r.entries) as Record<string, Entry>;
      if (rewriteTable(table, (task) => `the ${r.name} preset's ${task}`)) savePreset.run(JSON.stringify(table), r.id);
    }
    const saveColumn = db.prepare("UPDATE model_columns SET entries = ? WHERE column = ?");
    for (const r of db.prepare("SELECT column, entries FROM model_columns").all() as { column: string; entries: string }[]) {
      const table = JSON.parse(r.entries) as Record<string, Entry>;
      if (rewriteTable(table, (task) => `the ${r.column} column's ${task}`)) saveColumn.run(JSON.stringify(table), r.column);
    }
  }
  if (hasTable(db, "thread_models")) {
    for (const r of db.prepare("SELECT pool, thread, task, entry FROM thread_models").all() as { pool: string; thread: string; task: string; entry: string }[]) {
      const next = mapList(JSON.parse(r.entry), map, (from) => note(threads, from, `${r.pool}/${r.thread}`));
      if (next === null) db.prepare("DELETE FROM thread_models WHERE pool = ? AND thread = ? AND task = ?").run(r.pool, r.thread, r.task);
      else if (next) db.prepare("UPDATE thread_models SET entry = ? WHERE pool = ? AND thread = ? AND task = ?").run(JSON.stringify(next), r.pool, r.thread, r.task);
    }
  }
  if (hasTable(db, "delegate_workflows")) {
    for (const r of db.prepare("SELECT name, spec FROM delegate_workflows").all() as { name: string; spec: string }[]) {
      const ids = (r.spec.match(UUID_G) ?? []).filter((id) => map.has(id));
      if (!ids.length) continue;
      for (const id of ids) note(places, id, `the workflow ${r.name}`);
      db.prepare("UPDATE delegate_workflows SET spec = ? WHERE name = ?").run(JSON.stringify(rewriteSpec(JSON.parse(r.spec), map)), r.name);
    }
  }
  for (const r of db.prepare("SELECT id, name, members FROM model_groups").all() as { id: string; name: string; members: string }[]) {
    const members = JSON.parse(r.members) as string[];
    const next = mapMembers(members, map);
    if (!next) continue;
    for (const m of members) if (map.has(m)) note(places, m, `the group ${r.name}`);
    db.prepare("UPDATE model_groups SET members = ? WHERE id = ?").run(JSON.stringify(next), r.id);
  }
  moveSettings(db, map);
  const lines: string[] = [];
  for (const [from, to] of map) {
    const where = [...(places.get(from) ?? [])];
    const n = threads.get(from)?.size ?? 0;
    if (n) where.push(n === 1 ? "one thread" : `${n} threads`);
    if (!where.length) continue;
    lines.push(`${oldLabel(from)} ${to ? `was replaced by ${newLabel(to) ?? "another model"}` : "was removed"} in ${where.join(", ")}.`);
  }
  return lines;
}

/** A workflow's model names through `map`: a removed model is dropped, so its step uses its tier. */
function rewriteSpec(spec: unknown, map: Map<string, string | null>): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== null && x !== undefined);
    if (!v || typeof v !== "object") return typeof v === "string" && UUID.test(v) && map.has(v) ? map.get(v) : v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]).filter(([, x]) => x !== null && x !== undefined));
  };
  return walk(spec);
}
