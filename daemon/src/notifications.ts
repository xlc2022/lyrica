// Notifications (DESIGN.md, "Where things are"): one list over everything
// waiting for the user, read from where each thing lives. Nothing is stored
// here; acting on an item changes its source, and the item goes.
import type { Pool, PoolStore, User } from "@lyrica/core";
import type * as Api from "./api.ts";
import { BUILD, type Lyricad } from "./lyricad.ts";
import { planWaits } from "./plan-waits.ts";
import { readUpdates } from "./updates.ts";

const POOLS: Pool[] = ["general", "private"];
const DETAIL = 160;
const TYPE_ORDER: Api.NotificationType[] = ["question", "permission", "limit", "share", "update", "approval", "suggestion", "sleep", "rollback"];
/** A failed probation is told for this long; Administration → Updates keeps it after. */
const ROLLBACK_DAYS = 7;

export interface NotificationQuery { type?: string; scope?: string; sort?: string; offset?: number; limit?: number }

/**
 * Everything waiting for the user, filtered, sorted and paged. `show` is the
 * user's display: a pool switched off, or a hidden thread while Show hidden is
 * off, contributes nothing, not even to the count (DESIGN.md: nothing on
 * screen says hidden content exists).
 */
export function notifications(d: Lyricad, user: User, show: Api.Display, q: NotificationQuery): Api.NotificationPage {
  const all = collect(d, user, show);
  const waiting = all.filter((n) => n.decision).length;
  const types = TYPE_ORDER.filter((t) => all.some((n) => n.type === t));
  let items = all;
  if (q.type === "decision") items = items.filter((n) => n.decision);
  else if (q.type) items = items.filter((n) => n.type === q.type);
  if (q.scope) items = items.filter((n) => n.scope === q.scope);
  const newest = (a: Api.Notification, b: Api.Notification) => b.at.localeCompare(a.at);
  items.sort(q.sort === "oldest" ? (a, b) => a.at.localeCompare(b.at)
    : q.sort === "type" ? (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || newest(a, b)
    : q.sort === "scope" ? (a, b) => a.scope.localeCompare(b.scope) || newest(a, b)
    : newest);
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(200, Math.max(0, q.limit ?? 50));
  return { items: items.slice(offset, offset + limit), total: items.length, waiting, types };
}

function collect(d: Lyricad, user: User, show: Api.Display): Api.Notification[] {
  const s = d.services!;
  const u = `/api/u/${encodeURIComponent(user.id)}`;
  const t = (pool: Pool, id: string) => `${u}/threads/${pool}/${encodeURIComponent(id)}`;
  const out: Api.Notification[] = [];
  const shownPool = (pool: Pool) => (pool === "general" ? show.showGeneral : show.showPrivate);
  const pools = POOLS.filter(shownPool);
  const o = s.memory.openOwnerView(user.id);
  try {
    const titleOf = (store: PoolStore, id: string) => store.getThread(id)?.title || "A new thread";
    /** A thread the display shows: its pool is on, and it isn't hidden while Show hidden is off. */
    const shownThread = (pool: Pool, id: string) => { const th = o[pool].getThread(id); return shownPool(pool) && !!th && (show.showHidden || !th.hidden); };
    // Threads shared with the user: add to a pool, or decline. A private thread goes to Private only.
    for (const sh of s.shares.forUser(user.id)) {
      if (!shownPool(sh.pool)) continue;
      const from = s.users.get(sh.from)?.profile.displayName ?? "Someone";
      const accept = (pool: Pool): Api.NotificationAction => ({ label: pool === "general" ? "Add to General" : "Add to Private", method: "POST", path: `${u}/shares/${sh.id}/accept`, body: { pool }, opens: true });
      out.push({
        id: `share:${sh.id}`, type: "share", title: `${from} shared “${sh.title ?? "a thread"}” with you`,
        detail: `${sh.entryCount} ${sh.entryCount === 1 ? "entry" : "entries"}, as it was when sent.`,
        scope: sh.pool, decision: true, at: sh.createdAt,
        actions: [
          ...(sh.pool === "private" ? [] : [accept("general")]),
          accept("private"),
          { label: "Decline", method: "DELETE", path: `${u}/shares/${sh.id}`, danger: true },
        ],
      });
    }
    // A thread waiting for an approval.
    for (const { pool, threadId, request } of s.host.pending(user.id)) {
      if (!shownThread(pool, threadId)) continue;
      const title = titleOf(o[pool], threadId);
      const path = `${t(pool, threadId)}/permissions/${encodeURIComponent(request.requestId)}`;
      out.push({
        id: `permission:${request.requestId}`, type: "permission",
        title: request.tool === "propose_plan" ? `${title} has a plan to approve` : `${title} wants to run ${request.tool}${request.machine ? ` on ${request.machine}` : ""}`,
        ...(detailOf(request.args) ? { detail: detailOf(request.args) } : {}),
        scope: pool, decision: true, thread: { pool, id: threadId }, at: new Date(new Date(request.expiresAt).getTime() - s.host.opts.permissionMs).toISOString(),
        actions: [{ label: "Allow", method: "POST", path, body: { allow: true } }, { label: "Deny", method: "POST", path, body: { allow: false }, danger: true }],
      });
    }
    // Question text is read from the encrypted tool call; the table holds only pointers.
    for (const pool of pools) for (const th of o[pool].listThreads({ includeHidden: true })) {
      if (!shownThread(pool, th.id)) continue;
      const q = o[pool].openQuestion(th.id);
      if (!q) continue;
      const ask = o[pool].readAsk(th.id, q.n);
      if (!ask) continue;
      const order = [ask.recommended, ...ask.options.map((_, i) => i).filter(i => i !== ask.recommended)];
      out.push({ id: `question:${pool}/${th.id}/${q.n}`, type: "question", title: ask.question,
        detail: ask.options[ask.recommended]!.consequence, scope: pool, decision: true,
        thread: { pool, id: th.id }, at: q.asked,
        actions: order.map(option => ({ label: ask.options[option]!.label, method: "POST", path: `${t(pool, th.id)}/questions/${q.n}/answer`, body: { option } })),
      });
    }
    // A child thread posted an update, or waits on the user.
    for (const c of s.children.updates(user.id)) {
      const th = o[c.pool].getThread(c.thread);
      if (!th || !shownThread(c.pool, c.thread)) continue;
      if (o[c.pool].openQuestion(c.thread)) continue;
      const title = th.title || "A child thread";
      const last = o[c.pool].lastEntry(c.thread);
      out.push({
        id: `update:${c.pool}/${c.thread}`, type: "update",
        title: c.needsYou ? `${title} is waiting on you` : `${title} posted ${c.unseen === 1 ? "an update" : `${c.unseen} updates`}`,
        ...(last?.text.trim() ? { detail: last.text.trim().slice(0, DETAIL) } : {}),
        scope: c.pool, decision: c.needsYou, thread: { pool: c.pool, id: c.thread }, at: last?.createdAt ?? th.createdAt,
        actions: c.needsYou ? [] : [{ label: "Dismiss", method: "POST", path: `${t(c.pool, c.thread)}/seen` }],
      });
    }
    // A plan out of usage: one item for the threads waiting for it, one for sleep, each offering to fall back until it resets.
    for (const w of planWaits(d, user.id)) {
      const fall: Api.NotificationAction = {
        label: "Fall back", method: "POST", path: `${u}/endpoints/${encodeURIComponent(w.endpointId)}/fall-back`,
        title: `Every thread and sleep waiting on ${w.name} uses its next model until it resets.`,
      };
      const threads = w.threads.filter((x) => shownThread(x.pool, x.thread)).map((x) => ({ pool: x.pool, id: x.thread, title: titleOf(o[x.pool], x.thread) }));
      if (threads.length) {
        out.push({
          id: `limit:${w.endpointId}/threads`, type: "limit",
          title: threads.length === 1 ? `${threads[0]!.title} waits for ${w.name}'s usage limit` : `${threads.length} threads wait for ${w.name}'s usage limit`,
          scope: threads.every((x) => x.pool === "private") ? "private" : "general", decision: true, until: w.until, at: w.until,
          ...(threads.length === 1 ? { thread: { pool: threads[0]!.pool, id: threads[0]!.id } } : { threads }),
          actions: [fall],
        });
      }
      for (const pool of w.sleep.filter(shownPool)) {
        out.push({ id: `limit:${w.endpointId}/sleep/${pool}`, type: "limit", title: `Sleep waits for ${w.name}'s usage limit`, scope: pool, decision: true, until: w.until, at: w.until, actions: [fall] });
      }
    }
    // Her items from the night, in the pools the display shows.
    for (const pool of pools) {
      for (const i of o[pool].listItems()) {
        // A persona item has its own suggestion or approval above, with the actions that count.
        if (i.thread || i.kind === "persona") continue;
        const path = `${u}/sleep/${pool}/items/${encodeURIComponent(i.id)}`;
        out.push({
          id: `sleep:${i.id}`, type: "sleep", title: i.text.length > DETAIL ? `${i.text.slice(0, DETAIL - 1)}…` : i.text,
          detail: i.kind === "question" ? "A question from sleep" : "Something from sleep",
          scope: pool, decision: true, at: i.createdAt,
          actions: [{ label: "Start a chat", method: "POST", path: `${path}/chat`, opens: true }, { label: "Dismiss", method: "DELETE", path }],
        });
      }
    }
    // Her suggested persona changes, for the user to send on.
    for (const dr of s.proposals.drafts(user.id)) {
      out.push({
        id: `suggestion:${dr.id}`, type: "suggestion", title: `A suggested change to ${dr.path}`, detail: dr.reason.slice(0, DETAIL),
        scope: "general", decision: true, section: "settings/suggestions", at: dr.createdAt,
        actions: [{ label: "Drop", method: "DELETE", path: `${u}/proposals/${dr.id}`, danger: true }],
      });
    }
    // Her skills waiting for approval, in the pools the display shows.
    for (const sk of pools.flatMap((p) => o[p].skills.all())) {
      if (sk.state !== "waiting") continue;
      const path = `${u}/skills/${sk.pool}/${encodeURIComponent(sk.name)}`;
      out.push({
        id: `skill:${sk.pool}/${sk.name}`, type: "suggestion", title: `A new skill: ${sk.name}`, detail: sk.description.slice(0, DETAIL),
        scope: sk.pool, decision: true, section: "settings/skills", ...(sk.thread ? { thread: { pool: sk.pool, id: sk.thread } } : {}), at: sk.at,
        actions: [{ label: "Approve", method: "POST", path: `${path}/approve` }, { label: "Decline", method: "POST", path: `${path}/decline`, danger: true }],
      });
    }
    // An update that failed its probation and was rolled back (administrators, for a week).
    if (user.admin) {
      const rb = readUpdates(d.updatePaths, { version: BUILD.version ?? "0", build: BUILD.build ?? "dev" }).lastRollback;
      if (rb?.automatic && Date.now() - new Date(rb.at).getTime() < ROLLBACK_DAYS * 864e5) {
        out.push({
          id: `rollback:${rb.at}`, type: "rollback", title: `Update ${rb.from.slice(0, 7)} rolled back${rb.check ? `: ${rb.check} failed` : ""}`,
          detail: `Running ${rb.to.slice(0, 7)} again${rb.restoredFrom ? ", with the snapshot from before it restored" : ""}.`,
          scope: "general", decision: false, section: "admin/updates", at: rb.at, actions: [],
        });
      }
    }
    // Persona changes sent on by users, for administrators to approve.
    if (user.admin) {
      for (const p of s.persona.proposals()) {
        // She writes every proposal (in her sleep); the user only sends it on, and an administrator's own goes straight here.
        const senderId = p.sentBy.replace(/^user:/, "");
        const by = senderId === user.id ? undefined : s.users.get(senderId)?.profile.displayName ?? "a user";
        const path = `${u}/admin/proposals/${p.id}`;
        out.push({
          id: `approval:${p.id}`, type: "approval", title: `${d.name()}'s change to ${p.path}${by ? `, sent on by ${by},` : ""} waits for approval`,
          detail: `${p.reason.slice(0, DETAIL)}${p.stale ? " The file has changed since." : ""}`,
          scope: "general", decision: true, section: "admin/persona", at: p.createdAt,
          actions: [
            ...(p.stale ? [] : [{ label: "Approve", method: "POST" as const, path, body: { approve: true } }]),
            { label: "Reject", method: "POST", path, body: { approve: false }, danger: true },
          ],
        });
      }
    }
  } finally {
    o.close();
  }
  return out;
}

/** The first string in a tool's arguments (a command, a path), shortened. */
function detailOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  for (const v of Object.values(args as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) return v.trim().length > DETAIL ? `${v.trim().slice(0, DETAIL - 1)}…` : v.trim();
  }
  return undefined;
}
