// Principles 1, 2 and 8: one image tool, which also makes clips, with portrait consent checked at each resolved provider.
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CloudModelForbidden, HostRefused, isRestricted, modelName, type CallContext, type ImageRequest, type JobProgress, type Models, type Resolution,
  type ThreadImages, type VideoRequest, type WorkspaceSettings, LONGEST_VIDEO_SECONDS } from "@lyrica/core";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ApprovalRequest } from "./workspace.ts";

/** `picked`: her pick among attempts made earlier, shown again last; its model is the earlier part's, so empty here. */
export interface ImagePart { type: "image"; paths: string[]; model: string; tier?: "fast" | "quality"; picked?: true }
/** A clip she made; its poster is the clip's thumbnail. */
export interface VideoPart { type: "video"; path: string; model: string; width: number; height: number; duration: number; audio: boolean }
export interface ImageTools {
  models: Models;
  call(): CallContext;
  threadId: string;
  files: ThreadImages;
  settings(): WorkspaceSettings;
  enabled(): boolean;
  approve?(request: ApprovalRequest): Promise<boolean>;
  now?: () => Date;
  /**
   * Runs a clip in the background (lyricad's clip jobs), under its call's ID: the call returns at once and the
   * thread hears of the clip when it is made, and of its progress while it is. Without it a clip is made within the call.
   */
  background?(make: (signal: AbortSignal, onProgress: (p: JobProgress) => void) => Promise<ClipMade>, toolCallId: string): void;
}

/** A clip made in the background: what she is told, and the part the chat shows. */
export interface ClipMade { text: string; video: VideoPart }

const path = (description: string) => Type.Optional(Type.String({ description }));
/**
 * One object with `action` and optional fields, checked per action in
 * `executeImage`. A top-level union has no `"type": "object"`: LM Studio
 * refuses such a tool, and smaller models' chat templates show it no fields.
 */
export const imageParameters = Type.Object({
  action: StringEnum(["create", "edit", "upscale", "reject", "pick", "clear_rejected", "video", "animate", "motion", "extend"] as const),
  prompt: Type.Optional(Type.String({ description: "For create: what to draw, as one detailed paragraph. For video and animate: what happens in the clip. For motion: the scene, light and look; the clip gives the moves. For extend: what happens next." })),
  tier: Type.Optional(StringEnum(["fast", "quality"] as const, { description: "For create: fast or quality (the default)." })),
  model: Type.Optional(Type.String({ description: "For create, edit and upscale: an image model they asked for by name; it is tried first, then the usual models." })),
  image: path("For edit, upscale, pick, animate and motion: the image's path (animate's first frame; motion's subject, who moves)."),
  video: path("For motion: the driving clip's path, an MP4 whose person makes the moves. For extend: the clip to make longer."),
  images: Type.Optional(Type.Array(Type.String(), { maxItems: 16, description: "For reject: the attempts to set aside." })),
  instruction: Type.Optional(Type.String({ description: "For edit: the change, and what stays the same. The edited image is image 1; references are image 2 and on." })),
  mask: path("For edit: a mask image's path."),
  replace: Type.Optional(Type.Boolean({ description: "For a masked edit: true when what's under the mask becomes something new; omit when it changes what's there." })),
  references: Type.Optional(Type.Array(Type.String(), { maxItems: 16, description: "For create and edit: reference images' paths." })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "For create and edit: how many images." })),
  size: Type.Optional(Type.Object({ width: Type.Integer(), height: Type.Integer() }, { description: "For create and video: exact pixels." })),
  aspectRatio: Type.Optional(Type.String({ description: "For create and video: width:height (16:9); omit for recipe defaults." })),
  duration: videoDuration(),
  steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 150, description: "For video, animate and motion: sampling steps, only when they ask for a number; omit for the model's own." })),
  scale: Type.Optional(Type.Number({ minimum: 1, maximum: 4, description: "For upscale: the factor." })),
  maxSize: Type.Optional(Type.Integer({ minimum: 256, maximum: 8192, description: "For upscale: the longest side's limit." })),
});
export type ImageArgs = Static<typeof imageParameters>;

/** `duration`, saying the thread's first Videos model's longest when it is known. */
export function videoDuration(model?: { name: string; longestSeconds?: number; extend: boolean }) {
  const longest = model?.longestSeconds ?? LONGEST_VIDEO_SECONDS;
  const most = model?.longestSeconds ? ` ${model.name} makes up to ${longest} s${model.extend ? ", joining clips into one past a clip's length" : ""}.` : "";
  return Type.Optional(Type.Number({ minimum: 1, maximum: longest, description: `For video and animate: seconds, the whole length they asked for; omit for the model's default.${most} For extend: the seconds to add. For motion, leave it out: the host uses the driving clip's own length, up to the model's longest.` }));
}

const NEEDS = { create: ["prompt"], edit: ["image", "instruction"], upscale: ["image"], reject: ["images"], pick: ["image"], clear_rejected: [], video: ["prompt"], animate: ["image", "prompt"], motion: ["image", "video", "prompt"], extend: ["video", "prompt"] } as const;

/** The files each action reads; any other file it is given is refused, not ignored, so a model doesn't take one clip for another. */
const FILES = { create: ["references"], edit: ["image", "mask", "references"], upscale: ["image"], reject: ["images"], pick: ["image"], clear_rejected: [], video: [], animate: ["image"], motion: ["image", "video"], extend: ["video"] } as const;
const FILE_USE = { image: "animate starts a clip from an image", video: "extend makes a clip longer and motion copies a clip's moves", mask: "edit takes a mask", images: "reject takes images", references: "create and edit take references" } as const;

/** The fields an action needs, named in the error a model reads. */
function needs(p: ImageArgs): void {
  const missing = NEEDS[p.action].filter(k => p[k] === undefined || p[k] === "" || (Array.isArray(p[k]) && !p[k].length));
  if (missing.length) throw new Error(`${p.action} needs ${missing.join(" and ")}: ${NEEDS[p.action].join(", ")} ${NEEDS[p.action].length === 1 ? "is" : "are"} required, the rest optional.`);
  const extra = (Object.keys(FILE_USE) as (keyof typeof FILE_USE)[]).filter(k => p[k] !== undefined && !(FILES[p.action] as readonly string[]).includes(k));
  if (extra.length) throw new Error(`${p.action} doesn't take ${extra.join(" or ")}: ${extra.map(k => FILE_USE[k]).join("; ")}.`);
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

/** Rejected attempts in one turn after which she asks the person rather than trying again. */
export const REJECTS_BEFORE_ASKING = 8;
/** Added to a reject's answer once a turn reaches REJECTS_BEFORE_ASKING; a nudge, not a block. */
export const ASK_INSTEAD = `That's ${REJECTS_BEFORE_ASKING} or more rejected attempts this turn. Stop retrying: pick the closest attempt and ask them what to change.`;

/** What a refused call answers with; Resend and Try in the message still work. */
export const REFUSED_THIS_TURN = "An image was refused earlier in this reply, so no more image calls run in this turn. Tell them what was refused and why.";

export function createImageExtension(o: ImageTools): ExtensionFactory {
  return pi => {
    // A refusal ends image calls for the rest of the agent run (her turn): a reworded prompt would
    // spend more of a plan on what was just declined.
    let refused = false;
    // Attempts rejected this turn, each once: past a few, retrying is less use than asking (ASK_INSTEAD).
    const rejects = new Set<string>();
    pi.on("agent_start", () => { refused = false; rejects.clear(); });
    pi.registerTool({
      name: "image", label: "Image", description: "Create, edit or upscale images from workspace paths or /photos-of-me/<file>; results go to images/ (shared/images/ in a project chat). Reject sets attempts aside in images/rejected/; pick shows the one you keep last; clear_rejected deletes the rejected ones for good. Video makes a clip from a prompt, animate one from an image, motion one of an image's subject moving as the person in a clip moves, and extend makes a clip longer; clips go to videos/ (shared/videos/), are made in the background, and you are told here when one is ready.",
      promptSnippet: "create, edit or upscale images, and make short clips",
      promptGuidelines: ["Write prompts from the conversation; inspect results and retry if needed.",
        "Before retrying, reject the attempts that miss; the chat folds them away. If an earlier attempt is best, pick it.",
        "Use clear_rejected only when they ask to delete this thread's rejected images.",
        "Draw exact layouts and diagrams as HTML, SVG or Mermaid.",
        "For create, describe the subject and what it does, then setting, light, framing and medium (photo, painting, sketch); keep to what they asked, and ask for text in the image only when they want it, quoted.",
        "For an edit, look at the image first; name the one change plainly, say what goes, and say what stays (faces, body, pose, framing, light).",
        "Make one big change per edit: for a new setting and a new outfit, edit twice, each from the last result. With a mask, say what replaces what is under it.",
        "When they name an image model, set model to that name. When the result says a model was passed over or isn't found, tell them which model made it and why.",
        "With a mask, set replace when the masked thing becomes something else (a painting into a mirror), and then write the instruction as the finished scene (a round mirror on a warm beige wall); leave it off to recolour or reshape what's there, which keeps the rest of it.",
        "Don't pass the image being edited as a reference too.",
        "For a person from reference photos, say \"the person from the reference images\", not an image number; ask for one new angle per edit, or several views as one wide create. For an exact garment, pass its photo as a reference. Word a change of build strongly. For a relative, pass no photo: describe the traits they share and how they differ.",
        "Check faces, hands and limbs in a result against the source; reject one that gets them wrong.",
        "Make a clip only when they ask for one: it holds the model host's GPU for minutes. It is made in the background: say it's on its way and end your reply; you'll be told when it's ready. For video and animate, write the prompt as a detailed shot even when they gave a few words: the subject and what it does, how things move, the camera's move and lens, the light and the mood, in one paragraph of about 80 to 120 words; for animate, say what moves and what stays.",
        "For a long video, give the whole length as duration: the host joins clips into one. To make an existing clip longer, use extend with its path, the seconds to add and a prompt for what happens next.",
        "Use motion when they want someone to move as a given clip shows (a dance, a gesture), or when a clip of a person from a prompt alone would move badly: make a plain clip of someone doing the moves first (video), then motion with it. For motion, the prompt says the scene, light and look; the moves come from the clip. Don't measure the clip first: leave duration out and the host takes its length."],
      parameters: videoModelParameters(o),
      async execute(id, p, signal, update, ctx) {
        if (refused) throw new Error(REFUSED_THIS_TURN);
        // How far a model host has got, for the chat's placeholder (docs/ux.md, "An image the agent made").
        const onProgress = update && ((progress: JobProgress) => update({ content: [], details: { progress } } as never));
        const result = await executeImage(o, id, p, signal, ctx, onProgress);
        if ("imageRefusal" in result.details) refused = true;
        if ("rejected" in result.details) for (const path of result.details.rejected ?? []) rejects.add(path);
        if ("rejected" in result.details && rejects.size >= REJECTS_BEFORE_ASKING) {
          return { ...result, content: [...result.content, { type: "text" as const, text: ASK_INSTEAD }] };
        }
        return result;
      },
    });
  };
}

const isVideo = (a: string): a is "video" | "animate" | "motion" | "extend" => ["video", "animate", "motion", "extend"].includes(a);

/** The tool's fields, its duration saying the thread's Videos model's longest; the static schema if that can't be read. */
function videoModelParameters(o: ImageTools) {
  let model;
  try { model = o.models.firstVideoModel(o.call()); } catch { return imageParameters; }
  return model ? Type.Object({ ...imageParameters.properties, duration: videoDuration(model) }) : imageParameters;
}

/**
 * A failed call says which model (a host's recipe by name) it reached and what came back,
 * so she can report it; an Offline error already lists what it tried.
 */
const FINAL = new Set(["too_big", "invalid", "unsupported", "refused"]);

function withModel(err: unknown, action: string, r: Resolution | undefined, signal?: AbortSignal): unknown {
  const what = isVideo(action) ? "Video" : `Image ${action}`;
  if (!r || signal?.aborted || !(err instanceof Error) || err.name === "Offline") return err;
  const code = err instanceof HostRefused ? ` [${err.code}]` : "";
  // A request the model or its machine can never serve: retrying, now or later, only repeats it.
  const final = err instanceof HostRefused && FINAL.has(err.code) ? " Retrying won't help: try another model, or tell them." : "";
  return new Error(`${what} failed with ${r.label}${code}: ${err.message}${final}`, { cause: err });
}

/** Shared by Pi and explicit refusal retries; no model-facing arguments are added. */
export async function executeImage(o: ImageTools, id: string, p: ImageArgs, signal?: AbortSignal, ctx?: ExtensionContext, onProgress?: (p: JobProgress) => void) {
  if (!o.enabled()) throw new Error("Images are off in this thread.");
  needs(p);
  // Sorting her own attempts calls no model: the files move inside the thread's images folder.
  if (p.action === "reject") {
    const paths = o.files.reject(p.images!);
    return { content: [{ type: "text" as const, text: `Rejected ${paths.join(", ")}. The chat shows them folded away.` }], details: { rejected: paths } };
  }
  if (p.action === "clear_rejected") {
    const paths = o.files.clearRejected();
    return { content: [{ type: "text" as const, text: paths.length ? `Deleted ${paths.length} rejected ${paths.length === 1 ? "image" : "images"} for good.` : "There were no rejected images to delete." }], details: { cleared: paths } };
  }
  if (p.action === "pick") {
    const path = o.files.pick(p.image!);
    const part: ImagePart = { type: "image", paths: [path], model: "", picked: true };
    return { content: [{ type: "text" as const, text: `Picked ${path}; the chat shows it last.` }], details: { image: part } };
  }
  if (isVideo(p.action)) return executeVideo(o, id, p, signal, onProgress);
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
      request = { action: p.action, prompt: p.prompt!, tier: p.tier ?? "quality", ...(size ? { size } : {}), ...common };
    } else request = { action: p.action, prompt: p.instruction!, image: await read(p.image!), ...(p.mask ? { mask: await read(p.mask), ...(p.replace ? { replace: true } : {}) } : {}), ...common };
  }
  const call = o.call();
  // A model they named goes first for this call only; the usual list still follows it.
  const named = p.model?.trim() ? o.models.namedImageModels(call, p.action, p.model) : undefined;
  const unnamed = named && !named.ids.length
    ? ` No image model here is called "${p.model}"${named.names.length ? `; the ones that can: ${named.names.join(", ")}` : ""}.` : "";
  let attempted: Resolution | undefined;
  let out;
  try { out = await o.models.image(call, request, { signal, onProgress, ...(named?.ids.length ? { first: named.ids } : {}), beforeSend: async r => {
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
  const part: ImagePart = { type: "image", paths, model: out.resolution.label, ...(p.action === "create" ? { tier: p.tier ?? "quality" } : {}) };
  o.models.recordCall(call.userId, { pool: call.pool, threadId: o.threadId, task: `image.${p.action}`, resolution: out.resolution });
  // Any fallback is said, so she can tell them the model they got isn't the first choice.
  const passed = out.resolution.passedOver ?? [];
  const fellBack = passed.length ? ` Passed over first: ${passed.map(s => `${s.label} (${s.reason.replace(/^it /, "")})`).join("; ")}.` : "";
  return { content: [{ type: "text" as const, text: `Made with ${modelName(out.resolution.offering)} on ${out.resolution.endpoint.name}.${unnamed}${fellBack} Saved ${paths.join(", ")}.` },
    ...out.images.map(i => ({ type: "image" as const, data: Buffer.from(i.bytes).toString("base64"), mimeType: i.type }))], details: { image: part } };
}

/**
 * A clip from the thread's Videos list: only a model host makes one, so nothing here goes to a cloud model and a
 * portrait first frame (or subject, with a driving clip) needs no consent. The poster comes back as an image, so she can see its first frame.
 */
async function executeVideo(o: ImageTools, id: string, p: ImageArgs, signal?: AbortSignal, onProgress?: (p: JobProgress) => void) {
  if (p.size && p.aspectRatio) throw new Error("Give a size or an aspect ratio, not both.");
  // An aspect ratio goes to the host as it is, which keeps the recipe's area and snaps to its size step.
  const request: VideoRequest = { prompt: p.prompt!, ...(p.action === "animate" || p.action === "motion" ? { image: (await o.files.read(p.image!)).input } : {}),
    ...(p.action === "motion" ? { drive: await o.files.readClip(p.video!) } : {}), ...(p.action === "extend" ? { extend: await o.files.readClip(p.video!) } : {}),
    ...(p.size ? { size: p.size } : {}), ...(p.aspectRatio ? { aspectRatio: p.aspectRatio } : {}), ...(p.duration === undefined ? {} : { duration: p.duration }),
    ...(p.steps === undefined ? {} : { steps: p.steps }) };
  const call = o.call();
  const make = async (signal?: AbortSignal, onProgress?: (p: JobProgress) => void) => {
    let attempted: Resolution | undefined;
    let out;
    try { out = await o.models.video(call, request, { signal, onProgress, beforeSend: async r => { attempted = r; if (!o.enabled()) throw new Error("Images are off in this thread."); } }); }
    catch (err) { throw withModel(err, p.action, attempted, signal); }
    signal?.throwIfAborted();
    const path = o.files.saveVideo(out.video);
    const v = out.video;
    const video: VideoPart = { type: "video", path, model: out.resolution.label, width: v.width, height: v.height, duration: v.duration, audio: v.audio };
    o.models.recordCall(call.userId, { pool: call.pool, threadId: o.threadId, task: "video", resolution: out.resolution });
    const text = `Made with ${modelName(out.resolution.offering)} on ${out.resolution.endpoint.name}: ${v.duration.toFixed(1)} s at ${v.width}×${v.height}${v.audio ? ", with sound" : ""}. Saved ${path}.`;
    return { text, video, poster: v.poster };
  };
  // A clip holds the host's GPU for minutes: in the background her turn ends, and the chat goes on.
  if (o.background) {
    o.background(async (signal, progress) => { const { text, video } = await make(signal, progress); return { text: `The clip is ready. ${text}`, video }; }, id);
    return { content: [{ type: "text" as const, text: "Making the clip in the background; it takes minutes. You'll be told here when it is ready, and the chat shows it then. Don't wait for it: finish this reply." }],
      details: { clip: "started" } };
  }
  const { text, video, poster } = await make(signal, onProgress);
  return { content: [{ type: "text" as const, text: `${text} Its first frame:` },
    { type: "image" as const, data: Buffer.from(poster.bytes).toString("base64"), mimeType: poster.type }], details: { video } };
}
