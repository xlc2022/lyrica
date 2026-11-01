// A file renamed or moved in the Files panel keeps its links (docs/workspace.md, "Renaming keeps links"): each
// thread that can reach the file has its stored mentions of the old path rewritten as it writes them, its open
// session reopens on the new text at its next turn, and its open views reload their messages. Memories are respelled
// by sleep, from the renames kept here.
import { needles, pathRewriter, type PoolStore, type Respelling, type Workspace, type WorkspaceThread } from "@lyrica/core";
import { posix } from "node:path";

/** What changed in one thread: its first respelling, for the note her next turn gets. */
export interface Relinked { threadId: string; from: string; to: string }

/**
 * Rewrites the mentions in `t`'s family (the threads sharing its folder or its /shared), or, for a grant's file,
 * in every thread of the pool that names it. `from` and `to` are as `t` sees them.
 */
export function relinkFiles(workspace: Workspace, store: PoolStore, t: WorkspaceThread, from: string, to: string): Relinked[] {
  const settings = workspace.settings(t.userId);
  let candidates: string[];
  const grant = !workspace.originKey(t, from);
  if (!grant) candidates = settings.family(settings.familyRoot(t.threadId));
  else {
    const name = posix.basename(from);
    candidates = store.threadsMentioning([name, encodeURI(name)]);
  }
  const out: Relinked[] = [];
  // Memories wait for sleep, which respells those citing each thread (docs/sleep.md, "Renamed files").
  const ledger: { thread: string | null; swaps: Respelling[] }[] = grant ? [{ thread: null, swaps: [{ from: posix.normalize(from), to: posix.normalize(to) }] }] : [];
  for (const id of candidates) {
    if (!store.getThread(id)) continue;
    const swaps = workspace.respellings(t, from, to, { userId: t.userId, pool: t.pool, threadId: id });
    if (!swaps.length) continue;
    if (!grant) ledger.push({ thread: id, swaps });
    const changed = store.rewriteMentions(id, needles(swaps), pathRewriter(swaps));
    if (changed.entries.length || changed.draft) out.push({ threadId: id, from: swaps[0]!.from, to: swaps[0]!.to });
  }
  store.recordRename(ledger);
  return out;
}
