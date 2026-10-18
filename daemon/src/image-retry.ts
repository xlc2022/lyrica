// Principles 1 and 2: retry only a stored refusal, with today's routing and portrait rules.
import type { Models, Need, PoolView, Workspace } from "@lyrica/core";
import type { executeImage } from "@lyrica/extension";
import type { ImageRetryOptions } from "./api.ts";
import { HttpError } from "./http.ts";
import { toMessages } from "./messages.ts";

export async function imageRetryOptions(models: Models, workspace: Workspace, view: PoolView, userId: string,
  pool: "general" | "private", threadId: string, toolCallId: string) {
  let before: number | undefined;
  const entries: Parameters<typeof toMessages>[2] = [];
  for (;;) {
    const page = view.own.entryPage(threadId, { before, limit: 200 });
    entries.unshift(...page.entries);
    if (!page.hasMore) break;
    before = page.entries[0]!.n;
  }
  const messages = toMessages(threadId, pool, entries);
  const part = messages.flatMap(m => m.parts.map(p => ({ m, p }))).find(({ p }) => p.type === "tool" && p.toolCallId === toolCallId);
  if (!part || part.p.type !== "tool" || part.p.name !== "image" || !part.p.imageRefusal) throw new HttpError(404, "no stored image refusal");
  const source = part.m;
  const args = part.p.args as Parameters<typeof executeImage>[2];
  const refusal = part.p.imageRefusal;
  const ctx = models.callContext(userId, pool, threadId);
  const settings = workspace.settings(userId);
  const files = workspace.imageFiles({ userId, pool, threadId });
  const paths = [...args.references ?? [], ...(args.image ? [args.image] : []), ...(args.mask ? [args.mask] : [])];
  let portrait = false, readable = true;
  for (const path of paths) {
    try { const read = await files.read(path); portrait ||= read.portrait; }
    catch { readable = false; }
  }
  const need: Need = args.action === "create" ? { imageTier: args.tier } : args.action === "edit" ? { imageMask: !!args.mask } : {};
  const noCloud = portrait && settings.photoCloudPolicy() === "never";
  const routing = ctx;
  const next = readable ? models.nextImageModel(routing, args.action, need, refusal.endpointId, noCloud) : undefined;
  const sourceEntry = entries.find(e => e.n === source.n)?.data as { customType?: string; details?: { userMessageN?: number } } | undefined;
  const user = sourceEntry?.customType === "lyrica-image-retry"
    ? messages.find(m => m.role === "user" && m.n === sourceEntry.details?.userMessageN)
    : messages.findLast(m => m.role === "user" && m.n < source.n && !m.from);
  const last = messages.findLast(m => m.role === "user" && !m.from);
  const options: ImageRetryOptions = { canEdit: !!user && user.n === last?.n,
    ...(user ? { userMessage: { n: user.n, text: user.parts.filter(p => p.type === "text").map(p => p.text).join("") } } : {}),
    ...(next ? { next: { offeringId: next.offering.id, label: next.label } } : {}) };
  return { options, args, refusal, routing, need, noCloud };
}
