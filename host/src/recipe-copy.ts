// Copying an image model to another host (host/API.md, "Copying a model to another host"). The source host
// exports the recipe, its custom workflow if it has one, and where each of its files came from; the target plans
// where each file will be: here already, downloaded from its hub again, or copied from the source by lyricad, which
// carries the pieces between the two hosts. Pure functions: images.ts holds the routes.
import { createHash } from "node:crypto";
import { basename, posix } from "node:path";
import type { RecordEntry } from "./downloads.ts";
import { invalid } from "./http.ts";
import type { Part, Role } from "./parts.ts";
import type { Missing, Recipe, RecipePart } from "./recipes.ts";
import type { Node, Template, VideoSpec } from "./templates.ts";

export type Hub = "huggingface" | "modelscope" | "civitai";
const HUBS: Hub[] = ["huggingface", "modelscope", "civitai"];

/** Where a downloaded file came from: its hub, repository and path there. */
export interface Origin { source: Hub; repo: string; path: string }

/** One file the model uses, as the source host knows it: its size when it is there, its checksum when recorded. */
export interface ExportFile { file: string; size: number | null; sha256: string | null; origin: Origin | null }

export interface Bundle {
  recipe: {
    id: string; name: string; template: string; useFor: "fast" | "quality" | "both";
    parts: (Pick<RecipePart, "role" | "slot" | "file" | "added"> & { missing?: Missing })[];
    loras: { file: string; strength: number }[];
    defaults: Record<string, string | number>;
    starter: string | null;
  };
  /** A custom workflow's own fields; null for a model on a built-in template. */
  workflow: null | {
    label: string; from: "import" | "copy"; base: string | null; does: string; arch: string; loaders: "template" | null;
    clipType: string | null; video: VideoSpec | null; workflow: Record<string, Node>; layout: Record<string, [number, number]> | null;
  };
  files: ExportFile[];
}

/** A file's place on the target: here already, downloaded from its hub, copied from the source, or neither. */
export type How = "here" | "download" | "copy" | "unavailable";
export interface Placed { file: string; to: string; how: How; size: number | null; origin: Origin | null; sha256: string | null; reason?: string }

const ROLES: Role[] = ["checkpoint", "diffusion", "text_encoder", "vae", "lora", "upscaler", "latent_upscaler", "interpolator", "clip_vision", "segmenter", "unknown"];
/** What fetch takes as an upload (fetch/downloads.ts): a copy arrives as one. */
const COPYABLE = /\.(gguf|safetensors)$/i;

/** Every model file a recipe uses: its parts, its LoRAs, and the files its custom workflow's own nodes load. */
function filesOf(r: Recipe, t: Template): string[] {
  return [...new Set([...r.parts.flatMap((p) => (p.file ? [p.file] : [])), ...r.loras.map((l) => l.file), ...(t.custom ? t.files ?? [] : [])])];
}

/** A downloaded file's hub, repository and path there, read from its path (lyrica/<source>/<repo>/<path>). */
export function originOf(file: string, entry: RecordEntry | undefined): Origin | null {
  if (!entry || !HUBS.includes(entry.source as Hub) || !entry.repo) return null;
  const prefix = `lyrica/${entry.source}/${entry.repo}/`;
  return file.startsWith(prefix) ? { source: entry.source as Hub, repo: entry.repo, path: file.slice(prefix.length) } : null;
}

/** A recipe as GET …/recipes/<id>/export gives it. */
export function exportRecipe(r: Recipe, t: Template, parts: Part[], record: Map<string, RecordEntry>): Bundle {
  const files = filesOf(r, t).map((file) => {
    const part = parts.find((p) => p.file === file);
    const entry = record.get(file);
    // Only a file here can be copied: one the recipe names but the host lacks has no size.
    return { file, size: part ? part.size : null, sha256: part && entry ? entry.sha256 : null, origin: originOf(file, entry) };
  });
  return {
    recipe: {
      id: r.id, name: r.name, template: t.custom ? t.custom.base ?? r.template : r.template, useFor: r.useFor ?? "both",
      parts: r.parts.map((p) => ({ role: p.role, slot: p.slot, file: p.file, added: p.added, ...(p.missing ? { missing: p.missing } : {}) })),
      loras: r.loras.map((l) => ({ ...l })), defaults: { ...r.defaults }, starter: r.starter,
    },
    workflow: t.custom ? {
      label: t.custom.name, from: t.custom.from, base: t.custom.base ?? null, does: t.does[0]!, arch: t.arch, loaders: t.loaders ?? null,
      clipType: t.clipType, video: t.video ?? null, workflow: t.workflow, layout: t.custom.layout ?? null,
    } : null,
    files,
  };
}

const text = (v: unknown, what: string, max = 512): string => {
  if (typeof v !== "string" || !v || v.length > max) throw invalid(`${what} must be text of at most ${max} characters.`);
  return v;
};

/** A path in the models folder: relative, with no way out of it. */
function modelPath(v: unknown, what: string): string {
  const p = text(v, what);
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.split("/").some((s) => s === ".." || s === "." || s === "")) throw invalid(`${what} isn't a path in the models folder.`);
  return p;
}

const hex = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null);

function origin(v: unknown): Origin | null {
  if (v === null || v === undefined) return null;
  const o = v as Record<string, unknown>;
  if (!HUBS.includes(o.source as Hub)) throw invalid("A file's origin must be Hugging Face, ModelScope or Civitai.");
  return { source: o.source as Hub, repo: modelPath(o.repo, "An origin's repo"), path: modelPath(o.path, "An origin's path") };
}

/**
 * A bundle as a target host reads it, checked for shape: the workflow's own check comes when it is saved. The
 * defaults are checked by the caller, which knows their ranges.
 */
export function readBundle(body: Record<string, unknown>): Bundle {
  const r = body.recipe as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") throw invalid("recipe is missing.");
  if (typeof r.id !== "string" || !/^[0-9a-f-]{36}$/.test(r.id)) throw invalid("recipe.id must be the source recipe's id.");
  if (!Array.isArray(r.parts) || r.parts.length > 16) throw invalid("recipe.parts must be a list of at most 16.");
  if (!Array.isArray(r.loras) || r.loras.length > 32) throw invalid("recipe.loras must be a list of at most 32.");
  if (!r.defaults || typeof r.defaults !== "object" || Array.isArray(r.defaults)) throw invalid("recipe.defaults must be an object.");
  const parts = r.parts.map((p: Record<string, unknown>) => {
    if (!p || !ROLES.includes(p.role as Role)) throw invalid("A part's role isn't one a host knows.");
    if (p.slot !== null && (typeof p.slot !== "string" || !/^[\w.-]{1,32}$/.test(p.slot))) throw invalid("A part's slot must be a short name or null.");
    const m = p.missing as Record<string, unknown> | undefined;
    const missing = p.file === null && m ? { ...origin(m)!, sha256: hex(m.sha256), size: typeof m.size === "number" ? m.size : null } : undefined;
    return { role: p.role as Role, slot: (p.slot as string | null) ?? null, file: p.file === null ? null : modelPath(p.file, "A part's file"), added: p.added === true, ...(missing ? { missing } : {}) };
  });
  const loras = r.loras.map((l: Record<string, unknown>) => {
    if (typeof l?.strength !== "number" || l.strength < -4 || l.strength > 4) throw invalid("A LoRA's strength must be a number from -4 to 4.");
    return { file: modelPath(l.file, "A LoRA's file"), strength: l.strength };
  });
  if (!Array.isArray(body.files) || body.files.length > 64) throw invalid("files must be a list of at most 64.");
  const files = body.files.map((f: Record<string, unknown>) => ({
    file: modelPath(f?.file, "A file"), size: typeof f.size === "number" && Number.isSafeInteger(f.size) && f.size > 0 ? f.size : null, sha256: hex(f.sha256), origin: origin(f.origin),
  }));
  const w = body.workflow as Record<string, unknown> | null | undefined;
  return {
    recipe: {
      id: r.id, name: text(r.name, "recipe.name", 80).trim(), template: text(r.template, "recipe.template", 64),
      useFor: r.useFor === "fast" || r.useFor === "quality" ? r.useFor : "both", parts, loras,
      defaults: r.defaults as Record<string, string | number>, starter: typeof r.starter === "string" && /^[\w.-]{1,64}$/.test(r.starter) ? r.starter : null,
    },
    workflow: w ? {
      label: text(w.label, "workflow.label", 80), from: w.from === "copy" ? "copy" : "import", base: typeof w.base === "string" ? text(w.base, "workflow.base", 64) : null,
      does: text(w.does, "workflow.does", 16), arch: text(w.arch, "workflow.arch", 40), loaders: w.loaders === "template" ? "template" : null,
      clipType: typeof w.clipType === "string" ? w.clipType : null, video: (w.video ?? null) as VideoSpec | null,
      workflow: w.workflow as Record<string, Node>, layout: (w.layout ?? null) as Record<string, [number, number]> | null,
    } : null,
    files,
  };
}

/**
 * Where each of a bundle's files goes on this host. A file is here when this host has the same path (and, both
 * recorded, the same checksum), a recorded file with its checksum, or one with its name and size. Otherwise one from
 * a hub downloads to the path a download gets (lyrica/<source>/<repo>/<path>), and any other GGUF or safetensors file
 * the source has is copied to lyrica/upload/<name>, prefixed with a hash of its path when that name is taken.
 */
export function place(b: Bundle, parts: Part[], record: Map<string, RecordEntry>): Placed[] {
  const taken = new Set(parts.map((p) => p.file));
  const out: Placed[] = [];
  for (const f of b.files) {
    const base = { file: f.file, size: f.size, origin: f.origin, sha256: f.sha256 };
    const same = parts.find((p) => p.file === f.file);
    const sameSum = !f.sha256 || !record.get(f.file) || record.get(f.file)!.sha256 === f.sha256;
    const bySum = f.sha256 ? [...record.values()].find((e) => e.sha256 === f.sha256 && taken.has(e.path)) : undefined;
    const byName = f.size ? parts.find((p) => basename(p.file) === basename(f.file) && p.size === f.size) : undefined;
    const here = same && sameSum ? same.file : bySum?.path ?? byName?.file;
    if (here) {
      out.push({ ...base, to: here, how: "here" });
      continue;
    }
    if (f.origin) {
      const to = posix.join("lyrica", f.origin.source, f.origin.repo, f.origin.path);
      if (!taken.has(to)) {
        out.push({ ...base, to, how: "download" });
        continue;
      }
    }
    if (!f.size) {
      out.push({ ...base, to: f.file, how: "unavailable", reason: "Not on the other host either." });
      continue;
    }
    if (!COPYABLE.test(f.file)) {
      out.push({ ...base, to: f.file, how: "unavailable", reason: "Only GGUF and safetensors files can be copied: put it there by hand." });
      continue;
    }
    out.push({ ...base, to: copyPath(f.file, taken), how: "copy" });
  }
  return out;
}

/** Where a copied file arrives: lyrica/upload/<name>, prefixed with a hash of its path when that is taken. Takes it. */
export function copyPath(file: string, taken: Set<string>): string {
  let to = posix.join("lyrica", "upload", basename(file));
  if (taken.has(to)) to = posix.join("lyrica", "upload", `${createHash("sha256").update(file).digest("hex").slice(0, 8)}-${basename(file)}`);
  taken.add(to);
  return to;
}

export const copyable = (file: string) => COPYABLE.test(file);

/** A workflow with each file it names moved to where that file is on this host. */
export function moveFiles(wf: Record<string, Node>, to: Map<string, string>): Record<string, Node> {
  const out = structuredClone(wf);
  for (const n of Object.values(out)) for (const [k, v] of Object.entries(n.inputs)) if (typeof v === "string" && to.has(v)) n.inputs[k] = to.get(v)!;
  return out;
}
