// Image models are recipes of parts (DESIGN, "Image models are recipes").
// Recipes live in the host's data folder; starters ship in host/recipes/.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HostError, invalid, notFound } from "./http.ts";
import type { Part, Role } from "./parts.ts";
import type { Action, PartSpec, Template } from "./templates.ts";

export interface Missing {
  source: string;
  repo: string;
  path: string;
  sha256: string | null;
  size: number | null;
}

export interface RecipePart {
  role: Role;
  slot: string | null;
  file: string | null;
  added: boolean;
  missing?: Missing;
}

export interface Recipe {
  id: string;
  name: string;
  state: "proposed" | "confirmed" | "ignored";
  arch: string;
  template: string;
  does: Action[];
  parts: RecipePart[];
  loras: { file: string; strength: number }[];
  defaults: Record<string, string | number>;
  base: string | null;
  starter: string | null;
}

export interface Starter {
  id: string;
  name: string;
  template: string;
  parts: { role: Role; slot?: string; source: string; repo: string; path: string; sha256: string; size?: number }[];
  loras: { file: string; strength: number }[];
  defaults: Record<string, string | number>;
}

export const DEFAULT_KEYS = ["steps", "cfg", "sampler", "scheduler", "width", "height", "shift", "guidance", "negativePrompt", "scale", "maxSize", "colorMatch"];

export function loadStarters(dir: string): Starter[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ ...JSON.parse(readFileSync(join(dir, f), "utf8")), id: f.slice(0, -5) }));
}

/** Where a starter's part lands when downloaded. */
export const starterPath = (p: { source: string; repo: string; path: string }) => `lyrica/${p.source}/${p.repo}/${p.path}`;

const prettyName = (file: string) => basename(file).replace(/\.(safetensors|gguf)$/, "").replace(/[_-]+/g, " ");

/** The folder of a downloaded repository (lyrica/<source>/<owner>/<repo>), to prefer parts from the same place. */
const home = (file: string) => file.split("/").slice(0, 4).join("/");

export class RecipeBook {
  private readonly path: string;
  private recipes: Recipe[];
  readonly templates: Map<string, Template>;
  readonly starters: Starter[];

  constructor(dataDir: string, templates: Map<string, Template>, starters: Starter[]) {
    this.path = join(dataDir, "recipes.json");
    this.recipes = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : [];
    this.templates = templates;
    this.starters = starters;
  }

  save(): void {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.recipes, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }

  all(): Recipe[] {
    return this.recipes;
  }

  get(id: string): Recipe {
    const r = this.recipes.find((x) => x.id === id);
    if (!r) throw notFound("No such recipe.");
    return r;
  }

  private template(r: { template: string }): Template {
    const t = this.templates.get(r.template);
    if (!t) throw new HostError(500, "internal", `No template ${r.template}.`);
    return t;
  }

  /** Every part present, and the template's needs covered. */
  ready(r: Recipe, files: Set<string>): boolean {
    if (r.parts.some((p) => !p.file || !files.has(p.file)) || r.loras.some((l) => !files.has(l.file))) return false;
    const t = this.template(r);
    if (r.parts.some((p) => p.role === "checkpoint" && !p.added)) {
      // A checkpoint's own encoders are replaced only as a whole set.
      const added = r.parts.filter((p) => p.added && p.role === "text_encoder").length;
      return added === 0 || added === t.parts.filter((s) => s.role === "text_encoder").length;
    }
    return t.parts.every((s) => r.parts.some((p) => p.role === s.role && (s.slot === undefined || p.slot === s.slot)));
  }

  describe(r: Recipe, files: Set<string>) {
    return { ...r, ready: this.ready(r, files) };
  }

  /** The template for a main part: an edit model gets the edit template when its architecture has one. */
  private templateFor(part: Part): Template | undefined {
    const options = [...this.templates.values()].filter((t) => t.arch === part.arch && (part.role !== "checkpoint" || t.checkpoint));
    const edit = /edit/i.test(basename(part.file));
    return options.find((t) => t.does.includes("edit") === edit) ?? options[0];
  }

  private fits(spec: PartSpec, p: Part): boolean {
    return p.role === spec.role && (spec.slot === undefined || p.slot === spec.slot) && (!spec.arch || spec.arch.includes(p.arch ?? ""));
  }

  /**
   * Proposes a recipe for each diffusion model, checkpoint or upscaler that
   * no recipe uses yet, from matching parts, listing what's missing.
   * Returns how many were proposed.
   */
  propose(parts: Part[]): number {
    const used = new Set(this.recipes.flatMap((r) => r.parts.map((p) => p.file)));
    let made = 0;
    for (const main of parts) {
      if (!["diffusion", "checkpoint", "upscaler"].includes(main.role) || used.has(main.file)) continue;
      const t = this.templateFor(main);
      if (!t) continue; // no template for its architecture: it stays a file
      const starter = this.starters.find((s) => s.template === t.name);
      const recipeParts: RecipePart[] = [{ role: main.role, slot: null, file: main.file, added: false }];
      if (main.role !== "checkpoint") {
        for (const spec of t.parts.filter((s) => s.role !== main.role)) {
          const candidates = parts.filter((p) => this.fits(spec, p));
          const pick = candidates.find((p) => home(p.file) === home(main.file)) ?? candidates[0];
          if (pick) recipeParts.push({ role: spec.role, slot: spec.slot ?? null, file: pick.file, added: false });
          else {
            const known = starter?.parts.find((p) => p.role === spec.role && (spec.slot === undefined || p.slot === spec.slot));
            recipeParts.push({
              role: spec.role, slot: spec.slot ?? null, file: null, added: false,
              ...(known ? { missing: { source: known.source, repo: known.repo, path: known.path, sha256: known.sha256, size: known.size ?? null } } : {}),
            });
          }
        }
      }
      this.recipes.push({
        id: randomUUID(), name: prettyName(main.file), state: "proposed", arch: t.arch, template: t.name, does: t.does,
        parts: recipeParts, loras: [], defaults: { ...(starter?.defaults ?? {}) }, base: null, starter: null,
      });
      used.add(main.file);
      made++;
    }
    if (made) this.save();
    return made;
  }

  setState(ids: string[], state: "confirmed" | "ignored"): Recipe[] {
    const found = ids.map((id) => this.get(id));
    for (const r of found) {
      if (r.state !== "proposed") throw invalid(`${r.name} isn't a proposal.`);
    }
    for (const r of found) r.state = state;
    this.save();
    return found;
  }

  copy(id: string, name: unknown): Recipe {
    if (typeof name !== "string" || !name.trim()) throw invalid("name is missing.");
    const from = this.get(id);
    const copy: Recipe = { ...structuredClone(from), id: randomUUID(), name: name.trim(), state: "confirmed", base: from.id, starter: null };
    this.recipes.push(copy);
    this.save();
    return copy;
  }

  /** One change to a recipe; `parts` is the current scan. */
  patch(id: string, body: Record<string, unknown>, parts: Part[]): Recipe {
    const r = this.get(id);
    const t = this.template(r);
    const part = (file: unknown) => {
      const p = parts.find((x) => x.file === file);
      if (!p) throw invalid("No such part on this host.");
      return p;
    };
    const slot = (body.slot ?? null) as string | null;
    switch (body.op) {
      case "swap": {
        const current = r.parts.find((p) => p.role === body.role && p.slot === slot);
        if (!current) throw invalid("The recipe has no part with that role and slot.");
        const next = part(body.file);
        const spec = t.parts.find((s) => s.role === current.role && (s.slot ?? null) === current.slot);
        const was = current.file ? parts.find((x) => x.file === current.file) : undefined;
        const sameArch = spec?.arch ? spec.arch.includes(next.arch ?? "") : !was || was.arch === next.arch;
        if (next.role !== current.role || next.slot !== current.slot || !sameArch) throw invalid("The new file must have the same role, slot and architecture.");
        current.file = next.file;
        delete current.missing;
        break;
      }
      case "addPart": {
        if (!r.parts.some((p) => p.role === "checkpoint")) throw invalid("Only a checkpoint's own VAE or text encoders can be replaced by adding a part.");
        if (body.role !== "vae" && body.role !== "text_encoder") throw invalid("Only a VAE or a text encoder can be added.");
        const next = part(body.file);
        const spec = t.parts.find((s) => s.role === body.role && (s.slot ?? null) === slot);
        if (!spec || !this.fits(spec, next)) throw invalid("That file doesn't fit this recipe's architecture.");
        r.parts = r.parts.filter((p) => !(p.added && p.role === body.role && p.slot === slot));
        r.parts.push({ role: next.role, slot: next.slot, file: next.file, added: true });
        break;
      }
      case "removePart": {
        const i = r.parts.findIndex((p) => p.added && p.role === body.role && p.slot === slot);
        if (i < 0) throw invalid("Only an added part can be removed.");
        r.parts.splice(i, 1);
        break;
      }
      case "addLora":
      case "setLora": {
        const strength = body.strength;
        if (typeof strength !== "number" || strength < -4 || strength > 4) throw invalid("strength must be a number from -4 to 4.");
        const lora = part(body.file);
        if (lora.role !== "lora" || lora.arch !== r.arch) throw invalid("That isn't a LoRA for this architecture.");
        const existing = r.loras.find((l) => l.file === lora.file);
        if (body.op === "setLora" && !existing) throw invalid("The recipe doesn't use that LoRA.");
        if (existing) existing.strength = strength;
        else r.loras.push({ file: lora.file, strength });
        break;
      }
      case "removeLora":
        if (!r.loras.some((l) => l.file === body.file)) throw invalid("The recipe doesn't use that LoRA.");
        r.loras = r.loras.filter((l) => l.file !== body.file);
        break;
      case "defaults": {
        const d = body.defaults;
        if (!d || typeof d !== "object") throw invalid("defaults must be an object.");
        for (const [k, v] of Object.entries(d)) {
          if (!DEFAULT_KEYS.includes(k)) throw invalid(`Unknown default: ${k}.`);
          if (typeof v !== "string" && typeof v !== "number") throw invalid(`${k} must be a number or text.`);
        }
        Object.assign(r.defaults, d);
        break;
      }
      case "rename":
        if (typeof body.name !== "string" || !body.name.trim()) throw invalid("name is missing.");
        r.name = body.name.trim();
        break;
      default:
        throw invalid("Unknown op.");
    }
    this.save();
    return r;
  }

  /** Which of a recipe's files no other recipe uses, and which are kept for that reason. */
  remove(id: string): { candidates: string[]; kept: { file: string; reason: string }[] } {
    const r = this.get(id);
    this.recipes = this.recipes.filter((x) => x !== r);
    for (const other of this.recipes) if (other.base === r.id) other.base = null;
    this.save();
    const files = [...new Set([...r.parts.map((p) => p.file), ...r.loras.map((l) => l.file)].filter((f): f is string => !!f))];
    const kept: { file: string; reason: string }[] = [];
    const candidates: string[] = [];
    for (const file of files) {
      const user = this.recipes.find((o) => o.state !== "ignored" && (o.parts.some((p) => p.file === file) || o.loras.some((l) => l.file === file)));
      if (user) kept.push({ file, reason: `Used by ${user.name}.` });
      else candidates.push(file);
    }
    return { candidates, kept };
  }

  /** A confirmed recipe from a starter, using parts already here (same path, or same checksum). */
  fromStarter(starter: Starter, have: (p: Starter["parts"][number]) => string | null): { recipe: Recipe; toDownload: Starter["parts"] } {
    const t = this.template(starter);
    const toDownload: Starter["parts"] = [];
    const parts: RecipePart[] = starter.parts.map((p) => {
      const file = have(p);
      if (!file) toDownload.push(p);
      return { role: p.role, slot: p.slot ?? null, file: file ?? starterPath(p), added: false };
    });
    const recipe: Recipe = {
      id: randomUUID(), name: starter.name, state: "confirmed", arch: t.arch, template: t.name, does: t.does,
      parts, loras: [...starter.loras], defaults: { ...starter.defaults }, base: null, starter: starter.id,
    };
    this.recipes.push(recipe);
    this.save();
    return { recipe, toDownload };
  }
}
