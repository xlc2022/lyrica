// Workflow templates (host/workflows/<name>.json), one per architecture and
// action. A request names a recipe and gives parameters; the host fills the
// recipe's template with them. Nothing a client sends becomes a node or a
// node type.
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Role } from "./parts.ts";

export type Action = "create" | "edit" | "upscale";

export interface PartSpec {
  role: Role;
  slot?: string;
  arch?: string[];
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
  workflow: Record<string, Node>;
}

export interface FilledPart {
  role: Role;
  slot: string | null;
  file: string;
  added: boolean;
}

export type Values = Record<string, string | number>;

export function loadTemplates(dir: string): Map<string, Template> {
  const out = new Map<string, Template>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
    out.set(f.slice(0, -5), { ...t, name: f.slice(0, -5) });
  }
  return out;
}

type Link = [string, number];

/** Loader nodes for the recipe's parts: model, clip and VAE outputs, with LoRAs applied to the model. */
function loaders(t: Template, parts: FilledPart[], loras: { file: string; strength: number }[]) {
  const nodes: Record<string, Node> = {};
  const gguf = (f: string) => f.endsWith(".gguf");
  let model: Link | null = null;
  let clip: Link | null = null;
  let vae: Link | null = null;
  const checkpoint = parts.find((p) => p.role === "checkpoint");
  if (checkpoint) {
    nodes.load_checkpoint = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint.file } };
    [model, clip, vae] = [["load_checkpoint", 0], ["load_checkpoint", 1], ["load_checkpoint", 2]];
  }
  const diffusion = parts.find((p) => p.role === "diffusion");
  if (diffusion) {
    nodes.load_model = gguf(diffusion.file)
      ? { class_type: "UnetLoaderGGUF", inputs: { unet_name: diffusion.file } }
      : { class_type: "UNETLoader", inputs: { unet_name: diffusion.file, weight_dtype: "default" } };
    model = ["load_model", 0];
  }
  // Text encoders in the template's slot order.
  const slots = t.parts.filter((s) => s.role === "text_encoder").map((s) => s.slot);
  const encoders = slots.map((slot) => parts.find((p) => p.role === "text_encoder" && p.slot === slot)?.file).filter((f): f is string => !!f);
  if (encoders.length && encoders.length === slots.length) {
    const anyGguf = encoders.some(gguf);
    nodes.load_clip = encoders.length === 1
      ? { class_type: anyGguf ? "CLIPLoaderGGUF" : "CLIPLoader", inputs: { clip_name: encoders[0], type: t.clipType } }
      : { class_type: anyGguf ? "DualCLIPLoaderGGUF" : "DualCLIPLoader", inputs: { clip_name1: encoders[0], clip_name2: encoders[1], type: t.clipType } };
    clip = ["load_clip", 0];
  }
  const vaePart = parts.find((p) => p.role === "vae");
  if (vaePart) {
    nodes.load_vae = { class_type: "VAELoader", inputs: { vae_name: vaePart.file } };
    vae = ["load_vae", 0];
  }
  loras.forEach((l, i) => {
    nodes[`lora_${i}`] = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: l.file, strength_model: l.strength } };
    model = [`lora_${i}`, 0];
  });
  return { nodes, links: { $model: model, $clip: clip, $vae: vae } };
}

/** The ComfyUI prompt for one request. Throws if a value the template needs is missing. */
export function fill(t: Template, parts: FilledPart[], loras: { file: string; strength: number }[], values: Values): Record<string, Node> {
  const { nodes, links } = t.loaders === "template" ? { nodes: {}, links: {} as Record<string, Link | null> } : loaders(t, parts, loras);
  const graph: Record<string, Node> = {};
  for (const [id, node] of Object.entries(t.workflow)) {
    if (node._if && values[node._if] === undefined) continue;
    graph[id] = { class_type: node.class_type, inputs: { ...node.inputs } };
  }
  const resolve = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("$")) {
      if (v in links) {
        const link = (links as Record<string, Link | null>)[v];
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
