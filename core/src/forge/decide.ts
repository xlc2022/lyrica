// CI wakes (docs/briefs/ci-wakes.md part A): the decide step. Given one poll's
// snapshot and the watch's last state, it says whether the thread gets a turn,
// with what note, and what state to save (principles 6 and 7). Pure: `now`
// comes in as an argument; polling, storage, guards and delivery live in the
// daemon.

import type { ForgeDecide, ForgeWakeNote, ForgeWatchState } from "./types.ts";

/** No checks reported this long after a head was observed: one note says so (brief step 5). */
const NO_CHECKS_WAIT_MS = 15 * 60_000;

export const decideWatch: ForgeDecide = ({ number, account, now, last, poll }) => {
  // A token the API refuses ends the watch with one note saying why (brief step 8).
  if (poll.kind === "unreadable") {
    return { next: last, stop: true, note: { number, head: last.head, ci: null, reviews: [], tokenUnreadable: true } };
  }

  const pull = poll.pull;
  // Merged or closed ends the watch without a turn (brief step 7).
  if (pull.state !== "open") return { next: last, stop: true, note: null };

  // A new head — the first sight counts as one — starts the wait again.
  const headSince = last.head === pull.head ? last.headSince : now;
  const alreadyNotified = last.notifiedHeads.includes(pull.head);

  let ci: ForgeWakeNote["ci"] = null;
  if (!alreadyNotified) {
    const done = pull.checks.flatMap((c) => (c.result === null ? [] : [{ name: c.name, result: c.result }]));
    if (pull.checks.length > 0 && done.length === pull.checks.length) ci = { kind: "finished", checks: done };
    else if (pull.checks.length === 0 && Date.parse(now) - Date.parse(headSince) >= NO_CHECKS_WAIT_MS) ci = { kind: "noChecks" };
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
    notifiedHeads: ci === null ? last.notifiedHeads : [...last.notifiedHeads, pull.head],
    // Every id in the snapshot is now handled, her own events included (types.ts).
    seenReviews: [...last.seenReviews, ...pull.reviews.map((r) => r.id).filter((id) => !seen.has(id))],
  };
  return { next, stop: false, note };
};
