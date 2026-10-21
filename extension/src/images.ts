// Principles 1, 2 and 8: one image tool, with portrait consent checked at each resolved provider.
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CloudModelForbidden, HostRefused, isRestricted, modelName, type CallContext, type ImageRequest, type Models, type Resolution,
  type ThreadImages, type WorkspaceSettings } from "@lyrica/core";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ApprovalRequest } from "./workspace.ts";

export interface ImagePart { type: "image"; paths: string[]; model: string; tier?: "fast" | "quality" }
export interface ImageTools {
  models: Models;
  call(): CallContext;
  threadId: string;
  files: ThreadImages;
  settings(): WorkspaceSettings;
  enabled(): boolean;
  approve?(request: ApprovalRequest): Promise<boolean>;
  now?: () => Date;
}

const path = (description: string) => Type.Optional(Type.String({ description }));
/**
 * One object with `action` and optional fields, checked per action in
 * `executeImage`. A top-level union has no `"type": "object"`: LM Studio
 * refuses such a tool, and smaller models' chat templates show it no fields.
 */
export const imageParameters = Type.Object({
  action: StringEnum(["create", "edit", "upscale"] as const),
  prompt: Type.Optional(Type.String({ description: "For create: what to draw." })),
  tier: Type.Optional(StringEnum(["fast", "quality"] as const, { description: "For create: fast or quality." })),
  image: path("For edit and upscale: the image's path."),
  instruction: Type.Optional(Type.String({ description: "For edit: what to change." })),
  mask: path("For edit: a mask image's path."),
  references: Type.Optional(Type.Array(Type.String(), { maxItems: 16, description: "For create and edit: reference images' paths." })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "For create and edit: how many images." })),
  size: Type.Optional(Type.Object({ width: Type.Integer(), height: Type.Integer() }, { description: "For create: exact pixels." })),
  aspectRatio: Type.Optional(Type.String({ description: "For create: width:height (16:9); omit for recipe defaults." })),
  scale: Type.Optional(Type.Number({ minimum: 1, maximum: 4, description: "For upscale: the factor." })),
  maxSize: Type.Optional(Type.Integer({ minimum: 256, maximum: 8192, description: "For upscale: the longest side's limit." })),
});
export type ImageArgs = Static<typeof imageParameters>;

const NEEDS = { create: ["prompt", "tier"], edit: ["image", "instruction"], upscale: ["image"] } as const;

/** The fields an action needs, named in the error a model reads. */
function needs(p: ImageArgs): void {
  const missing = NEEDS[p.action].filter(k => p[k] === undefined || p[k] === "");
  if (missing.length) throw new Error(`${p.action} needs ${missing.join(" and ")}: ${NEEDS[p.action].join(", ")} are required, the rest optional.`);
}

/** Around one megapixel, rounded to the host's 16-pixel grid and bounded by its size limits. */
export function ratioSize(ratio: string): { width: number; height: number } {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio);
  const r = match ? Number(match[1]) / Number(match[2]) : NaN;
  if (!Number.isFinite(r) || r < 1 / 8 || r > 8) throw new Error("aspect ratio is width:height, between 1:8 and 8:1");
  let width = 1024 * Math.sqrt(r), height = 1024 / Math.sqrt(r);
  const shrink = Math.min(1, 2048 / Math.max(width, height));
  width *= shrink; height *= shrink;
  return { width: Math.round(width / 16) * 16, height: Math.round(height / 16) * 16 };
}

const dayOf = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
// One pending question per user, even across simultaneous threads in the same process.
const pending = new WeakMap<WorkspaceSettings, Promise<boolean>>();

async function allowPortrait(o: ImageTools, r: Resolution, id: string, ctx: ExtensionContext | undefined, signal?: AbortSignal): Promise<void> {
  const s = o.settings();
  const policy = s.photoCloudPolicy();
  if (policy === "never") throw new Error("Photos of you aren't allowed to go to cloud models.");
  if (policy === "always") return;
  const day = dayOf(o.now?.() ?? new Date());
  if (s.photoCloudApproved(day)) return;
  let question = pending.get(s);
  if (!question) {
    const text = `Send photos of you to ${r.endpoint.name}?`;
    const request: ApprovalRequest = { toolCallId: id, tool: "image", input: { question: text, provider: r.endpoint.name, model: r.label }, warning: text };
    question = (async () => {
      const allowed = o.approve ? await o.approve(request) : ctx?.hasUI ? await ctx.ui.confirm(text, "An approval lasts until the end of today.") : false;
      signal?.throwIfAborted();
      if (!allowed || day !== dayOf(o.now?.() ?? new Date()) || s.photoCloudPolicy() === "never") return false;
      if (s.photoCloudPolicy() === "ask") s.approvePhotoCloud(day);
      return true;
    })();
    pending.set(s, question);
    void question.finally(() => { if (pending.get(s) === question) pending.delete(s); }).catch(() => {});
  }
  if (!await question) throw new Error("Sending photos of you wasn't approved.");
  signal?.throwIfAborted();
  if (s.photoCloudPolicy() === "never" || (s.photoCloudPolicy() === "ask" && !s.photoCloudApproved(dayOf(o.now?.() ?? new Date())))) {
    throw new Error("Sending photos of you needs approval again.");
  }
}

/** What a refused call answers with; Resend and Try in the message still work. */
export const REFUSED_THIS_TURN = "An image was refused earlier in this reply, so no more image calls run in this turn. Tell them what was refused and why.";

export function createImageExtension(o: ImageTools): ExtensionFactory {
  return pi => {
    // A refusal ends image calls for the rest of the agent run (her turn): a reworded prompt would
    // spend more of a plan on what was just declined.
    let refused = false;
    pi.on("agent_start", () => { refused = false; });
    pi.registerTool({
      name: "image", label: "Image", description: "Create, edit or upscale images from workspace paths or /photos-of-me/<file>; results go to images/ (shared/images/ in a project chat).",
      promptSnippet: "create, edit or upscale images",
      promptGuidelines: ["Write prompts from the conversation; inspect results and retry if needed.",
        "Draw exact layouts and diagrams as HTML, SVG or Mermaid."],
      parameters: imageParameters,
      async execute(id, p, signal, _update, ctx) {
        if (refused) throw new Error(REFUSED_THIS_TURN);
        const result = await executeImage(o, id, p, signal, ctx);
        if ("imageRefusal" in result.details) refused = true;
        return result;
      },
    });
  };
}

/**
 * A failed call says which model (a host's recipe by name) it reached and what came back,
 * so she can report it; an Offline error already lists what it tried.
 */
function withModel(err: unknown, action: string, r: Resolution | undefined, signal?: AbortSignal): unknown {
  if (!r || signal?.aborted || !(err instanceof Error) || err.name === "Offline") return err;
  const code = err instanceof HostRefused ? ` [${err.code}]` : "";
  return new Error(`Image ${action} failed with ${r.label}${code}: ${err.message}`, { cause: err });
}

/** Shared by Pi and explicit refusal retries; no model-facing arguments are added. */
export async function executeImage(o: ImageTools, id: string, p: ImageArgs, signal?: AbortSignal, ctx?: ExtensionContext) {
  if (!o.enabled()) throw new Error("Images are off in this thread.");
  needs(p);
  let portrait = false;
  const read = async (path: string) => {
    const result = await o.files.read(path); portrait ||= result.portrait;
    return result.input;
  };
  let request: ImageRequest;
  if (p.action === "upscale") {
    request = { action: p.action, image: await read(p.image!), ...(p.scale === undefined ? {} : { scale: p.scale }), ...(p.maxSize === undefined ? {} : { maxSize: p.maxSize }) };
  } else {
    const refs = p.references ? await Promise.all(p.references.map(read)) : undefined;
    const common = { ...(p.count === undefined ? {} : { count: p.count }), ...(refs ? { references: refs } : {}) };
    if (p.action === "create") {
      if (p.size && p.aspectRatio) throw new Error("Give a size or an aspect ratio, not both.");
      const size = p.size ?? (p.aspectRatio ? ratioSize(p.aspectRatio) : undefined);
      request = { action: p.action, prompt: p.prompt!, tier: p.tier!, ...(size ? { size } : {}), ...common };
    } else request = { action: p.action, prompt: p.instruction!, image: await read(p.image!), ...(p.mask ? { mask: await read(p.mask) } : {}), ...common };
  }
  const call = o.call();
  let attempted: Resolution | undefined;
  let out;
  try { out = await o.models.image(call, request, { signal, beforeSend: async r => {
    attempted = r;
    if (!o.enabled()) throw new Error("Images are off in this thread.");
    if (r.endpoint.kind === "cloud") {
      if (isRestricted(o.call())) throw new CloudModelForbidden("This thread uses local models only.");
      if (portrait) await allowPortrait(o, r, id, ctx, signal);
    }
    if (!o.enabled()) throw new Error("Images are off in this thread.");
    if (r.endpoint.kind === "cloud" && isRestricted(o.call())) throw new CloudModelForbidden("This thread uses local models only.");
  } }); } catch (err) {
    if (!(err instanceof HostRefused) || err.code !== "image_refusal" || !attempted) throw withModel(err, p.action, attempted, signal);
    return { content: [{ type: "text" as const, text: err.message }], isError: true,
      details: { imageRefusal: { code: "image_refusal" as const, offeringId: attempted.offering.id, endpointId: attempted.endpoint.id } } };
  }
  signal?.throwIfAborted();
  const paths = o.files.save(out.images, portrait);
  const part: ImagePart = { type: "image", paths, model: out.resolution.label, ...(p.action === "create" ? { tier: p.tier } : {}) };
  o.models.recordCall(call.userId, { pool: call.pool, threadId: o.threadId, task: `image.${p.action}`, resolution: out.resolution });
  return { content: [{ type: "text" as const, text: `Made with ${modelName(out.resolution.offering)} on ${out.resolution.endpoint.name}. Saved ${paths.join(", ")}.` },
    ...out.images.map(i => ({ type: "image" as const, data: Buffer.from(i.bytes).toString("base64"), mimeType: i.type }))], details: { image: part } };
}
