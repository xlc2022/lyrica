// The Image models tab's pure parts (src/ImageModels.tsx): a host's recipes and parts as host/API.md gives them, the
// words for them, the rows they make, and what deleting one would delete. Kept apart so a test can check them.

export type Role = "checkpoint" | "diffusion" | "text_encoder" | "vae" | "lora" | "upscaler" | "unknown";

/** An image model file in a host's models folder (host/API.md, "Parts"). */
export interface HostPart {
  file: string; size: number; format?: string; role: Role; slot: string | null; arch: string | null; precision: string | null;
  /** In the host's download record: Lyrica downloaded it, so it may be deleted. */
  downloaded: boolean;
  /** The recipes that use it, by ID. */
  usedBy: string[];
}

/** A recipe: what Lyrica calls, made of parts (host/API.md, "Recipes"). */
export interface HostRecipe {
  id: string; name: string; state: "proposed" | "confirmed" | "ignored"; ready: boolean; arch: string; template: string;
  /**
   * A video recipe does `video` and/or `animate`, or `motion` (docs/briefs/video.md, motion-video.md), or `edit_video` (video-edit.md), and with a
   * continuation `extend`; an upscaler with a clip workflow also `upscale_video`.
   */
  does: ("create" | "edit" | "upscale" | "upscale_video" | "video" | "animate" | "motion" | "edit_video" | "extend")[];
  /** Create tiers; absent on older hosts means both. */
  useFor?: "fast" | "quality" | "both";
  parts: { role: Role; slot: string | null; file: string | null; added: boolean; missing?: { source: string; repo: string; path: string; sha256?: string; size?: number } }[];
  loras: { file: string; strength: number }[];
  /** The LoRA files on its host it takes (host/API.md, "Recipes"); a host before them leaves it out. */
  takesLoras?: string[];
  defaults: Record<string, unknown>;
  /** The recipe this one was copied from. */
  base: string | null;
  /** The starter recipe it was made from. */
  starter?: string | null;
  /** Its template is a custom workflow, added on its host (host/API.md, "Custom workflows"). */
  custom?: boolean;
  /** For a custom workflow made from a built-in template (a model's own edit of it, or a copy): that template. */
  workflowBase?: string | null;
}

/** One host's image library, as GET …/hosts/:id/images gives it (its parts flattened from by-role). */
export interface HostLibrary { hostId: string; host: string; recipes: HostRecipe[]; parts: HostPart[] }

export const ROLE_WORD: Record<Role, string> = {
  checkpoint: "Checkpoint", diffusion: "Diffusion model", text_encoder: "Text encoder", vae: "VAE", lora: "LoRA", upscaler: "Upscaler", unknown: "Unknown",
};
/** A role inside a sentence: "text encoder", but "VAE" and "LoRA" as they are. */
export const roleWord = (r: Role) => (r === "vae" || r === "lora" ? ROLE_WORD[r] : ROLE_WORD[r].toLowerCase());
const SLOT_WORD: Record<string, string> = { clip_l: "CLIP-L", clip_g: "CLIP-G", t5: "T5", "qwen2.5vl": "Qwen2.5-VL", qwen3: "Qwen3", qwen3vl: "Qwen3-VL", qwen3vl_8b: "Qwen3-VL 8B", ph3: "P-H3-Image" };
export const slotWord = (s: string) => SLOT_WORD[s] ?? s;
const ARCH_WORD: Record<string, string> = { sdxl: "SDXL", flux: "FLUX", "z-image": "Z-Image", "qwen-image": "Qwen-Image", "qwen-image-2.1": "Qwen-Image 2.1", krea2: "Krea 2", seedvr2: "SeedVR2", "p-h3-image": "P-H3-Image" };
export const archWord = (a: string) => ARCH_WORD[a] ?? a;
export const precisionWord = (p: string | null) => (p ? p.toUpperCase() : "");
export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A recipe's defaults as its copy block's caption says them: "8 steps · CFG 1 · euler · 1024×1024". */
export function defaultsWords(d: Record<string, unknown>): string {
  const n = (k: string) => (typeof d[k] === "number" ? d[k] : undefined);
  return [
    n("steps") !== undefined ? `${n("steps")} ${n("steps") === 1 ? "step" : "steps"}` : "",
    n("cfg") !== undefined ? `CFG ${n("cfg")}` : "",
    n("guidance") !== undefined ? `guidance ${n("guidance")}` : "",
    typeof d.sampler === "string" ? d.sampler : "",
    typeof d.scheduler === "string" ? d.scheduler : "",
    n("width") && n("height") ? `${n("width")}×${n("height")}` : "",
    n("scale") !== undefined ? `to ${n("scale")}×` : "",
    n("maxSize") !== undefined ? `up to ${n("maxSize")} px` : "",
  ].filter(Boolean).join(" · ");
}

/** A recipe's parts it doesn't have yet: how many, and the bytes of those the host knows where to find. */
export function missingOf(r: HostRecipe): { count: number; bytes: number; known: number } {
  const gone = r.parts.filter((p) => !p.file);
  return { count: gone.length, bytes: gone.reduce((n, p) => n + (p.missing?.size ?? 0), 0), known: gone.filter((p) => p.missing).length };
}

/** A recipe's files by name, its first part first: the ones here and the ones it is missing. */
export const recipeFiles = (r: HostRecipe) => [...r.parts.map((p) => p.file ?? p.missing?.path), ...r.loras.map((l) => l.file)].filter((f): f is string => !!f).map(fileName);

/** One recipe on one host. */
export interface RecipeCopy { hostId: string; host: string; recipe: HostRecipe }

/** A row of the Models list: the copies of one recipe name across the hosts, confirmed first, and its pill. */
export interface ImageRow { key: string; name: string; copies: RecipeCopy[]; pill?: "to confirm" | "parts missing" }

/**
 * The Models list: a row per recipe name, its copies on every host. Ignored recipes are left out, and so is a row
 * that is only proposals (To review has those). Rows with a proposal come first, then by name.
 */
export function recipeRows(libs: HostLibrary[]): ImageRow[] {
  const rows = new Map<string, ImageRow>();
  for (const lib of libs) for (const recipe of lib.recipes) {
    if (recipe.state === "ignored") continue;
    const key = recipe.name.trim().toLowerCase();
    const row = rows.get(key) ?? { key, name: recipe.name, copies: [] };
    row.copies.push({ hostId: lib.hostId, host: lib.host, recipe });
    rows.set(key, row);
  }
  const out: ImageRow[] = [];
  for (const row of rows.values()) {
    const proposed = row.copies.filter((c) => c.recipe.state === "proposed");
    if (proposed.length === row.copies.length) continue;
    row.copies.sort((a, b) => Number(a.recipe.state === "proposed") - Number(b.recipe.state === "proposed"));
    if (proposed.length) row.pill = proposed.some((c) => missingOf(c.recipe).count) ? "parts missing" : "to confirm";
    out.push(row);
  }
  return out.sort((a, b) => Number(!a.pill) - Number(!b.pill) || a.name.localeCompare(b.name));
}

/** A group's models with the starred ones first, each part keeping its order (as Text models lists them). */
export const starredFirst = <T>(items: T[], starred: (x: T) => boolean): T[] => [...items.filter(starred), ...items.filter((x) => !starred(x))];

/**
 * What deleting a recipe deletes: the parts Lyrica downloaded that no other recipe still in use needs. The rest stays,
 * each with why. An ignored recipe doesn't keep a file, as on the host (host/src/recipes.ts, `remove`).
 */
export function deletePlan(r: HostRecipe, parts: HostPart[], recipeOf: (id: string) => Pick<HostRecipe, "name" | "state"> | undefined): { goes: HostPart[]; keeps: { file: string; why: string }[]; frees: number } {
  const goes: HostPart[] = [];
  const keeps: { file: string; why: string }[] = [];
  for (const file of [...r.parts.map((p) => p.file), ...r.loras.map((l) => l.file)]) {
    if (!file) continue;
    const part = parts.find((p) => p.file === file);
    const others = (part?.usedBy ?? []).filter((id) => id !== r.id).map(recipeOf).flatMap((o) => (o && o.state !== "ignored" ? [o.name] : []));
    if (part?.downloaded && !others.length) goes.push(part);
    else keeps.push({ file, why: !part?.downloaded ? "not Lyrica's" : `${others.join(" and ")} ${others.length > 1 ? "use" : "uses"} it` });
  }
  return { goes, keeps, frees: goes.reduce((n, p) => n + p.size, 0) };
}

/** The name a recipe with a LoRA built in is saved as: "Z-Image Turbo + pixel art". */
export const withLora = (name: string, lora: string) => `${name} + ${fileName(lora).replace(/\.(safetensors|gguf)$/i, "").replace(/[-_]+/g, " ").trim()}`;

/** The parts Add part offers: a LoRA always; a VAE and a text encoder for a checkpoint that has none added. */
export function addableRoles(r: HostRecipe): Role[] {
  const roles: Role[] = ["lora"];
  if (r.parts.some((p) => p.role === "checkpoint")) for (const role of ["vae", "text_encoder"] as const) if (!r.parts.some((p) => p.role === role)) roles.push(role);
  return roles;
}

/**
 * What a workflow's loader blanks stand for when a job runs, as the host fills them (host/src/templates.ts, `loaders`):
 * `model` is the model file with the LoRAs the host chains onto it in order ("flux1-dev + LoRA flux-style (0.7)"),
 * `clip` the text encoders, `vae` the VAE; a slot's blank (`model_high`) is that expert's, which takes the LoRAs made
 * for it (the part's slot on the host) and those made for neither. Edit workflow shows them as the blanks' tooltips.
 */
export function loaderWords(
  parts: Pick<HostRecipe["parts"][number], "role" | "slot" | "file">[], loras: HostRecipe["loras"], hostParts: Pick<HostPart, "file" | "slot">[],
): Record<string, string> {
  const short = (f: string) => fileName(f).replace(/\.(safetensors|gguf|ckpt|sft|pt|pth|bin)$/i, "");
  const key = (base: string, slot: string | null) => (slot ? `${base}_${slot}` : base);
  const out: Record<string, string> = {};
  const checkpoint = parts.find((p) => p.role === "checkpoint" && p.file);
  if (checkpoint) out.model = out.clip = out.vae = short(checkpoint.file!);
  for (const p of parts) if (p.role === "diffusion" && p.file) out[key("model", p.slot)] = short(p.file);
  const encoders = parts.filter((p) => p.role === "text_encoder" && p.file).map((p) => short(p.file!));
  if (encoders.length) out.clip = encoders.join(" + ");
  for (const p of parts) if (p.role === "vae" && p.file) out[key("vae", p.slot)] = short(p.file);
  const chain = (target: string, file: string, strength?: number) => {
    if (out[target]) out[target] += ` + LoRA ${short(file)}${strength === undefined ? "" : ` (${strength})`}`;
  };
  // A template's own LoRA part goes onto its slot's expert, or the model.
  for (const p of parts) if (p.role === "lora" && p.slot && p.file) chain(out[key("model", p.slot)] ? key("model", p.slot) : "model", p.file);
  const experts = parts.filter((p) => p.role === "diffusion" && p.slot && p.file).map((p) => p.slot!);
  for (const l of loras) {
    const slot = hostParts.find((p) => p.file === l.file)?.slot ?? null;
    const targets = !experts.length ? [null] : slot && experts.includes(slot) ? [slot] : experts;
    for (const s of targets) chain(key("model", s), l.file, l.strength);
  }
  return out;
}
