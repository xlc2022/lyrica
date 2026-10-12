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
  does: ("create" | "edit" | "upscale")[];
  /** Create tiers; absent on older hosts means both. */
  useFor?: "fast" | "quality" | "both";
  parts: { role: Role; slot: string | null; file: string | null; added: boolean; missing?: { source: string; repo: string; path: string; sha256?: string; size?: number } }[];
  loras: { file: string; strength: number }[];
  defaults: Record<string, unknown>;
  /** The recipe this one was copied from. */
  base: string | null;
}

/** One host's image library, as GET …/hosts/:id/images gives it (its parts flattened from by-role). */
export interface HostLibrary { hostId: string; host: string; recipes: HostRecipe[]; parts: HostPart[] }

export const ROLE_WORD: Record<Role, string> = {
  checkpoint: "Checkpoint", diffusion: "Diffusion model", text_encoder: "Text encoder", vae: "VAE", lora: "LoRA", upscaler: "Upscaler", unknown: "Unknown",
};
/** A role inside a sentence: "text encoder", but "VAE" and "LoRA" as they are. */
export const roleWord = (r: Role) => (r === "vae" || r === "lora" ? ROLE_WORD[r] : ROLE_WORD[r].toLowerCase());
const SLOT_WORD: Record<string, string> = { clip_l: "CLIP-L", clip_g: "CLIP-G", t5: "T5", "qwen2.5vl": "Qwen2.5-VL", qwen3: "Qwen3" };
export const slotWord = (s: string) => SLOT_WORD[s] ?? s;
const ARCH_WORD: Record<string, string> = { sdxl: "SDXL", flux: "FLUX", "z-image": "Z-Image", "qwen-image": "Qwen-Image", seedvr2: "SeedVR2" };
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

/** The parts Add a part offers: a LoRA always; a VAE and a text encoder for a checkpoint that has none added. */
export function addableRoles(r: HostRecipe): Role[] {
  const roles: Role[] = ["lora"];
  if (r.parts.some((p) => p.role === "checkpoint")) for (const role of ["vae", "text_encoder"] as const) if (!r.parts.some((p) => p.role === role)) roles.push(role);
  return roles;
}
