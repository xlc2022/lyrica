// Plans out of usage (docs/models.md, "Subscription plans"): a thread or a
// sleep run on a plan that reached its usage limit waits for the reset rather
// than falling back, unless the user chooses to fall back until then. Nothing
// is stored here: the threads come from their wake-ups, sleep from its waits.
// Claude Code's plan (the user's Claude plan, used only by Claude Code in her
// sandbox) has no endpoint: its limit is kept under `claudePlanId`, and a
// thread waits for it when the plan stopped one of its claude delegate runs.
import { isPlan, type Pool } from "@lyrica/core";
import { HttpError } from "./http.ts";
import type { Lyricad } from "./lyricad.ts";

/** `claudeCode`: the Claude plan, which only Claude Code uses; falling back hands its jobs to the coder role. */
export interface ThreadPlanWait { endpointId: string; name: string; until: string; next?: string; claudeCode?: true }
export interface PlanWait { endpointId: string; name: string; until: string; threads: { pool: Pool; thread: string }[]; sleep: Pool[]; claudeCode?: true }

/** Where the user's Claude plan's usage limit is kept among the plans' (`Models.reportPlanLimit`). */
export const claudePlanId = (userId: string) => `claude-code:${userId}`;
const CLAUDE_PLAN = "Claude Code";
/** What a claude run's job goes to while the user falls back from the Claude plan. */
const CLAUDE_NEXT = "the coder role";

/** The Claude plan's wait, while it is limited and the user hasn't fallen back. */
function claudeWait(d: Lyricad, userId: string): ThreadPlanWait | undefined {
  const { models } = d.services!;
  const id = claudePlanId(userId);
  const until = models.planLimitedUntil(id);
  if (until === undefined || models.planFallingBack(id)) return undefined;
  return { endpointId: id, name: CLAUDE_PLAN, until: new Date(until).toISOString(), next: CLAUDE_NEXT, claudeCode: true };
}

/** The limited plan a thread's conversation waits for, and the model it would use if the user fell back. */
export function threadPlanWait(d: Lyricad, userId: string, pool: Pool, thread: string): ThreadPlanWait | undefined {
  const { models, workspace, wakeups } = d.services!;
  const waits = wakeups.list(userId, pool, thread).filter((w) => w.planLimit);
  // A thread waiting only on its claude run waits on the Claude plan.
  if (waits.length && waits.every((w) => w.claudeCode)) return claudeWait(d, userId);
  const task = workspace.settings(userId).effective(thread).code ? "code" : "chat";
  const ctx = models.callContext(userId, pool, thread);
  let ep;
  try {
    ep = models.resolve(task, ctx).endpoint;
  } catch {
    return undefined;
  }
  const until = models.planLimitedUntil(ep.id);
  if (until === undefined || models.planFallingBack(ep.id)) return undefined;
  let next: string | undefined;
  try {
    next = models.resolve(task, ctx, {}, { except: new Set([ep.id]) }).label;
  } catch {
    // No other model in the list: falling back has nowhere to go.
  }
  return { endpointId: ep.id, name: ep.name, until: new Date(until).toISOString(), ...(next ? { next } : {}) };
}

/** Everything of the user's waiting for a plan to reset, by plan. */
export function planWaits(d: Lyricad, userId: string): PlanWait[] {
  const { models, wakeups, sleep } = d.services!;
  const by = new Map<string, PlanWait>();
  const of = (endpointId: string): PlanWait | undefined => {
    const until = models.planLimitedUntil(endpointId);
    const claude = endpointId === claudePlanId(userId);
    const name = claude ? CLAUDE_PLAN : models.endpoint(userId, endpointId)?.name;
    if (until === undefined || !name || models.planFallingBack(endpointId)) return undefined;
    let w = by.get(endpointId);
    if (!w) by.set(endpointId, w = { endpointId, name, until: new Date(until).toISOString(), threads: [], sleep: [], ...(claude ? { claudeCode: true as const } : {}) });
    return w;
  };
  const seen = new Set<string>();
  for (const { pool, thread } of wakeups.waitingForPlans(userId)) {
    if (seen.has(`${pool}/${thread}`)) continue;
    seen.add(`${pool}/${thread}`);
    const t = threadPlanWait(d, userId, pool, thread);
    if (t) of(t.endpointId)?.threads.push({ pool, thread });
  }
  for (const s of sleep.planWaits(userId)) of(s.endpointId)?.sleep.push(s.pool);
  return [...by.values()];
}

/** The user falls back from a limited plan until it resets: its waiting threads and sleep carry on now, on the next model. */
export function fallBack(d: Lyricad, userId: string, endpointId: string): void {
  const { models, wakeups, sleep } = d.services!;
  const claude = endpointId === claudePlanId(userId);
  if (!claude && !isPlan(models.endpoint(userId, endpointId)?.api)) throw new HttpError(404, "no such plan");
  const waiting = planWaits(d, userId).find((w) => w.endpointId === endpointId);
  if (!models.fallBackFromLimit(endpointId)) throw new HttpError(409, "this plan hasn't reached its usage limit");
  if (waiting) wakeups.resumeNow(userId, waiting.threads, claude);
  sleep.resumeWaiting();
}
