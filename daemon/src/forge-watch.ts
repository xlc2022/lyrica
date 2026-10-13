// CI wakes (docs/briefs/ci-wakes.md part B): the poller. The relay's record
// (Workspace.onPullCreate) stores a watch in the thread's pool; lyricad's tick
// polls each unlocked user's watches through their account's forge API, turns
// the pages into one snapshot with the pure forge modules, decides, and hands
// the note to the wake-up path (principles 6 and 7). It stays inside rate
// limits: one request at a time per token, Retry-After and x-ratelimit-reset
// honoured, and ten-minute polling once a token is low or a repository is
// webhooked. Nothing here logs a body.

import {
  decideWatch, forgejoPullRequest, githubPullRequest,
  type ForgeKind, type ForgePollResult, type ForgePullRequest, type ForgeWakeNote, type ForgeWatchState,
  type Memory, type Pool, type Watch, type Workspace,
} from "@lyrica/core";
import type { Wakeups } from "./wakeups.ts";

export interface ForgeWatchOptions {
  memory: Memory;
  workspace: Workspace;
  wakeups: Wakeups;
  /** Failure names only, never a body or a note. */
  log: (line: string) => void;
}

/** One account as the poller sees it: its stored config, read fresh each poll. */
interface Account {
  /** The account config name, the rate and cache key. */
  name: string;
  kind: ForgeKind;
  host: string;
  /** The forge login, for decideWatch's own-account exclusion. */
  account: string;
  token: string;
}

interface Rate { waitUntil: number; remaining?: number; limit?: number; resetAt?: number }
interface Cached { etag: string; body: unknown }

const POLL_MS = 2 * 60_000;
const EASY_MS = 10 * 60_000;
const WEBHOOK_WINDOW_MS = 24 * 60 * 60_000;
const MAX_WATCHES = 10;
const MAX_BACKOFF_MS = 24 * 60 * 60_000;
const PAGE = 100;

/** GitHub's next page, from a Link header; undefined on the last page. */
function nextLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
  if (!m) return undefined;
  const u = new URL(m[1]!);
  return `${u.pathname}${u.search}`;
}

/** How long a 429 (or exhausted rate limit) asks to wait before the next request. */
function retryAfterMs(res: Response): number {
  const retry = res.headers.get("retry-after");
  if (retry !== null) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    const at = Date.parse(retry);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), MAX_BACKOFF_MS);
  }
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset)) return Math.min(Math.max(0, reset * 1000 - Date.now()), MAX_BACKOFF_MS);
  return 60_000;
}

/** The head SHA a pull body names, so the checks calls go to the right commit. */
function headOf(body: unknown): string {
  const pull = body as { head?: unknown } | null;
  const head = typeof pull === "object" && pull ? pull.head : undefined;
  const sha = typeof head === "object" && head ? (head as { sha?: unknown }).sha : undefined;
  if (typeof sha !== "string" || sha === "") throw new Error("the pull request has no head sha");
  return sha;
}

function kindWord(kind: ForgeWakeNote["reviews"][number]["kind"]): string {
  switch (kind) {
    case "approved": return "approved";
    case "changesRequested": return "requested changes";
    case "commented": return "commented";
    case "reviewComment": return "left review comments";
    case "comment": return "commented";
  }
}

/** The one metadata-only note for a thread, matching the shape the wake-up path expects. */
function renderNote(n: ForgeWakeNote): string {
  const head = n.head ? n.head.slice(0, 7) : "";
  const pr = `PR #${n.number}${head ? ` (${head})` : ""}`;
  if (n.tokenUnreadable) return `${pr}: the account's token can't read the checks, so I've stopped watching.`;
  const parts: string[] = [];
  if (n.ci?.kind === "finished") parts.push(`checks finished — ${n.ci.checks.map((c) => `${c.name}: ${c.result}`).join(", ")}`);
  else if (n.ci?.kind === "noChecks") parts.push("no checks reported 15 minutes after the head commit");
  if (n.reviews.length) parts.push(n.reviews.map((g) => `${g.author} ${kindWord(g.kind)}${g.count > 1 ? ` (${g.count})` : ""}`).join(", "));
  return `${pr}: ${parts.join("; ")}.`;
}

export class ForgeWatcher {
  /** Unlocked users whose watches are polled. */
  private readonly unlocked = new Set<string>();
  /** When each watch was last polled, by `user/pool/id`. */
  private readonly lastPoll = new Map<string, number>();
  /** One request at a time per token, and what the last answer asked for. */
  private readonly chain = new Map<string, Promise<unknown>>();
  private readonly rate = new Map<string, Rate>();
  /** GitHub's last ETag and body per path, in memory only, so unchanged pages cost no rate limit. */
  private readonly cache = new Map<string, Cached>();
  /** Threads already told about the eleventh pull request, by `user/pool/thread`. */
  private readonly toldFull = new Set<string>();
  private running = false;

  constructor(private readonly o: ForgeWatchOptions) {}

  load(userId: string): void { this.unlocked.add(userId); }

  /** At Lock: their watches leave memory; the pool keeps them. */
  drop(userId: string): void {
    this.unlocked.delete(userId);
    for (const k of [...this.lastPoll.keys()]) if (k.startsWith(`${userId}/`)) this.lastPoll.delete(k);
    for (const k of [...this.rate.keys()]) if (k.startsWith(`${userId}/`)) this.rate.delete(k);
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${userId}/`)) this.cache.delete(k);
  }

  /**
   * The relay's record: a run of `threadId` opened a pull request. Store a
   * watch for it in the thread's pool. At most 10 per thread; an eleventh is
   * not watched and the thread is told once.
   */
  record(userId: string, pool: Pool, threadId: string, repo: string, number: number): void {
    const s = this.o.workspace.settings(userId);
    const r = s.effective(threadId).repositories.find((x) => x.name === repo);
    if (!r) return;
    const a = s.gitAccount(r.account);
    if (!a || (a.kind !== "github" && a.kind !== "forgejo" && a.kind !== "gitea")) return; // "other" isn't watched
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      const own = view.own;
      if (own.watches(threadId).length >= MAX_WATCHES) {
        const key = `${userId}/${pool}/${threadId}`;
        if (this.toldFull.has(key)) return;
        this.toldFull.add(key);
        const id = own.addWakeup(threadId, new Date().toISOString(), `You've opened more than ${MAX_WATCHES} pull requests; #${number} (${repo}) isn't watched.`, new Date().toISOString());
        this.o.wakeups.wake(userId, pool, threadId, id);
        return;
      }
      own.addWatch(threadId, { repo, kind: a.kind, host: a.host, account: a.name, number });
    } finally {
      view.close();
    }
  }

  /** lyricad's tick: polls each unlocked user's due watches. */
  tick(now = new Date()): void {
    if (this.running) return;
    this.running = true;
    void (async () => {
      try {
        for (const userId of [...this.unlocked]) {
          for (const pool of ["general", "private"] as const) await this.pollPool(userId, pool, now);
        }
      } catch (err) {
        this.o.log(`a forge poll round failed: ${(err as Error).name}`);
      } finally {
        this.running = false;
      }
    })();
  }

  /** A signed webhook: nudge that repository's watches at once, and ease them to ten minutes. */
  async webhook(userId: string, accountName: string, repo: string, now = new Date()): Promise<void> {
    const a = this.o.workspace.settings(userId).gitAccount(accountName);
    if (!a || (a.kind !== "forgejo" && a.kind !== "gitea")) return;
    const view = this.o.memory.openThreadView(userId, a.pool);
    const due: Watch[] = [];
    try {
      for (const w of view.own.watches()) {
        if (w.account === accountName && w.repo === repo) {
          due.push(w);
          view.own.markWatchWebhook(w.id, now.toISOString());
        }
      }
    } finally {
      view.close();
    }
    for (const w of due) await this.pollOne(userId, a.pool, w, now, true);
  }

  private async pollPool(userId: string, pool: Pool, now: Date): Promise<void> {
    const view = this.o.memory.openThreadView(userId, pool);
    let watches: Watch[];
    try {
      watches = view.own.watches();
    } catch {
      return; // locked mid-tick
    } finally {
      view.close();
    }
    for (const w of watches) await this.pollOne(userId, pool, w, now);
  }

  private accountFor(userId: string, w: Watch): Account | undefined {
    const a = this.o.workspace.settings(userId).gitAccount(w.account);
    if (!a || (a.kind !== "github" && a.kind !== "forgejo" && a.kind !== "gitea")) return undefined;
    return { name: a.name, kind: a.kind, host: a.host, account: a.account, token: a.token };
  }

  private intervalFor(userId: string, w: Watch, nowMs: number): number {
    const rate = this.rate.get(`${userId}/${w.account}`);
    if (rate?.remaining !== undefined && rate.limit !== undefined && rate.limit > 0 && rate.remaining < rate.limit / 5) return EASY_MS;
    if (w.webhookAt && nowMs - Date.parse(w.webhookAt) < WEBHOOK_WINDOW_MS) return EASY_MS;
    return POLL_MS;
  }

  private async pollOne(userId: string, pool: Pool, w: Watch, now: Date, force = false): Promise<void> {
    const id = `${userId}/${pool}/${w.id}`;
    const last = this.lastPoll.get(id) ?? 0;
    if (!force && now.getTime() - last < this.intervalFor(userId, w, now.getTime())) return;
    const a = this.accountFor(userId, w);
    if (!a) return;
    const key = `${userId}/${a.name}`;
    const rate = this.rate.get(key);
    if (rate && now.getTime() < rate.waitUntil) return;
    if (!(await this.o.workspace.forgeAccountUsable(userId, a.name))) return;
    let poll: ForgePollResult;
    try {
      poll = await this.snapshot(key, a, w);
    } catch (err) {
      this.o.log(`a forge poll of ${w.repo}#${w.number} failed: ${(err as Error).name}`); // transient; keep watching
      return;
    }
    const lastState: ForgeWatchState = { head: w.head, headSince: w.headSince, notifiedHeads: w.notifiedHeads, seenReviews: w.seenReviews };
    const out = decideWatch({ number: w.number, account: a.account, now: now.toISOString(), last: lastState, poll });
    const note = out.note ? renderNote(out.note) : null;
    const view = this.o.memory.openThreadView(userId, pool);
    let wakeId: number | undefined;
    try {
      wakeId = view.own.settleWatch(w.id, out.next, out.stop, note ? { thread: w.thread, dueAt: now.toISOString(), text: note } : null);
    } catch (err) {
      this.o.log(`a forge poll of ${w.repo}#${w.number} couldn't be saved: ${(err as Error).name}`);
      return;
    } finally {
      view.close();
    }
    if (wakeId !== undefined) this.o.wakeups.wake(userId, pool, w.thread, wakeId, now);
    this.lastPoll.set(id, now.getTime());
  }

  /** All of one watch's API pages, joined into the shape the pure module wants. */
  private async snapshot(key: string, a: Account, w: Watch): Promise<ForgePollResult> {
    const pull = await this.api(key, a, `/repos/${w.repo}/pulls/${w.number}`);
    if (pull.status === 401 || pull.status === 403 || pull.status === 404) return { kind: "unreadable", status: pull.status };
    if (pull.status !== 200 || pull.body === undefined) throw new Error(`the pull request answered ${pull.status}`);
    const sha = headOf(pull.body);
    if (a.kind === "github") {
      const checkRuns = await this.githubPages(key, a, `/repos/${w.repo}/commits/${sha}/check-runs`);
      const statuses = await this.githubPages(key, a, `/repos/${w.repo}/commits/${sha}/status`);
      const reviews = await this.githubPages(key, a, `/repos/${w.repo}/pulls/${w.number}/reviews`);
      const reviewComments = await this.githubPages(key, a, `/repos/${w.repo}/pulls/${w.number}/comments`);
      const issueComments = await this.githubPages(key, a, `/repos/${w.repo}/issues/${w.number}/comments`);
      return { kind: "snapshot", pull: githubPullRequest({ pull: pull.body, checkRuns: { check_runs: checkRuns }, status: { statuses }, reviews, reviewComments, issueComments }) };
    }
    const status = await this.api(key, a, `/repos/${w.repo}/commits/${sha}/status`);
    if (status.status !== 200 || status.body === undefined) throw new Error(`the combined status answered ${status.status}`);
    const reviews = await this.forgejoPages(key, a, `/repos/${w.repo}/pulls/${w.number}/reviews`);
    const comments = await this.forgejoPages(key, a, `/repos/${w.repo}/issues/${w.number}/comments`);
    return { kind: "snapshot", pull: forgejoPullRequest(a.kind, { pull: pull.body, status: status.body, reviews, comments }) };
  }

  /** GitHub pages joined by their Link header; a page is a list or an object with `check_runs`/`statuses`. */
  private async githubPages(key: string, a: Account, path: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let url: string | undefined = `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE}`;
    for (let i = 0; url && i < 200; i++) {
      const res = await this.api(key, a, url);
      if (res.status !== 200 || res.body === undefined) throw new Error(`GitHub answered ${res.status}`);
      if (Array.isArray(res.body)) out.push(...res.body);
      else {
        const obj = res.body as { check_runs?: unknown; statuses?: unknown };
        const page = obj.check_runs ?? obj.statuses;
        if (Array.isArray(page)) out.push(...page);
      }
      url = nextLink(res.link);
    }
    return out;
  }

  /** Forgejo/Gitea pages by `page` and `limit`; a short page is the last. */
  private async forgejoPages(key: string, a: Account, path: string): Promise<unknown[]> {
    const out: unknown[] = [];
    const limit = 50;
    for (let page = 1; page <= 200; page++) {
      const res = await this.api(key, a, `${path}${path.includes("?") ? "&" : "?"}page=${page}&limit=${limit}`);
      if (res.status !== 200 || res.body === undefined) throw new Error(`the forge answered ${res.status}`);
      if (!Array.isArray(res.body)) throw new Error("the forge's list isn't a list");
      out.push(...res.body);
      if (res.body.length < limit) break;
    }
    return out;
  }

  /** One request, serialized per account, honouring Retry-After and ETag. */
  private api(key: string, a: Account, path: string): Promise<{ status: number; body?: unknown; link?: string }> {
    return this.enqueue(key, async () => {
      const rate = this.rate.get(key);
      if (rate && Date.now() < rate.waitUntil) return { status: 0 };
      const { base, authorization } = this.o.workspace.forgeBase(a);
      const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "lyrica", Authorization: authorization };
      const cached = a.kind === "github" ? this.cache.get(`${key}/${path}`) : undefined;
      if (cached) headers["If-None-Match"] = cached.etag;
      let res: Response;
      try {
        res = await this.o.workspace.forgeFetch()(`${base}${path}`, { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
      } catch {
        return { status: 0 };
      }
      this.noteRate(key, res);
      if (res.status === 304 && cached) return { status: 200, body: cached.body };
      if (res.status === 304) return { status: 304 };
      let body: unknown;
      if (res.status !== 204) {
        try { body = await res.json(); } catch { body = undefined; }
      }
      const etag = res.headers.get("etag");
      if (a.kind === "github" && etag && res.status === 200) this.cache.set(`${key}/${path}`, { etag, body });
      return { status: res.status, body, link: res.headers.get("link") ?? undefined };
    });
  }

  /** Remembers what a response said about the token's rate limit. */
  private noteRate(key: string, res: Response): void {
    const prev = this.rate.get(key) ?? { waitUntil: 0 };
    const next: Rate = { ...prev };
    // An answer without a header says nothing: it must not overwrite what the last one reported (a missing header is null, and Number(null) is 0).
    const remaining = res.headers.get("x-ratelimit-remaining");
    const limit = res.headers.get("x-ratelimit-limit");
    const reset = res.headers.get("x-ratelimit-reset");
    if (remaining !== null && Number.isFinite(Number(remaining))) next.remaining = Number(remaining);
    if (limit !== null && Number.isFinite(Number(limit))) next.limit = Number(limit);
    if (reset !== null && Number.isFinite(Number(reset))) next.resetAt = Number(reset) * 1000;
    if (res.status === 429) next.waitUntil = Date.now() + retryAfterMs(res);
    else if (next.remaining === 0 && next.resetAt !== undefined && next.resetAt > Date.now()) next.waitUntil = next.resetAt;
    this.rate.set(key, next);
  }

  /** One request at a time per token, in arrival order. */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.chain.get(key) ?? Promise.resolve()) as Promise<unknown>;
    const next = prev.then(fn, fn);
    this.chain.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}
