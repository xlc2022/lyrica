// CI wakes (docs/briefs/ci-wakes.md part A): the decide step. Given one poll's
// snapshot and the watch's last state, it says whether the thread gets a turn,
// with what note, and what state to save (principles 6 and 7). Pure: `now`
// comes in as an argument; polling, storage, guards and delivery live in the
// daemon.

import type { ForgeDecide, ForgeWakeNote, ForgeWatchState } from "./types.ts";

/** No checks reported this long after a head was observed: one note says so (brief step 5). */
const NO_CHECKS_WAIT_MS = 15 * 60_000;
/** The most notified heads and runs a watch remembers. */
const NOTIFIED_KEEP = 50;

/**
 * What a finished CI wake was about: the head and its finished checks. A re-run on the same head gives its checks
 * new IDs (GitHub) or new results (statuses), so it is new and wakes her again; the same finished set never does.
 */
function finishedKey(head: string, checks: { id: string; result: string }[]): string {
  let h = 0x811c9dc5;
  for (const c of [...checks].map((c) => `${c.id}=${c.result}`).sort().join("\n")) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `${head}:${h.toString(16)}`;
}

export const decideWatch: ForgeDecide = ({ number, account, now, last, poll }) => {
  // A token the API refuses ends the watch with one note saying why (brief step 8).
  if (poll.kind === "unreadable") {
    return { next: last, stop: true, note: { number, head: last.head, ci: null, reviews: [], tokenUnreadable: true } };
  }

  const pull = poll.pull;
  // Merged or closed ends the watch with one note, unless she merged it herself.
  if (pull.state !== "open") {
    const own = pull.state === "merged" && pull.mergedBy?.toLowerCase() === account.toLowerCase();
    return { next: last, stop: true, note: own ? null : { number, head: pull.head, ci: null, reviews: [], tokenUnreadable: false, ended: pull.state } };
  }

  // A new head — the first sight counts as one — starts the wait again.
  const headSince = last.head === pull.head ? last.headSince : now;

  // Notified keys: `<head>:<finished set>` for a finished CI wake and `<head>:none` for the no-checks note. A bare head
  // was saved before re-runs counted: it stands for whatever finished set the head has now, once.
  let ci: ForgeWakeNote["ci"] = null;
  let notified: string | undefined;
  const finished = pull.checks.length > 0 && pull.checks.every((c) => c.result !== null);
  if (finished) {
    const key = finishedKey(pull.head, pull.checks as { id: string; result: string }[]);
    const legacy = last.notifiedHeads.includes(pull.head) && !last.notifiedHeads.some((k) => k.startsWith(`${pull.head}:`));
    if (!last.notifiedHeads.includes(key)) {
      notified = key;
      if (!legacy) ci = { kind: "finished", checks: pull.checks.map((c) => ({ name: c.name, result: c.result! })) };
    }
  } else if (pull.checks.length === 0 && !last.notifiedHeads.includes(`${pull.head}:none`) && !last.notifiedHeads.includes(pull.head)
    && Date.parse(now) - Date.parse(headSince) >= NO_CHECKS_WAIT_MS) {
    ci = { kind: "noChecks" };
    notified = `${pull.head}:none`;
  }

  // Everything new since the last poll is one wake; her own events never are
  // (forge logins are case-insensitive). Counts group by author and kind —
  // comment text stays on the forge, for her to read there.
  const own = account.toLowerCase();
  const seen = new Set(last.seenReviews);
  const reviews: ForgeWakeNote["reviews"] = [];
  for (const r of pull.reviews) {
    if (r.author.toLowerCase() === own || seen.has(r.id)) continue;
    const group = reviews.find((g) => g.author === r.author && g.kind === r.kind);
    if (group) group.count += 1;
    else reviews.push({ author: r.author, kind: r.kind, count: 1 });
  }

  const note = ci === null && reviews.length === 0 ? null : { number, head: pull.head, ci, reviews, tokenUnreadable: false };
  const next: ForgeWatchState = {
    head: pull.head,
    headSince,
    notifiedHeads: notified === undefined ? last.notifiedHeads : [...last.notifiedHeads, notified].slice(-NOTIFIED_KEEP),
    // Every id in the snapshot is now handled, her own events included (types.ts).
    seenReviews: [...last.seenReviews, ...pull.reviews.map((r) => r.id).filter((id) => !seen.has(id))],
  };
  return { next, stop: false, note };
};
