import { posix } from "node:path";
import { sha256, type ExecutionTarget, type FileChange, type FileChanges, type Grant, type Pool, type PoolStore } from "@lyrica/core";
import type { RemovalPlan } from "./api.ts";

// What removing turns leaves behind, and undoing it: files her write and edit
// calls made or changed (deleted or put back, unless something changed them
// since), uploads only the removed messages mention, git branches made in
// those turns, and the commands they ran (listed, not tracked).

/** What the plan reads, gathered from the store first: the removed entries, and where its tools run. */
export interface RemovalContext {
  pool: Pool;
  thread: string;
  /** The thread's entries from where the removal starts. */
  removed: Entry[];
  /** Subagent threads started in the removed turns, and theirs, with their runs and entries. */
  subagents: { thread: string; run?: string; entries: Entry[] }[];
  /** How many removed entries are pinned. */
  pins: number;
  /** Uploads the removed messages mention that a kept entry mentions too: they stay. */
  uploadsKept: Set<string>;
  changes: FileChanges;
  /** The thread's tools' target now, or undefined when it can't be reached (locked home). */
  target: ExecutionTarget | undefined;
  grants: Grant[];
}

export interface Entry { n: number; data: unknown }

interface ToolCall { id: string; name: string; args: Record<string, unknown> }

const COMMANDS_SHOWN = 20;
const UPLOAD = /\/workspace\/uploads\/[^\s"'`<>()[\]]+/g;
const NEW_BRANCH = /(?:^|[;&|]\s*|&&\s*)(?:cd\s+(\S+)\s*&&\s*)?git\s+(?:-C\s+(\S+)\s+)?(?:checkout\s+-b|switch\s+-c|branch)\s+([\w./-]+)/g;

/** Everything a removal from entry `from` would undo, with what's ticked by default. Reads files; changes nothing. */
export async function removalPlan(c: RemovalContext): Promise<RemovalPlan & { changes: FileChange[] }> {
  const removed = c.removed;
  const calls = [...removed.flatMap(toolCalls), ...c.subagents.flatMap((s) => s.entries.flatMap(toolCalls))];
  const changes = [
    ...c.changes.forCalls(c.pool, c.thread, calls.map((x) => x.id)),
    ...c.subagents.flatMap((s) => c.changes.forThreads(c.pool, [s.thread])),
  ];
  const plan: RemovalPlan = {
    messages: removed.length,
    pins: c.pins,
    subagents: c.subagents.length,
    files: [], branches: [], commands: [],
  };
  const commands = calls.filter((x) => x.name === "bash" && typeof x.args.command === "string").map((x) => String(x.args.command));
  plan.commands = commands.slice(0, COMMANDS_SHOWN).map((t) => (t.length > 200 ? `${t.slice(0, 200)}…` : t));
  if (!c.target) {
    plan.files = [...new Set(changes.map((ch) => ch.path))].map((path) => ({ id: fileId("?", path), path, action: "keep" as const, reason: "unreachable" as const, ticked: false }));
    return { ...plan, changes };
  }
  const target = c.target;

  // Files: the first change says what the file was before; the last, what she left.
  const byFile = new Map<string, FileChange[]>();
  for (const ch of changes) byFile.set(fileId(ch.target, ch.path), [...(byFile.get(fileId(ch.target, ch.path)) ?? []), ch]);
  for (const [id, list] of byFile) {
    const first = list[0]!;
    const last = list.at(-1)!;
    if (first.target !== target.name) { plan.files.push({ id, path: first.path, action: "keep", reason: "unreachable", ticked: false }); continue; }
    const now = await target.ops().read.readFile(first.path).catch(() => undefined);
    if (!now && first.created) continue; // already gone
    if (!now || sha256(now) !== last.hashAfter) { plan.files.push({ id, path: first.path, action: "keep", reason: "changed since", ticked: false }); continue; }
    plan.files.push({ id, path: first.path, action: first.created ? "delete" : "restore", ticked: true });
  }

  // Uploads that only the removed messages mention.
  if (target.name === "sandbox") {
    for (const path of uploadsIn(removed)) {
      if (c.uploadsKept.has(path)) continue;
      if (!(await target.ops().read.readFile(path).then(() => true, () => false))) continue;
      plan.files.push({ id: fileId("upload", path), path, action: "delete", reason: "upload", ticked: true });
    }
  }

  // Branches: made by her commands, or her subagents' worktree branches.
  const cwd = await target.cwd();
  const candidates: { repo: string; pattern: string }[] = [];
  for (const cmd of commands) {
    for (const m of cmd.matchAll(NEW_BRANCH)) {
      const dir = m[2] ?? m[1];
      candidates.push({ repo: dir ? posix.resolve(cwd, dir.replace(/^["']|["']$/g, "")) : cwd, pattern: m[3]! });
    }
  }
  const repos = c.grants.filter((g) => g.writable).map((g) => g.path);
  for (const s of c.subagents) if (s.run) for (const repo of repos) candidates.push({ repo, pattern: `lyrica/${s.run}-*` });
  const seen = new Set<string>();
  for (const { repo, pattern } of candidates) {
    for (const branch of await listBranches(target, repo, pattern)) {
      const id = `branch:${repo}:${branch}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const commits = await ownCommits(target, repo, branch);
      plan.branches.push({ id, repo, branch, commits, ticked: !commits });
    }
  }
  return { ...plan, changes };
}

/** Applies the plan's items that are ticked, minus those in `skip`. Returns how many files and branches it undid. */
export async function applyRemoval(plan: RemovalPlan & { changes: FileChange[] }, target: ExecutionTarget | undefined, changes: FileChanges, skip: Set<string>): Promise<{ files: number; branches: number }> {
  let files = 0;
  let branches = 0;
  if (target) {
    for (const f of plan.files) {
      if (!f.ticked || skip.has(f.id)) continue;
      try {
        if (f.action === "delete") {
          if ((await sh(target, `rm -f -- ${quote(f.path)}`)).ok) files++;
        } else if (f.action === "restore") {
          const first = plan.changes.find((ch) => fileId(ch.target, ch.path) === f.id);
          if (!first?.snapshot) continue;
          await target.ops().write.writeFile(f.path, changes.snapshot(first.snapshot));
          files++;
        }
      } catch { /* left as it is */ }
    }
    for (const b of plan.branches) {
      if (!b.ticked || skip.has(b.id)) continue;
      if ((await sh(target, `git -c core.hooksPath=/dev/null -C ${quote(b.repo)} branch -D -- ${quote(b.branch)}`)).ok) branches++;
    }
  }
  // The turns are gone, so their records are settled.
  changes.forget(plan.changes.map((ch) => ch.id));
  return { files, branches };
}

const fileId = (target: string, path: string) => `file:${target}:${path}`;

/** The entries of a thread from entry `from` on. */
export function entriesFrom(store: PoolStore, thread: string, from: number): Entry[] {
  return store.entryPage(thread, { limit: 1_000_000 }).entries.filter((e) => e.n >= from);
}

/** The uploads the user's messages among `entries` mention. */
export function uploadsIn(entries: Entry[]): Set<string> {
  return new Set(entries.filter((e) => role(e.data) === "user").flatMap((e) => textOf(e.data).match(UPLOAD) ?? []));
}

function role(data: unknown): string | undefined {
  return (data as { type?: string; message?: { role?: string } }).type === "message" ? (data as { message: { role: string } }).message.role : undefined;
}

function textOf(data: unknown): string {
  const c = (data as { message?: { content?: unknown } }).message?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.filter((p: { type?: string }) => p.type === "text").map((p: { text?: string }) => p.text ?? "").join("\n") : "";
}

function toolCalls(e: { data: unknown }): ToolCall[] {
  if (role(e.data) !== "assistant") return [];
  const c = (e.data as { message: { content?: unknown } }).message.content;
  if (!Array.isArray(c)) return [];
  return c.filter((p: { type?: string; id?: unknown }) => p.type === "toolCall" && typeof p.id === "string")
    .map((p: { id: string; name?: string; arguments?: unknown }) => ({ id: p.id, name: p.name ?? "", args: (p.arguments ?? {}) as Record<string, unknown> }));
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

async function sh(target: ExecutionTarget, command: string): Promise<{ ok: boolean; out: string }> {
  const chunks: Buffer[] = [];
  try {
    const { exitCode } = await target.ops().bash.exec(command, await target.cwd(), { onData: (d) => chunks.push(d), timeout: 60 });
    return { ok: exitCode === 0, out: Buffer.concat(chunks).toString() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Local branches of `repo` matching a name or a `refs/heads` glob. Marked lines, since a networked sandbox may add its own. */
async function listBranches(target: ExecutionTarget, repo: string, pattern: string): Promise<string[]> {
  const r = await sh(target, `git -C ${quote(repo)} for-each-ref --format='BRANCH=%(refname:short)' ${quote(`refs/heads/${pattern}`)}`);
  if (!r.ok) return [];
  return [...r.out.matchAll(/^BRANCH=(.+)$/gm)].map((m) => m[1]!);
}

/** Whether a branch has commits no other local branch has. Unsure counts as yes, so it isn't ticked. */
async function ownCommits(target: ExecutionTarget, repo: string, branch: string): Promise<boolean> {
  const r = await sh(target, `c=$(git -C ${quote(repo)} rev-list --max-count=1 ${quote(`refs/heads/${branch}`)} --not --exclude=${quote(`refs/heads/${branch}`)} --branches) && echo "COMMITS=$c"`);
  const m = /^COMMITS=(.*)$/m.exec(r.out);
  return !r.ok || !m || m[1]!.trim() !== "";
}
