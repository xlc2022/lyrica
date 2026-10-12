// Principles 1, 2 and 8: one image tool, with portrait consent checked at each resolved provider.
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CloudModelForbidden, isRestricted, type CallContext, type ImageRequest, type Models, type Resolution,
  type ThreadImages, type WorkspaceSettings } from "@lyrica/core";
import { Type } from "typebox";
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

const path = Type.String();
const references = Type.Optional(Type.Array(path, { maxItems: 16 }));
const count = Type.Optional(Type.Integer({ minimum: 1, maximum: 4 }));
const parameters = Type.Union([
  Type.Object({ action: Type.Literal("create"), prompt: Type.String(), tier: Type.Union([Type.Literal("fast"), Type.Literal("quality")]),
    size: Type.Optional(Type.Object({ width: Type.Integer(), height: Type.Integer() })),
    aspectRatio: Type.Optional(Type.String({ description: "Width:height (16:9); omit for recipe defaults." })), count, references }),
  Type.Object({ action: Type.Literal("edit"), image: path, instruction: Type.String(), mask: Type.Optional(path), references, count }),
  Type.Object({ action: Type.Literal("upscale"), image: path, scale: Type.Optional(Type.Number({ minimum: 1, maximum: 4 })),
    maxSize: Type.Optional(Type.Integer({ minimum: 256, maximum: 8192 })) }),
]);

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

async function allowPortrait(o: ImageTools, r: Resolution, id: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
  const s = o.settings();
  const policy = s.photoCloudPolicy();
  if (policy === "never") throw new Error("Photos of you aren't allowed to go to cloud models.");
  if (policy === "always") return;
  const day = dayOf(o.now?.() ?? new Date());
  if (s.photoCloudApproved(day)) return;
  let question = pending.get(s);
  if (!question) {
    const text = `Send photos of you to ${r.endpoint.name}?`;
    const request: ApprovalRequest = { toolCallId: id, tool: "image", input: { question: text, provider: r.endpoint.name }, warning: text };
    question = (async () => {
      const allowed = o.approve ? await o.approve(request) : ctx.hasUI ? await ctx.ui.confirm(text, "An approval lasts until the end of today.") : false;
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

export function createImageExtension(o: ImageTools): ExtensionFactory {
  return pi => {
    pi.registerTool({
      name: "image", label: "Image", description: "Create, edit or upscale images from workspace paths or /photos-of-me/<file>; results go to images/.",
      promptSnippet: "create, edit or upscale images",
      promptGuidelines: ["Write prompts from the conversation; inspect results and retry if needed.",
        "Draw exact layouts and diagrams as HTML, SVG or Mermaid."],
      parameters,
      async execute(id, p, signal, _update, ctx) {
        if (!o.enabled()) throw new Error("Images are off in this thread.");
        let portrait = false;
        const read = async (path: string) => {
          const result = await o.files.read(path); portrait ||= result.portrait;
          return result.input;
        };
        let request: ImageRequest;
        if (p.action === "upscale") {
          request = { action: p.action, image: await read(p.image), ...(p.scale === undefined ? {} : { scale: p.scale }), ...(p.maxSize === undefined ? {} : { maxSize: p.maxSize }) };
        } else {
          const refs = p.references ? await Promise.all(p.references.map(read)) : undefined;
          const common = { ...(p.count === undefined ? {} : { count: p.count }), ...(refs ? { references: refs } : {}) };
          if (p.action === "create") {
            if (p.size && p.aspectRatio) throw new Error("Give a size or an aspect ratio, not both.");
            const size = p.size ?? (p.aspectRatio ? ratioSize(p.aspectRatio) : undefined);
            request = { action: p.action, prompt: p.prompt, tier: p.tier, ...(size ? { size } : {}), ...common };
          } else request = { action: p.action, prompt: p.instruction, image: await read(p.image), ...(p.mask ? { mask: await read(p.mask) } : {}), ...common };
        }
        const call = o.call();
        const out = await o.models.image(call, request, { signal, beforeSend: async r => {
          if (!o.enabled()) throw new Error("Images are off in this thread.");
          if (r.endpoint.kind === "cloud") {
            if (isRestricted(o.call())) throw new CloudModelForbidden("This thread uses local models only.");
            if (portrait) await allowPortrait(o, r, id, ctx, signal);
          }
          if (!o.enabled()) throw new Error("Images are off in this thread.");
          if (r.endpoint.kind === "cloud" && isRestricted(o.call())) throw new CloudModelForbidden("This thread uses local models only.");
        } });
        signal?.throwIfAborted();
        const paths = o.files.save(out.images);
        const part: ImagePart = { type: "image", paths, model: out.resolution.label, ...(p.action === "create" ? { tier: p.tier } : {}) };
        o.models.recordCall(call.userId, { pool: call.pool, threadId: o.threadId, task: `image.${p.action}`, resolution: out.resolution });
        return { content: [{ type: "text" as const, text: `Saved ${paths.join(", ")}.` },
          ...out.images.map(i => ({ type: "image" as const, data: Buffer.from(i.bytes).toString("base64"), mimeType: i.type }))], details: { image: part } };
      },
    });
  };
}
