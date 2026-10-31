// Workflow templates (host/workflows/<name>.json), one per architecture and
// action. A request names a recipe and gives parameters; the host fills the
// recipe's template with them. Nothing a client sends becomes a node or a
// node type.
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Role } from "./parts.ts";

export type Action = "create" | "edit" | "upscale" | "video" | "animate" | "motion";

/** How a video template's clips are timed and sized. */
export interface VideoSpec {
  fps: number;
  /** Frames come in steps: frames = frameStep × k + frameOffset. */
  frameStep: number;
  frameOffset: number;
  /** Width and height are multiples of this. */
  sizeStep: number;
  maxSeconds: number;
  /** Whether its clips have sound. */
  audio: boolean;
  /** With an interpolator part, how many frames each frame becomes (the clip's fps rises as many times). */
  interpolate?: number;
}

export interface PartSpec {
  role: Role;
  /** null: only a part without a slot (a video VAE, not its audio VAE). */
  slot?: string | null;
  arch?: string[];
  /** A recipe is ready without it; with it, the template's nodes that need it run. */
  optional?: boolean;
  /** For a LoRA the template names: how strongly it applies (default 1). */
  strength?: number;
}

interface Node {
  class_type: string;
  inputs: Record<string, unknown>;
  _if?: string;
}

export interface Template {
  name: string;
  arch: string;
  does: Action[];
  /** A checkpoint can stand in for the diffusion model, text encoders and VAE. */
  checkpoint: boolean;
  clipType: string | null;
  /** "template": the workflow loads its own parts (SeedVR2), by file name. */
  loaders?: "template";
  parts: PartSpec[];
  references: number;
  mask: boolean;
  /** Video templates only. */
  video?: VideoSpec;
  /**
   * The workflow that makes the next clip of a longer video from the clip so far
   * (`host/workflows/<name>-continue.json`): the clip's last `overlap` frames anchor the new clip's start.
   * A chained video's clips are at most `clipSeconds` long; a video that fits one clip is one, with no join to cut at.
   * `promptPrefix` goes before the prompt of each clip after the first: the same prompt alone describes the whole
   * video from its start, so a later clip would play it again from there.
   */
  continuation?: Continuation;
  /**
   * The workflow that upscales a whole clip (`host/workflows/<name>-clip.json`, SeedVR2's): the clip's frames
   * go through the upscaler in batches, and its sound and frame rate are kept.
   */
  clipWorkflow?: Record<string, Node>;
  workflow: Record<string, Node>;
}

export interface FilledPart {
  role: Role;
  slot: string | null;
  file: string;
  added: boolean;
}

export interface Continuation {
  overlap: number; clipSeconds: number; promptPrefix?: string; workflow: Record<string, Node>;
  /** With a still to animate: nodes replacing the workflow's, so every later clip keeps the still's people as a reference, and the prompt's prefix naming it. */
  reference?: { promptPrefix: string; workflow: Record<string, Node> };
}

export type Values = Record<string, string | number>;

/** A LoRA applied to the model, with its part's slot (`high`, `low`) when it was made for one expert. */
export interface Lora { file: string; strength: number; slot?: string | null }

/** A video made of chained clips is at most this long (API.md, "Making videos"). */
export const LONGEST_SECONDS = 60;

/** The longest video a template makes: chained clips when it has a continuation, else one clip. */
export const longestSeconds = (t: Template) => (t.continuation ? LONGEST_SECONDS : t.video?.maxSeconds ?? 0);

/**
 * A file that `continues` another template is that template's continuation, and one that `upscalesClipsFor` one
 * its clip workflow, not templates a recipe can pick.
 */
export function loadTemplates(dir: string): Map<string, Template> {
  const out = new Map<string, Template>();
  const continuations: (Continuation & { continues: string })[] = [];
  const clips: { upscalesClipsFor: string; workflow: Record<string, Node> }[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (typeof t.continues === "string") continuations.push(t);
    else if (typeof t.upscalesClipsFor === "string") clips.push(t);
    else out.set(f.slice(0, -5), { ...t, name: f.slice(0, -5) });
  }
  for (const c of clips) {
    const t = out.get(c.upscalesClipsFor);
    if (!t?.does.includes("upscale")) throw new Error(`${c.upscalesClipsFor}-clip upscales clips for no upscale template`);
    t.clipWorkflow = c.workflow;
  }
  for (const c of continuations) {
    const t = out.get(c.continues);
    if (!t?.video) throw new Error(`${c.continues}-continue continues no video template`);
    t.continuation = { overlap: c.overlap, clipSeconds: c.clipSeconds, ...(c.promptPrefix ? { promptPrefix: c.promptPrefix } : {}), ...(c.reference ? { reference: c.reference } : {}), workflow: c.workflow };
  }
  return out;
}

type Link = [string, number];

/**
 * Loader nodes for the recipe's parts: model, clip and VAE outputs, with LoRAs applied to the model.
 * A part with a slot gets its own link: `$model_high` and `$model_low` for a video model's two
 * experts, `$vae_audio` for an audio VAE. A LoRA the template names (with a slot) goes onto the
 * expert of that slot, or onto the model, in the template's order. Then `loras`, the recipe's own and a request's,
 * go onto the model, or for two experts onto the one a LoRA's slot names, else onto both.
 * A CLIP vision model is `$clipVision`; a segmenter (SAM 3.1, a checkpoint to ComfyUI) `$segmenter`
 * and its text encoder `$segmenterClip`.
 */
function loaders(t: Template, parts: FilledPart[], loras: Lora[]) {
  const nodes: Record<string, Node> = {};
  const links: Record<string, Link | null> = { $model: null, $clip: null, $vae: null };
  const gguf = (f: string) => f.endsWith(".gguf");
  const suffix = (slot: string | null) => (slot ? `_${slot}` : "");
  const checkpoint = parts.find((p) => p.role === "checkpoint");
  if (checkpoint) {
    nodes.load_checkpoint = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint.file } };
    [links.$model, links.$clip, links.$vae] = [["load_checkpoint", 0], ["load_checkpoint", 1], ["load_checkpoint", 2]];
  }
  for (const diffusion of parts.filter((p) => p.role === "diffusion")) {
    const id = `load_model${suffix(diffusion.slot)}`;
    nodes[id] = gguf(diffusion.file)
      ? { class_type: "UnetLoaderGGUF", inputs: { unet_name: diffusion.file } }
      : { class_type: "UNETLoader", inputs: { unet_name: diffusion.file, weight_dtype: "default" } };
    links[`$model${suffix(diffusion.slot)}`] = [id, 0];
  }
  // Text encoders in the template's slot order.
  const slots = t.parts.filter((s) => s.role === "text_encoder").map((s) => s.slot);
  const encoders = slots.map((slot) => parts.find((p) => p.role === "text_encoder" && p.slot === slot)?.file).filter((f): f is string => !!f);
  if (encoders.length && encoders.length === slots.length) {
    const anyGguf = encoders.some(gguf);
    nodes.load_clip = encoders.length === 1
      ? { class_type: anyGguf ? "CLIPLoaderGGUF" : "CLIPLoader", inputs: { clip_name: encoders[0], type: t.clipType } }
      : { class_type: anyGguf ? "DualCLIPLoaderGGUF" : "DualCLIPLoader", inputs: { clip_name1: encoders[0], clip_name2: encoders[1], type: t.clipType } };
    links.$clip = ["load_clip", 0];
  }
  for (const vae of parts.filter((p) => p.role === "vae")) {
    const id = `load_vae${suffix(vae.slot)}`;
    nodes[id] = { class_type: "VAELoader", inputs: { vae_name: vae.file } };
    links[`$vae${suffix(vae.slot)}`] = [id, 0];
  }
  const upscaler = parts.find((p) => p.role === "latent_upscaler");
  if (upscaler) {
    nodes.load_latent_upscaler = { class_type: "LatentUpscaleModelLoader", inputs: { model_name: upscaler.file } };
    links.$latentUpscaler = ["load_latent_upscaler", 0];
  }
  const interpolator = parts.find((p) => p.role === "interpolator");
  if (interpolator) {
    nodes.load_interpolator = { class_type: "FrameInterpolationModelLoader", inputs: { model_name: interpolator.file } };
    links.$interpolator = ["load_interpolator", 0];
  }
  const vision = parts.find((p) => p.role === "clip_vision");
  if (vision) {
    nodes.load_clip_vision = { class_type: "CLIPVisionLoader", inputs: { clip_name: vision.file } };
    links.$clipVision = ["load_clip_vision", 0];
  }
  const segmenter = parts.find((p) => p.role === "segmenter");
  if (segmenter) {
    nodes.load_segmenter = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: segmenter.file } };
    [links.$segmenter, links.$segmenterClip] = [["load_segmenter", 0], ["load_segmenter", 1]];
  }
  const order = (p: FilledPart) => t.parts.findIndex((s) => s.role === "lora" && s.slot === p.slot);
  for (const lora of parts.filter((p) => p.role === "lora" && p.slot).sort((a, b) => order(a) - order(b))) {
    const target = `$model${suffix(lora.slot)}` in links ? `$model${suffix(lora.slot)}` : "$model";
    const id = `lora${suffix(lora.slot)}`;
    const strength = t.parts.find((s) => s.role === "lora" && s.slot === lora.slot)?.strength ?? 1;
    nodes[id] = { class_type: "LoraLoaderModelOnly", inputs: { model: links[target], lora_name: lora.file, strength_model: strength } };
    links[target] = [id, 0];
  }
  // A model with two experts takes a LoRA made for one (`high`, `low`) on that expert, and any other on both.
  const experts = parts.filter((p) => p.role === "diffusion" && p.slot).map((p) => p.slot!);
  loras.forEach((l, i) => {
    const targets = !experts.length ? [null] : l.slot && experts.includes(l.slot) ? [l.slot] : experts;
    for (const slot of targets) {
      const id = `lora_${i}${suffix(slot)}`;
      nodes[id] = { class_type: "LoraLoaderModelOnly", inputs: { model: links[`$model${suffix(slot)}`], lora_name: l.file, strength_model: l.strength } };
      links[`$model${suffix(slot)}`] = [id, 0];
    }
  });
  return { nodes, links };
}

/** The ComfyUI prompt for one request. Throws if a value the template needs is missing. */
export function fill(t: Template, parts: FilledPart[], loras: Lora[], values: Values): Record<string, Node> {
  const { nodes, links } = t.loaders === "template" ? { nodes: {}, links: {} as Record<string, Link | null> } : loaders(t, parts, loras);
  // A loader link a template asks for but no part gives (`$vae_audio` with no audio VAE) is an error below.
  const linkName = (v: string) => /^\$(model|clip|vae|latentUpscaler|interpolator|clipVision|segmenter|segmenterClip)(_\w+)?$/.test(v);
  const graph: Record<string, Node> = {};
  for (const [id, node] of Object.entries(t.workflow)) {
    // `_if` names a value, or an optional part's link: without it the node is left out.
    if (node._if && values[node._if] === undefined && !links[`$${node._if}`]) continue;
    graph[id] = { class_type: node.class_type, inputs: { ...node.inputs } };
  }
  const resolve = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("$")) {
      if (v in links || linkName(v)) {
        const link = links[v];
        if (!link) throw new Error(`the recipe has nothing for ${v}`);
        return link;
      }
      const key = v.slice(1);
      if (values[key] === undefined) throw new Error(`missing value ${key}`);
      return values[key];
    }
    if (v && typeof v === "object" && "$pick" in v) return (v.$pick as Link[]).find((l) => l[0] in graph);
    return v;
  };
  for (const node of Object.values(graph)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      const r = resolve(v);
      // A link to a node that was left out is dropped with it.
      if (r === undefined || (Array.isArray(r) && typeof r[0] === "string" && !(r[0] in graph) && !(r[0] in nodes))) delete node.inputs[k];
      else node.inputs[k] = r;
    }
  }
  return { ...nodes, ...graph };
}
