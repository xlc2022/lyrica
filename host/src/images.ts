// The image routes in API.md ("Image models"): parts, recipes, starters, and
// create, edit and upscale through ComfyUI.
import { createHash, randomInt } from "node:crypto";
import { mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { imageSize, type Comfy } from "./comfy.ts";
import type { Downloads } from "./downloads.ts";
import { HostError, invalid, notFound, onlyFields, readJson, sendJson } from "./http.ts";
import type { TextModel } from "./library.ts";
import type { Logger } from "./log.ts";
import { scanParts, type Part } from "./parts.ts";
import { COLOR_MATCH, RecipeBook, starterPath, type Recipe, type Starter } from "./recipes.ts";
import type { Runtime } from "./runtime.ts";
import { fill, type Action, type Values } from "./templates.ts";

const IMAGE_LIMIT = 20 * 1024 * 1024;
const MAX_SIDE = 8192;
const MAX_PIXELS = 36_000_000;
const MAX_RESOLUTION = 4096;
const BASE_DEFAULTS: Values = { negativePrompt: "", steps: 20, cfg: 1, sampler: "euler", scheduler: "simple", width: 1024, height: 1024, shift: 3, guidance: 3.5, scale: 2, maxSize: 4096, colorMatch: "lab" };
const IDLE_FREE_MS = 10 * 60_000;

const FIELDS: Record<Action, string[]> = {
  create: ["recipe", "prompt", "negativePrompt", "width", "height", "count", "steps", "cfg", "seed", "references"],
  edit: ["recipe", "prompt", "negativePrompt", "count", "steps", "cfg", "seed", "references", "image", "mask"],
  upscale: ["recipe", "image", "scale", "maxSize", "colorMatch", "seed"],
};

function int(body: Record<string, unknown>, key: string, min: number, max: number, step = 1): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max || v % step !== 0) {
    throw invalid(`${key} must be ${step > 1 ? `a multiple of ${step} ` : "a whole number "}from ${min} to ${max}.`);
  }
  return v;
}

function num(body: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw invalid(`${key} must be a number from ${min} to ${max}.`);
  return v;
}

/** An input image: base64, at most 20 MB, and not too many pixels by its header. */
export function inputImage(value: unknown, key: string): Buffer {
  if (typeof value !== "string") throw invalid(`${key} must be a base64 image.`);
  const data = Buffer.from(value, "base64");
  if (data.length > IMAGE_LIMIT) throw invalid(`${key} is larger than 20 MB.`);
  const size = imageSize(data);
  if (!size) throw invalid(`${key} isn't a PNG, JPEG or WebP image.`);
  // A small file can claim a huge image; the header says how big it decodes.
  if (size.width < 1 || size.height < 1 || size.width > MAX_SIDE || size.height > MAX_SIDE || size.width * size.height > MAX_PIXELS) {
    throw invalid(`${key} may be at most ${MAX_SIDE} pixels a side and ${MAX_PIXELS / 1e6} megapixels.`);
  }
  return data;
}

export class Images {
  readonly book: RecipeBook;
  parts: Part[] = [];
  private readonly runtime: Runtime;
  private readonly comfy: Comfy;
  private readonly downloads: Downloads | null;
  private readonly modelsDir: string;
  private readonly seedvr2Dir: string;
  private readonly comfyGpu: number;
  private readonly log: Logger;
  private readonly idleTimer: NodeJS.Timeout;
  /** Each SeedVR2 part's link name in its folder. */
  private seedvr2Names = new Map<string, string>();

  constructor(o: { book: RecipeBook; runtime: Runtime; comfy: Comfy; downloads: Downloads | null; modelsDir: string; serving: string; comfyGpu: number; log: Logger }) {
    this.book = o.book;
    this.runtime = o.runtime;
    this.comfy = o.comfy;
    this.downloads = o.downloads;
    this.modelsDir = o.modelsDir;
    this.seedvr2Dir = join(o.serving, "seedvr2");
    this.comfyGpu = o.comfyGpu;
    this.log = o.log;
    mkdirSync(this.seedvr2Dir, { recursive: true });
    // ComfyUI keeps parts in memory after a job; free them once it has been idle a while.
    this.idleTimer = setInterval(() => void this.runtime.scheduler.unloadIdle("image", IDLE_FREE_MS), 60_000);
    this.idleTimer.unref();
  }

  close(): void {
    clearInterval(this.idleTimer);
  }

  /** Reads the parts again and proposes recipes for new main parts. */
  scan(): { parts: number; proposals: number } {
    this.parts = scanParts(this.modelsDir);
    const proposals = this.book.propose(this.parts);
    this.linkSeedvr2();
    return { parts: this.parts.length, proposals };
  }

  private files(): Set<string> {
    return new Set(this.parts.map((p) => p.file));
  }

  /**
   * SeedVR2's loaders find files by name in their own folder, so its parts
   * are linked into one (on the serving volume, read-only for ComfyUI). Two
   * parts with the same file name get links prefixed with a hash of their path.
   */
  private linkSeedvr2(): void {
    const files = this.parts.filter((p) => p.arch === "seedvr2").map((p) => p.file);
    const count = new Map<string, number>();
    for (const f of files) count.set(basename(f), (count.get(basename(f)) ?? 0) + 1);
    this.seedvr2Names = new Map(files.map((f) => [f, count.get(basename(f))! > 1 ? `${createHash("sha256").update(f).digest("hex").slice(0, 8)}-${basename(f)}` : basename(f)]));
    const want = new Map([...this.seedvr2Names].map(([f, name]) => [name, join("/models", f)]));
    for (const name of readdirSync(this.seedvr2Dir)) {
      let target: string | null = null;
      try {
        target = readlinkSync(join(this.seedvr2Dir, name));
      } catch {}
      if (want.get(name) !== target) unlinkSync(join(this.seedvr2Dir, name));
    }
    for (const [name, target] of want) {
      try {
        symlinkSync(target, join(this.seedvr2Dir, name));
      } catch {}
    }
  }

  private usedBy(file: string): string[] {
    return this.book.all().filter((r) => r.parts.some((p) => p.file === file) || r.loras.some((l) => l.file === file)).map((r) => r.id);
  }

  async route(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
    const path = url.pathname;
    const files = this.files();
    const record = this.runtime.record;

    if (path === "/host/v1/parts" && method === "GET") {
      sendJson(res, 200, { parts: this.parts.map((p) => ({ ...p, downloaded: record.has(p.file), usedBy: this.usedBy(p.file), vram: null })) });
      return true;
    }
    if (path === "/host/v1/recipes" && method === "GET") {
      const state = url.searchParams.get("state");
      sendJson(res, 200, { recipes: this.book.all().filter((r) => !state || r.state === state).map((r) => this.book.describe(r, files)) });
      return true;
    }
    if (path === "/host/v1/starters" && method === "GET") {
      sendJson(res, 200, {
        starters: this.book.starters.map((s) => ({ ...s, parts: s.parts.map((p) => ({ ...p, present: this.have(p) !== null })) })),
      });
      return true;
    }
    const install = path.match(/^\/host\/v1\/starters\/([\w.-]+)\/install$/);
    if (install && method === "POST") {
      const starter = this.book.starters.find((s) => s.id === install[1]);
      if (!starter) throw notFound("No such starter.");
      // Installing a starter again returns its recipe, and downloads only what's still missing.
      const { recipe, toDownload } = this.book.fromStarter(starter, (p) => this.have(p), (p) => this.downloading(p));
      const downloads = await this.download(toDownload, req);
      sendJson(res, 200, { recipe: this.book.describe(recipe, files), downloads });
      return true;
    }
    const bulk = path.match(/^\/host\/v1\/recipes\/(confirm|ignore)$/);
    if (bulk && method === "POST") {
      const body = await readJson(req);
      onlyFields(body, ["ids"]);
      if (!Array.isArray(body.ids) || !body.ids.every((i) => typeof i === "string")) throw invalid("ids must be a list.");
      const { done, failed } = this.book.setState(body.ids as string[], bulk[1] === "confirm" ? "confirmed" : "ignored");
      sendJson(res, 200, { recipes: done.map((r) => this.book.describe(r, files)), failed });
      return true;
    }
    const one = path.match(/^\/host\/v1\/recipes\/([0-9a-f-]{36})(?:\/(confirm|ignore|copy|download-parts))?$/);
    if (one) {
      const [, id, action] = one;
      if (!action && method === "GET") return sendJson(res, 200, this.book.describe(this.book.get(id!), files)), true;
      if (!action && method === "PATCH") {
        const body = await readJson(req);
        return sendJson(res, 200, this.book.describe(this.book.patch(id!, body, this.parts), files)), true;
      }
      if (!action && method === "DELETE") return sendJson(res, 200, await this.remove(id!)), true;
      if (action === "confirm" || action === "ignore") {
        if (method !== "POST") return false;
        const { done, failed } = this.book.setState([id!], action === "confirm" ? "confirmed" : "ignored");
        if (failed[0]) throw failed[0].message === "No such recipe." ? notFound(failed[0].message) : invalid(failed[0].message);
        return sendJson(res, 200, this.book.describe(done[0]!, files)), true;
      }
      if (action === "copy" && method === "POST") {
        const body = await readJson(req);
        onlyFields(body, ["name"]);
        return sendJson(res, 200, this.book.describe(this.book.copy(id!, body.name), files)), true;
      }
      if (action === "download-parts" && method === "POST") {
        const r = this.book.get(id!);
        const missing = r.parts.filter((p) => !p.file && p.missing);
        const wanted = missing.map((p) => ({ role: p.role, slot: p.slot ?? undefined, ...p.missing!, sha256: p.missing!.sha256 ?? "" }));
        const downloads = await this.download(wanted, req);
        for (const p of missing) {
          p.file = starterPath(p.missing!);
          delete p.missing;
        }
        this.book.save();
        return sendJson(res, 200, { recipe: this.book.describe(r, files), downloads }), true;
      }
    }
    const make = path.match(/^\/host\/v1\/images\/(create|edit|upscale)$/);
    if (make && method === "POST") {
      await this.make(make[1] as Action, req, res);
      return true;
    }
    return false;
  }

  /** Whether a starter part is already queued or downloading. */
  private downloading(p: Starter["parts"][number]): boolean {
    const dest = starterPath(p);
    return !!this.downloads?.inFlight.has(dest);
  }

  /** A starter part already here: at its download path, or a downloaded file with its checksum. */
  private have(p: Starter["parts"][number]): string | null {
    const dest = starterPath(p);
    if (this.parts.some((x) => x.file === dest)) return dest;
    for (const r of this.runtime.record.values()) if (p.sha256 && r.sha256 === p.sha256) return r.path;
    return null;
  }

  /** Starts downloads for parts, grouped by repository, after checking each against its known-good checksum. */
  private async download(parts: { source: string; repo: string; path: string; sha256: string }[], req: IncomingMessage): Promise<unknown[]> {
    if (!parts.length) return [];
    if (!this.downloads) throw new HostError(503, "unavailable", "The download service isn't running.");
    const token = typeof req.headers["x-hub-token"] === "string" ? req.headers["x-hub-token"] : undefined;
    const groups = new Map<string, typeof parts>();
    for (const p of parts) groups.set(`${p.source} ${p.repo}`, [...(groups.get(`${p.source} ${p.repo}`) ?? []), p]);
    const made: unknown[] = [];
    for (const group of groups.values()) {
      const { source, repo } = group[0]!;
      if (source === "huggingface" || source === "modelscope") {
        const listing = await this.downloads.list(source, repo, undefined, token);
        for (const p of group) {
          const f = listing.files.find((x: { path: string }) => x.path === p.path);
          if (!f) throw new HostError(404, "not_found", `${p.path} isn't in ${repo} any more.`);
          if (p.sha256 && f.sha256 && f.sha256 !== p.sha256) throw new HostError(403, "refused", `${p.path} on the hub isn't the known-good file.`);
        }
      }
      const res = await this.downloads.request({ source, repo, files: group.map((p) => p.path) }, token);
      made.push(...res.downloads);
    }
    return made;
  }

  private async remove(id: string) {
    const { candidates, kept } = this.book.remove(id);
    const deleted: string[] = [];
    for (const file of candidates) {
      if (!this.runtime.record.has(file)) {
        kept.push({ file, reason: "Not downloaded by the host." });
        continue;
      }
      try {
        await this.downloads!.remove(file);
        deleted.push(file);
      } catch (e) {
        kept.push({ file, reason: e instanceof HostError && /changed/.test(e.message) ? "Changed since it was downloaded." : e instanceof HostError ? e.message : "Couldn't delete it." });
      }
    }
    if (deleted.length) this.scan();
    return { deleted, kept };
  }

  private async make(action: Action, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, 4 * IMAGE_LIMIT + 1024 * 1024);
    onlyFields(body, FIELDS[action]);
    if (typeof body.recipe !== "string") throw invalid("recipe is missing.");
    const recipe = this.book.all().find((r) => r.id === body.recipe && r.state === "confirmed");
    if (!recipe || !this.book.ready(recipe, this.files())) throw notFound("No confirmed, ready recipe with that ID.");
    if (!recipe.does.includes(action)) throw invalid(`That recipe doesn't ${action} images.`);
    const template = this.book.templates.get(recipe.template)!;

    const values: Values = { ...BASE_DEFAULTS, ...recipe.defaults };
    const uploads: Record<string, Buffer> = {};
    if (action !== "upscale") {
      if (typeof body.prompt !== "string" || !body.prompt) throw invalid("prompt is missing.");
      values.prompt = body.prompt;
      if (body.negativePrompt !== undefined) {
        if (typeof body.negativePrompt !== "string") throw invalid("negativePrompt must be text.");
        values.negativePrompt = body.negativePrompt;
      }
      values.count = int(body, "count", 1, 4) ?? 1;
      values.steps = int(body, "steps", 1, 150) ?? values.steps!;
      values.cfg = num(body, "cfg", 0, 30) ?? values.cfg!;
      if (action === "create") {
        values.width = int(body, "width", 256, 2048, 16) ?? values.width!;
        values.height = int(body, "height", 256, 2048, 16) ?? values.height!;
      }
      const refs = body.references;
      if (refs !== undefined) {
        if (!Array.isArray(refs) || refs.length > template.references) {
          throw invalid(template.references ? `At most ${template.references} references.` : "This recipe doesn't take reference images.");
        }
        refs.forEach((r, i) => (uploads[`reference${i + 1}`] = inputImage(r, "references")));
      }
    }
    if (action === "edit" || action === "upscale") uploads.image = inputImage(body.image, "image");
    if (action === "edit" && body.mask !== undefined) {
      if (!template.mask) throw invalid("This recipe doesn't take a mask.");
      uploads.mask = inputImage(body.mask, "mask");
    }
    if (action === "upscale") {
      const scale = num(body, "scale", 1, 4) ?? Number(values.scale);
      values.maxSize = int(body, "maxSize", 256, 8192) ?? values.maxSize!;
      if (body.colorMatch !== undefined && !COLOR_MATCH.includes(body.colorMatch as string)) throw invalid(`colorMatch must be one of ${COLOR_MATCH.join(", ")}.`);
      values.colorMatch = (body.colorMatch as string) ?? values.colorMatch!;
      const size = imageSize(uploads.image!)!;
      values.resolution = Math.min(MAX_RESOLUTION, Math.round(Math.min(size.width, size.height) * scale));
      for (const p of recipe.parts) if (p.file) values[`${p.role}Name`] = this.seedvr2Names.get(p.file) ?? basename(p.file);
    }
    values.seed = int(body, "seed", 0, 2 ** 48) ?? randomInt(2 ** 47);

    const started = Date.now();
    const model = this.asModel(recipe);
    // A client that goes away cancels its job, queued or running.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const scheduler = this.runtime.scheduler;
    const pngs = await scheduler.run(model, "image", () =>
      scheduler.measuring(model, this.comfyGpu, () =>
        this.comfy.run(uploads, (names) => {
          const parts = recipe.parts.filter((p): p is typeof p & { file: string } => !!p.file);
          return fill(template, parts, recipe.loras, { ...values, ...names });
        }, abort.signal)),
      this.comfyGpu,
      abort.signal,
    );
    if (!pngs.length) throw new HostError(503, "unavailable", "ComfyUI returned no image.");
    const seconds = (Date.now() - started) / 1000;
    this.runtime.count(recipe.id, { requests: 1, images: pngs.length, seconds });
    this.log("image", { recipe: recipe.id, action, images: pngs.length });
    sendJson(res, 200, {
      images: pngs.map((png) => {
        const size = imageSize(png);
        return { png: png.toString("base64"), width: size?.width ?? null, height: size?.height ?? null, seed: values.seed };
      }),
      seconds,
    });
  }

  /** A recipe as the scheduler sees it: ComfyUI's memory for its parts. */
  private asModel(r: Recipe): TextModel {
    const size = [...r.parts.map((p) => p.file), ...r.loras.map((l) => l.file)].reduce((n, f) => n + (this.parts.find((p) => p.file === f)?.size ?? 0), 0);
    return {
      id: `recipe:${r.id}`, kind: "image", server: "comfyui", format: "safetensors", size,
      identity: { basename: r.name, sizeLabel: null, finetune: null, baseModels: [] },
      capabilities: { tools: false, vision: false, embedding: false, reasoning: null },
      contextLength: null, mmproj: null, remoteCode: false,
    };
  }
}
