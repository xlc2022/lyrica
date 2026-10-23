// Plans out of usage (docs/models.md, "Subscription plans"): a thread or a
// sleep run on a plan that reached its usage limit waits for the reset rather
// than falling back, unless the user chooses to fall back until then. Nothing
// is stored here: the threads come from their wake-ups, sleep from its waits.
import { isPlan, type Pool } from "@lyrica/core";
import { HttpError } from "./http.ts";
import type { Lyricad } from "./lyricad.ts";

export interface ThreadPlanWait { endpointId: string; name: string; until: string; next?: string }
export interface PlanWait { endpointId: string; name: string; until: string; threads: { pool: Pool; thread: string }[]; sleep: Pool[] }

/** The limited plan a thread's conversation waits for, and the model it would use if the user fell back. */
export function threadPlanWait(d: Lyricad, userId: string, pool: Pool, thread: string): ThreadPlanWait | undefined {
  const { models, workspace } = d.services!;
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
    const ep = models.endpoint(userId, endpointId);
    if (until === undefined || !ep || models.planFallingBack(endpointId)) return undefined;
    let w = by.get(endpointId);
    if (!w) by.set(endpointId, w = { endpointId, name: ep.name, until: new Date(until).toISOString(), threads: [], sleep: [] });
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
  if (!isPlan(models.endpoint(userId, endpointId)?.api)) throw new HttpError(404, "no such plan");
  const waiting = planWaits(d, userId).find((w) => w.endpointId === endpointId);
  if (!models.fallBackFromLimit(endpointId)) throw new HttpError(409, "this plan hasn't reached its usage limit");
  if (waiting) wakeups.resumeNow(userId, waiting.threads);
  sleep.resumeWaiting();
}
