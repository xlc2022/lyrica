// Custom workflows (DESIGN, "Local images"; host/API.md, "Custom workflows"): a workflow the host's
// manager exported from ComfyUI (its Export (API) file) or copied from a built-in template, kept in the
// host's data folder as a template of its own. An export becomes a draft first; every save is checked
// here, and a saved one is filled like any template. Only the manager's own calls add or change one:
// a job still names a recipe and gives values, never nodes.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { invalid } from "./http.ts";
import type { Part, Role } from "./parts.ts";
import type { RecipePart } from "./recipes.ts";
import type { Action, Node, PartSpec, Template, VideoSpec } from "./templates.ts";

/** What a custom workflow can do: one clip at a time for videos, no upscaling or masks. */
export const CUSTOM_ACTIONS: Action[] = ["create", "edit", "video", "animate"];

const SIZE = ["width", "height"];
const SAMPLING = ["seed", "steps", "cfg", "sampler", "scheduler", "shift", "guidance"];
const REFERENCES = ["reference1", "reference2", "reference3", "reference4"];
/** The values a job fills for each action (images.ts): a blank is one of them, as `$name`. */
export const BLANKS: Record<string, string[]> = {
  create: ["prompt", "negativePrompt", ...SIZE, "count", ...SAMPLING],
  edit: ["prompt", "negativePrompt", ...SIZE, "count", ...SAMPLING, "image", ...REFERENCES],
  video: ["prompt", "negativePrompt", ...SIZE, ...SAMPLING, "frames", "fps"],
  animate: ["prompt", "negativePrompt", ...SIZE, ...SAMPLING, "frames", "fps", "image"],
};
/** The blanks a workflow must have to do its action. */
const NEEDS: Record<string, string[]> = { create: ["prompt"], edit: ["prompt", "image"], video: ["prompt", "frames"], animate: ["prompt", "image", "frames"] };
/** The loader links a recipe's parts give (templates.ts, `loaders`). */
const LINKS = ["$model", "$clip", "$vae"];
const IMAGE_OUT = "SaveImageWebsocket";
const VIDEO_OUT = "SaveVideoWebsocket";
/** Nodes that write files or reach out: none may stay in a custom workflow. */
const WRITES = /save|export|write|upload|download|http|url|request|shell|exec|eval|python|command/i;
/** Nodes that read a file of ComfyUI's input folder: each must read one the job uploads. */
const READS = /^(Load(Image|Video|Audio)|VHS_Load)/;
const MODEL_FILE = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft|onnx)$/i;
const MAX_NODES = 300;
const MAX_TEXT = 16_384;
const MAX_LABEL = 80;
const NODE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const CLASS = /^[\w .:+()|-]{1,128}$/;

/** How many earlier versions a custom workflow keeps. */
export const MAX_REVISIONS = 50;
/** Who saved a version: the manager in Lyrica's app, or Lyrica at the user's word in a thread. */
export type Revision = { by: "app" | "lyrica" };

/** ComfyUI's node types as it last reported them (`/object_info`): each one's inputs, and whether it is an output. */
export type NodeList = Record<string, { inputs: Record<string, unknown>; output: boolean }>;

/** An export turned into a workflow the manager reviews before saving it. */
export interface Draft {
  label: string;
  does: Action;
  arch: string;
  workflow: Record<string, Node>;
  loaders: "template" | null;
  clipType: string | null;
  video: VideoSpec | null;
  parts: RecipePart[];
  loras: { file: string; strength: number }[];
  defaults: Record<string, string | number>;
  /** Model files the export names that aren't on this host. */
  unmatched: string[];
  /** Export nodes left out: previews and saves the host replaced. */
  dropped: string[];
}

export interface Check {
  problems: string[];
  /** Node types the workflow uses that ComfyUI didn't report; null when it hasn't run yet. */
  missingNodes: string[] | null;
}

const numericOrder = (a: string, b: string) => (Number(a) - Number(b)) || a.localeCompare(b);
const isLink = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && Number.isInteger(v[1]) && (v[1] as number) >= 0;

export function label(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw invalid("name is missing.");
  if (v.trim().length > MAX_LABEL) throw invalid(`name may be at most ${MAX_LABEL} characters.`);
  return v.trim();
}

export function customAction(v: unknown): Action {
  if (!CUSTOM_ACTIONS.includes(v as Action)) throw invalid(`does must be one of ${CUSTOM_ACTIONS.join(", ")}.`);
  return v as Action;
}

/** A workflow's nodes as ComfyUI's API format has them, checked for shape: ids, class types, inputs. */
export function parseWorkflow(raw: unknown): Record<string, Node> {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      throw invalid("The workflow isn't JSON.");
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid("The workflow must be an object of nodes.");
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.nodes) && "links" in o) throw invalid("That is ComfyUI's workflow file. In ComfyUI, use Export (API) and give that file.");
  const ids = Object.keys(o);
  if (!ids.length) throw invalid("The workflow has no nodes.");
  if (ids.length > MAX_NODES) throw invalid(`A workflow may have at most ${MAX_NODES} nodes.`);
  const out: Record<string, Node> = {};
  for (const id of ids) {
    const n = o[id] as Record<string, unknown> | null;
    if (!NODE_ID.test(id)) throw invalid(`Node id ${JSON.stringify(id.slice(0, 64))} isn't allowed: letters, digits and _ . : - only.`);
    if (!n || typeof n !== "object" || typeof n.class_type !== "string" || !CLASS.test(n.class_type)) throw invalid(`Node ${id} has no class_type.`);
    if (!n.inputs || typeof n.inputs !== "object" || Array.isArray(n.inputs)) throw invalid(`Node ${id} has no inputs.`);
    const node: Node = { class_type: n.class_type, inputs: {} };
    for (const [k, value] of Object.entries(n.inputs as Record<string, unknown>)) {
      if (!/^[\w.-]{1,64}$/.test(k)) throw invalid(`Node ${id} has an input named ${JSON.stringify(k.slice(0, 64))}.`);
      node.inputs[k] = checkValue(value, `${id}.${k}`);
    }
    if (n._if !== undefined) {
      const conds = Array.isArray(n._if) ? n._if : [n._if];
      if (!conds.length || !conds.every((c) => typeof c === "string" && /^\w{1,64}$/.test(c))) throw invalid(`Node ${id}'s _if must name values.`);
      node._if = n._if as string | string[];
    }
    if (n._unless !== undefined) {
      if (typeof n._unless !== "string" || !/^\w{1,64}$/.test(n._unless)) throw invalid(`Node ${id}'s _unless must name a value.`);
      node._unless = n._unless;
    }
    out[id] = node;
  }
  return out;
}

function checkValue(v: unknown, where: string): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw invalid(`${where} isn't a finite number.`);
    return v;
  }
  if (typeof v === "string") {
    if (v.length > MAX_TEXT) throw invalid(`${where} is longer than ${MAX_TEXT} characters.`);
    return v;
  }
  if (isLink(v)) return [v[0], v[1]];
  // `$pick`, as built-in templates have it: the first of these links whose node is left in.
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "$pick" in v) {
    const pick = (v as { $pick: unknown }).$pick;
    if (!Array.isArray(pick) || !pick.length || !pick.every((p) => isLink(p) || (typeof p === "string" && p.startsWith("$")))) throw invalid(`${where}'s $pick must list links.`);
    return { $pick: pick.map((p) => (isLink(p) ? [p[0], p[1]] : p)) };
  }
  if (Array.isArray(v) && v.length <= 64 && v.every((x) => typeof x === "number" || typeof x === "string")) return [...v];
  throw invalid(`${where} isn't a value ComfyUI takes here.`);
}

/** This host's file for a file name in an export: the same path, else the same name (any case), else null. */
export function matchFile(name: string, parts: Pick<Part, "file">[]): string | null {
  const exact = parts.find((p) => p.file === name);
  if (exact) return exact.file;
  const base = basename(name.replace(/\\/g, "/"));
  return parts.find((p) => basename(p.file) === base)?.file ?? parts.find((p) => basename(p.file).toLowerCase() === base.toLowerCase())?.file ?? null;
}

const MODEL_LOADERS: Record<string, { role: Role; input: string }> = {
  CheckpointLoaderSimple: { role: "checkpoint", input: "ckpt_name" },
  UNETLoader: { role: "diffusion", input: "unet_name" },
  UnetLoaderGGUF: { role: "diffusion", input: "unet_name" },
};
const CLIP_LOADERS: Record<string, string[]> = {
  CLIPLoader: ["clip_name"], CLIPLoaderGGUF: ["clip_name"], DualCLIPLoader: ["clip_name1", "clip_name2"], DualCLIPLoaderGGUF: ["clip_name1", "clip_name2"],
};
const IMAGE_SAVES = ["SaveImage", "SaveImageWebsocket"];
const PREVIEWS = ["PreviewImage"];
const VIDEO_SAVES = ["SaveVideo", "SaveVideoWebsocket"];
/** Video saves that take frames: the host makes a video of them first (ComfyUI's CreateVideo). */
const FRAME_SAVES: Record<string, string | null> = { VHS_VideoCombine: "frame_rate", SaveAnimatedWEBP: "fps", SaveAnimatedPNG: "fps", SaveWEBM: "fps" };

/**
 * An export as a draft for this host: its saves become the host's websocket outputs, its standard loaders the
 * recipe's parts (else it loads its own files), files matched to this host's, and its blanks guessed.
 */
export function importWorkflow(raw: unknown, name: string, does: Action, parts: Part[]): Draft {
  const wf = parseWorkflow(raw);
  const video = does === "video" || does === "animate";
  const dropped: string[] = [];
  const drop = (id: string) => {
    dropped.push(`${id} (${wf[id]!.class_type})`);
    delete wf[id];
  };
  const ids = () => Object.keys(wf).sort(numericOrder);
  const of = (classes: string[]) => ids().filter((id) => classes.includes(wf[id]!.class_type));

  // Outputs.
  let fpsFound: number | null = null;
  if (!video) {
    const saves = of(IMAGE_SAVES);
    const keep = saves.length ? saves : of(PREVIEWS);
    for (const id of keep) wf[id] = { class_type: IMAGE_OUT, inputs: { images: wf[id]!.inputs.images } };
    for (const id of [...of(PREVIEWS), ...of(VIDEO_SAVES), ...of(Object.keys(FRAME_SAVES))]) if (!keep.includes(id)) drop(id);
  } else {
    for (const id of of(VIDEO_SAVES)) wf[id] = { class_type: VIDEO_OUT, inputs: { video: wf[id]!.inputs.video } };
    for (const id of of(Object.keys(FRAME_SAVES))) {
      const n = wf[id]!;
      const rate = n.inputs[FRAME_SAVES[n.class_type]!];
      if (typeof rate === "number") fpsFound ??= rate;
      wf[`${id}_video`] = { class_type: "CreateVideo", inputs: { images: n.inputs.images, fps: "$fps", ...(isLink(n.inputs.audio) ? { audio: n.inputs.audio } : {}) } };
      wf[id] = { class_type: VIDEO_OUT, inputs: { video: [`${id}_video`, 0] } };
    }
    for (const id of [...of(IMAGE_SAVES), ...of(PREVIEWS)]) drop(id);
  }

  // Loaders: the standard set becomes the recipe's parts.
  const recipeParts: RecipePart[] = [];
  const loras: { file: string; strength: number }[] = [];
  const unmatched: string[] = [];
  const match = (file: unknown) => {
    if (typeof file !== "string") return null;
    const m = matchFile(file, parts);
    if (!m && !unmatched.includes(file)) unmatched.push(file);
    return m;
  };
  const models = of(Object.keys(MODEL_LOADERS));
  const clips = of(Object.keys(CLIP_LOADERS));
  const vaes = of(["VAELoader"]);
  const main = models.length === 1 ? wf[models[0]!]! : null;
  const checkpoint = main?.class_type === "CheckpointLoaderSimple";
  const plainDtype = !main || main.inputs.weight_dtype === undefined || main.inputs.weight_dtype === "default";
  const plainDevice = clips.every((id) => wf[id]!.inputs.device === undefined || wf[id]!.inputs.device === "default");
  const standard = !!main && clips.length <= 1 && vaes.length <= 1 && (checkpoint || (clips.length === 1 && vaes.length === 1)) && plainDtype && plainDevice;
  let clipType: string | null = null;
  const replaced = new Map<string, (string | null)[]>();
  if (standard) {
    const mainId = models[0]!;
    const spec = MODEL_LOADERS[main.class_type]!;
    recipeParts.push({ role: spec.role, slot: null, file: match(main.inputs[spec.input]), added: false });
    replaced.set(mainId, checkpoint ? ["$model", "$clip", "$vae"] : ["$model"]);
    if (clips[0]) {
      const n = wf[clips[0]]!;
      const files = CLIP_LOADERS[n.class_type]!.map((k) => match(n.inputs[k]));
      const scanned = files.map((f) => parts.find((p) => p.file === f)?.slot ?? null);
      const slots = scanned.every((s) => s) && new Set(scanned).size === scanned.length ? scanned : files.map((_, i) => `te${i + 1}`);
      files.forEach((file, i) => recipeParts.push({ role: "text_encoder", slot: slots[i]!, file, added: checkpoint }));
      clipType = typeof n.inputs.type === "string" ? n.inputs.type : null;
      replaced.set(clips[0], ["$clip"]);
    }
    if (vaes[0]) {
      recipeParts.push({ role: "vae", slot: null, file: match(wf[vaes[0]]!.inputs.vae_name), added: checkpoint });
      replaced.set(vaes[0], ["$vae"]);
    }
    // Model-only LoRAs in one chain straight off the model become the recipe's LoRAs, while nothing else uses
    // the model before them (the recipe applies them to every use of it).
    const users = (id: string, out: number) => ids().filter((u) => Object.values(wf[u]!.inputs).some((v) => isLink(v) && v[0] === id && v[1] === out));
    let at = mainId;
    for (;;) {
      const next = users(at, 0);
      if (next.length !== 1 || wf[next[0]!]!.class_type !== "LoraLoaderModelOnly") break;
      const lora = wf[next[0]!]!;
      const file = matchFile(String(lora.inputs.lora_name ?? ""), parts);
      if (!file || typeof lora.inputs.strength_model !== "number") break;
      loras.push({ file, strength: Math.max(-4, Math.min(4, lora.inputs.strength_model)) });
      replaced.set(next[0]!, ["$model"]);
      at = next[0]!;
    }
    for (const id of replaced.keys()) delete wf[id];
    for (const n of Object.values(wf)) {
      for (const [k, v] of Object.entries(n.inputs)) {
        if (!isLink(v) || !replaced.has(v[0])) continue;
        const to = replaced.get(v[0])![v[1]];
        if (!to) throw invalid(`Node input ${k} uses an output its loader doesn't have.`);
        n.inputs[k] = to;
      }
    }
  }
  // Every other model file the workflow loads: this host's path for it.
  for (const n of Object.values(wf)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (typeof v !== "string" || !MODEL_FILE.test(v)) continue;
      const m = match(v);
      if (m) n.inputs[k] = m;
    }
  }

  // Blanks.
  const defaults: Record<string, string | number> = {};
  const blank = (id: string, input: string, name: string, keep = true) => {
    const v = wf[id]!.inputs[input];
    if (keep && (typeof v === "string" || typeof v === "number") && defaults[name] === undefined) defaults[name] = v;
    wf[id]!.inputs[input] = `$${name}`;
  };
  const literal = (id: string, input: string) => {
    const v = wf[id]!.inputs[input];
    return typeof v === "number" || (typeof v === "string" && !v.startsWith("$"));
  };
  const first = (input: string, test: (id: string) => boolean = () => true) => ids().find((id) => input in wf[id]!.inputs && literal(id, input) && test(id));
  for (const id of ids()) for (const k of ["seed", "noise_seed"]) if (k in wf[id]!.inputs && literal(id, k) && typeof wf[id]!.inputs[k] === "number") blank(id, k, "seed", false);
  const once: [string, string][] = [["steps", "steps"], ["cfg", "cfg"], ["sampler_name", "sampler"], ["scheduler", "scheduler"], ["shift", "shift"], ["guidance", "guidance"]];
  for (const [input, name] of once) {
    const id = first(input, (i) => (input === "sampler_name" || input === "scheduler" ? typeof wf[i]!.inputs[input] === "string" : typeof wf[i]!.inputs[input] === "number"));
    if (id) blank(id, input, name);
  }
  const TEXT = ["text", "prompt", "clip_l", "t5xxl", "text_g", "text_l"];
  const textNode = (link: unknown, depth = 0): string | null => {
    if (!isLink(link) || depth > 6 || !wf[link[0]]) return null;
    const n = wf[link[0]]!;
    if (TEXT.some((k) => typeof n.inputs[k] === "string")) return link[0];
    for (const v of Object.values(n.inputs)) {
      const found = textNode(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const guided = ids().find((id) => isLink(wf[id]!.inputs.positive));
  const pos = guided ? textNode(wf[guided]!.inputs.positive) : ids().find((id) => wf[id]!.class_type === "CLIPTextEncode") ?? null;
  const neg = guided ? textNode(wf[guided]!.inputs.negative) : null;
  if (pos) for (const k of TEXT) if (typeof wf[pos]!.inputs[k] === "string" && !(wf[pos]!.inputs[k] as string).startsWith("$")) blank(pos, k, "prompt", false);
  if (neg && neg !== pos) for (const k of TEXT) if (typeof wf[neg]!.inputs[k] === "string" && !(wf[neg]!.inputs[k] as string).startsWith("$")) blank(neg, k, "negativePrompt");
  const latent = ids().find((id) => /Empty.*Latent|ImageToVideo|LatentVideo/i.test(wf[id]!.class_type) && typeof wf[id]!.inputs.width === "number" && typeof wf[id]!.inputs.height === "number");
  let framesFound: number | null = null;
  if (latent) {
    blank(latent, "width", "width");
    blank(latent, "height", "height");
    const n = wf[latent]!.inputs;
    if (video && typeof n.length === "number") {
      framesFound = n.length;
      blank(latent, "length", "frames", false);
    } else if (!video && typeof n.batch_size === "number") blank(latent, "batch_size", "count", false);
  }
  if (video) {
    const fps = first("fps", (i) => typeof wf[i]!.inputs.fps === "number") ?? first("frame_rate", (i) => typeof wf[i]!.inputs.frame_rate === "number");
    if (fps) {
      const k = "fps" in wf[fps]!.inputs ? "fps" : "frame_rate";
      fpsFound ??= wf[fps]!.inputs[k] as number;
      blank(fps, k, "fps", false);
    }
  }
  const loads = ids().filter((id) => wf[id]!.class_type === "LoadImage" && typeof wf[id]!.inputs.image === "string");
  if (does === "edit" || does === "animate") loads.forEach((id, i) => (wf[id]!.inputs.image = i === 0 ? "$image" : `$reference${i}`));
  for (const n of Object.values(wf)) if (n.class_type === "LoadImage") delete n.inputs.upload;

  const keepDefault = (k: string, v: string | number) => k === "negativePrompt" ? typeof v === "string" && v.length <= 4096 : k === "sampler" || k === "scheduler" ? /^[a-z0-9_]{1,64}$/.test(String(v)) : typeof v === "number";
  for (const [k, v] of Object.entries(defaults)) if (!keepDefault(k, v)) delete defaults[k];

  const fps = Math.min(120, Math.max(1, Math.round(fpsFound ?? 16)));
  const frames = framesFound ?? 81;
  const [frameStep, frameOffset] = (frames - 1) % 8 === 0 ? [8, 1] : (frames - 1) % 4 === 0 ? [4, 1] : [1, 0];
  const mainFile = recipeParts[0]?.file ?? null;
  return {
    label: label(name), does, arch: parts.find((p) => p.file === mainFile)?.arch ?? "custom", workflow: wf,
    loaders: standard ? null : "template", clipType,
    video: video ? { fps, frameStep, frameOffset, sizeStep: 16, maxSeconds: Math.min(15, Math.max(1, Math.floor(frames / fps))), audio: false } : null,
    parts: recipeParts, loras, defaults, unmatched, dropped,
  };
}

/** Every `$name` a workflow uses, links included. */
function blanksIn(wf: Record<string, Node>): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("$")) out.add(v);
    else if (v && typeof v === "object" && "$pick" in v) for (const p of (v as { $pick: unknown[] }).$pick) add(p);
  };
  for (const n of Object.values(wf)) for (const v of Object.values(n.inputs)) add(v);
  return out;
}

/** The model files a workflow's own nodes load. */
export function filesIn(wf: Record<string, Node>): string[] {
  const out = new Set<string>();
  for (const n of Object.values(wf)) for (const v of Object.values(n.inputs)) if (typeof v === "string" && MODEL_FILE.test(v) && !v.startsWith("$")) out.add(v);
  return [...out];
}

/**
 * What stops a custom template from saving, and the node types ComfyUI lacks. `base` is the built-in template a
 * copy came from: its own blanks and node types are allowed too.
 */
export function checkTemplate(t: Pick<Template, "workflow" | "does" | "loaders" | "parts" | "video">, nodes: NodeList | null, base?: Template): Check {
  const problems: string[] = [];
  const wf = t.workflow;
  const does = t.does.join(" and ");
  const video = t.does.some((a) => a === "video" || a === "animate");
  const allowed = new Set([...t.does.flatMap((a) => BLANKS[a] ?? []).map((b) => `$${b}`), ...(t.loaders === "template" ? [] : LINKS)]);
  const baseClasses = new Set<string>();
  if (base) {
    for (const b of blanksIn(base.workflow)) allowed.add(b);
    for (const n of Object.values(base.workflow)) baseClasses.add(n.class_type);
    for (const n of Object.values(base.continuation?.workflow ?? {})) baseClasses.add(n.class_type);
  }
  const used = blanksIn(wf);
  for (const b of used) if (!allowed.has(b)) problems.push(`${b} isn't a blank the host fills when the workflow does ${does}${LINKS.includes(b) ? ": this workflow loads its own files" : ""}.`);
  // A copy keeps the blanks its built-in had; an import needs those of its action.
  if (!base) for (const need of t.does.flatMap((a) => NEEDS[a] ?? [])) if (!used.has(`$${need}`)) problems.push(`The workflow needs a $${need} blank to do ${does}.`);
  for (const link of LINKS.filter((l) => used.has(l))) {
    const role = { $model: ["checkpoint", "diffusion"], $clip: ["checkpoint", "text_encoder"], $vae: ["checkpoint", "vae"] }[link]!;
    if (t.loaders !== "template" && !t.parts.some((p) => role.includes(p.role))) problems.push(`${link} is used, but the recipe has no part that gives it.`);
  }
  const out = video ? VIDEO_OUT : IMAGE_OUT;
  if (!Object.values(wf).some((n) => n.class_type === out)) problems.push(`The workflow has no ${out} node, so nothing would come back.`);
  for (const [id, n] of Object.entries(wf)) {
    if (n.class_type !== IMAGE_OUT && n.class_type !== VIDEO_OUT && !baseClasses.has(n.class_type) && (WRITES.test(n.class_type) || (nodes?.[n.class_type]?.output ?? false))) {
      problems.push(`Node ${id} (${n.class_type}) writes files or is an output of its own; only ${out} may stay.`);
    }
    for (const [k, v] of Object.entries(n.inputs)) {
      if (isLink(v) && !(v[0] in wf)) problems.push(`Node ${id}'s ${k} links to node ${v[0]}, which isn't in the workflow.`);
      if (typeof v === "string" && !v.startsWith("$") && (v.includes("..") && /[\\/]/.test(v) || /^([\\/]|[A-Za-z]:)/.test(v))) problems.push(`Node ${id}'s ${k} names a path outside the models folder.`);
      if (READS.test(n.class_type) && typeof v === "string" && !v.startsWith("$") && /^(image|video|audio|file)$/.test(k)) {
        problems.push(`Node ${id} (${n.class_type}) reads a fixed file; make its ${k} a blank such as $image.`);
      }
    }
  }
  if (video && !t.video) problems.push("A video workflow needs its clip settings.");
  const missingNodes = nodes ? [...new Set(Object.values(wf).map((n) => n.class_type))].filter((c) => !(c in nodes)).sort() : null;
  return { problems, missingNodes };
}

/** A clip's settings as a manager may set them for a custom video workflow. */
export function videoSpec(v: unknown): VideoSpec {
  if (!v || typeof v !== "object") throw invalid("video must be an object.");
  const o = v as Record<string, unknown>;
  const whole = (k: string, min: number, max: number) => {
    const n = o[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw invalid(`video.${k} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  if (typeof o.audio !== "boolean") throw invalid("video.audio must be true or false.");
  return { fps: whole("fps", 1, 120), frameStep: whole("frameStep", 1, 64), frameOffset: whole("frameOffset", 0, 64), sizeStep: whole("sizeStep", 1, 128), maxSeconds: whole("maxSeconds", 1, 15), audio: o.audio };
}

/** The parts a recipe of a custom template has: the roles of this host's files, given by the manager's draft. */
export function recipeParts(v: unknown, files: Part[]): RecipePart[] {
  if (!Array.isArray(v) || v.length > 8) throw invalid("parts must be a list of at most 8.");
  const roles: Role[] = ["checkpoint", "diffusion", "text_encoder", "vae"];
  return v.map((p: Record<string, unknown>) => {
    if (!p || !roles.includes(p.role as Role)) throw invalid(`A part's role must be one of ${roles.join(", ")}.`);
    if (p.slot !== null && (typeof p.slot !== "string" || !/^[\w.-]{1,32}$/.test(p.slot))) throw invalid("A part's slot must be a short name or null.");
    if (p.file !== null && !files.some((f) => f.file === p.file)) throw invalid(`${String(p.file)} isn't on this host.`);
    return { role: p.role as Role, slot: (p.slot as string | null) ?? null, file: (p.file as string | null) ?? null, added: p.added === true };
  });
}

/** The template parts a custom recipe's parts call for. */
export function partSpecs(parts: RecipePart[]): PartSpec[] {
  return parts.map((p) => ({ role: p.role, ...(p.role === "text_encoder" ? { slot: p.slot } : {}), ...(p.added ? { optional: true } : {}) }));
}

/** Custom templates on disk (`<data>/workflows/<name>.json`) and the node list ComfyUI last reported. */
export class Workflows {
  private readonly dir: string;
  private readonly nodesPath: string;
  private nodeList: NodeList | null;

  constructor(dataDir: string, templates: Map<string, Template>) {
    this.dir = join(dataDir, "workflows");
    this.nodesPath = join(dataDir, "comfy-nodes.json");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(this.dir).filter((f) => /^custom-[0-9a-f]{8}\.json$/.test(f))) {
      try {
        const t = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Template;
        templates.set(f.slice(0, -5), { ...t, name: f.slice(0, -5) });
      } catch {
        // A file that doesn't read stays on disk; its recipes say the host has no such template.
      }
    }
    try {
      this.nodeList = existsSync(this.nodesPath) ? JSON.parse(readFileSync(this.nodesPath, "utf8")) : null;
    } catch {
      this.nodeList = null;
    }
  }

  newName(taken: Map<string, Template>): string {
    for (;;) {
      const name = `custom-${randomBytes(4).toString("hex")}`;
      if (!taken.has(name)) return name;
    }
  }

  /**
   * Saves a custom template. With `previous`, the version it replaces joins the workflow's revisions
   * (`<name>.revisions.json`, the newest last, at most MAX_REVISIONS), and the new one gets the next number.
   */
  save(t: Template, previous?: Template, by: Revision["by"] = "app"): Template {
    const saved: Template = { ...t, custom: { ...t.custom!, revision: previous ? (previous.custom?.revision ?? 1) + 1 : 1, saved: new Date().toISOString(), by } };
    if (previous) {
      const revisions = this.revisions(t.name);
      revisions.push({ ...previous, name: undefined } as unknown as Template);
      this.write(join(this.dir, `${t.name}.revisions.json`), revisions.slice(-MAX_REVISIONS));
    }
    this.write(join(this.dir, `${t.name}.json`), { ...saved, name: undefined });
    return saved;
  }

  /** The versions a workflow had before its current one, oldest first. */
  revisions(name: string): Template[] {
    const path = join(this.dir, `${name}.revisions.json`);
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Template[]).map((t) => ({ ...t, name })) : [];
    } catch {
      return [];
    }
  }

  private write(path: string, value: unknown): void {
    writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  remove(name: string): void {
    for (const f of [`${name}.json`, `${name}.revisions.json`]) {
      try {
        unlinkSync(join(this.dir, f));
      } catch {}
    }
  }

  get nodes(): NodeList | null {
    return this.nodeList;
  }

  /** ComfyUI's `/object_info`, kept small: each type's inputs (a choice's first 200 options) and whether it is an output. */
  saveNodes(info: Record<string, { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }; output_node?: boolean }>): void {
    const list: NodeList = {};
    for (const [cls, n] of Object.entries(info)) {
      const inputs: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries({ ...n.input?.required, ...n.input?.optional })) {
        const kind = Array.isArray(spec) ? spec[0] : spec;
        inputs[k] = Array.isArray(kind) ? kind.filter((o) => typeof o === "string").slice(0, 200) : typeof kind === "string" ? kind : "unknown";
      }
      list[cls] = { inputs, output: n.output_node === true };
    }
    this.nodeList = list;
    writeFileSync(`${this.nodesPath}.tmp`, JSON.stringify(list), { mode: 0o600 });
    renameSync(`${this.nodesPath}.tmp`, this.nodesPath);
  }
}
