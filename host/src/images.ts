// The image routes in API.md ("Image models"): parts, recipes, starters, and
// create, edit and upscale through ComfyUI, and videos from video recipes.
import { createHash, randomInt } from "node:crypto";
import { mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { imageSize, mp4Seconds, mp4Video, type Comfy } from "./comfy.ts";
import type { Downloads } from "./downloads.ts";
import { HostError, invalid, notFound, onlyFields, readJson, sendJson } from "./http.ts";
import type { JobProgress } from "./jobs.ts";
import type { TextModel } from "./library.ts";
import type { Logger } from "./log.ts";
import { scanParts, type Part, type Role } from "./parts.ts";
import { clipSpec, COLOR_MATCH, present, RecipeBook, starterPath, type Recipe, type Starter } from "./recipes.ts";
import type { Runtime } from "./runtime.ts";
import { sdcppArgs, type SdCpp } from "./sdcpp.ts";
import { fill, LONGEST_SECONDS, longestSeconds, type Action, type Continuation, type Values, type VideoSpec } from "./templates.ts";

const IMAGE_LIMIT = 20 * 1024 * 1024;
const MAX_SIDE = 8192;
const MAX_PIXELS = 36_000_000;
const MAX_RESOLUTION = 4096;
const BASE_DEFAULTS: Values = { negativePrompt: "", steps: 20, cfg: 1, sampler: "euler", scheduler: "simple", width: 1024, height: 1024, shift: 3, guidance: 3.5, scale: 2, maxSize: 4096, colorMatch: "lab" };
const IDLE_FREE_MS = 10 * 60_000;
/** How long one clip may take: a 14B model on a 24 GB card can take most of an hour. */
const VIDEO_TIMEOUT_MS = 2 * 60 * 60_000;
const VIDEO_FIELDS = ["recipe", "prompt", "negativePrompt", "image", "drive", "extend", "width", "height", "duration", "steps", "cfg", "seed", "aspectRatio"];
/** A driving clip (`motion`): only its first seconds are used. */
const DRIVE_LIMIT = 64 * 1024 * 1024;

const FIELDS: Record<"create" | "edit" | "upscale", string[]> = {
  create: ["recipe", "prompt", "negativePrompt", "width", "height", "count", "steps", "cfg", "seed", "references"],
  edit: ["recipe", "prompt", "negativePrompt", "count", "steps", "cfg", "seed", "references", "image", "mask", "replace"],
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

/** `width:height`, from 1:4 to 4:1. */
function aspectRatio(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const m = typeof v === "string" ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v) : null;
  const r = m ? Number(m[1]) / Number(m[2]) : NaN;
  if (!Number.isFinite(r) || r < 1 / 4 || r > 4) throw invalid("aspectRatio must be width:height, from 1:4 to 4:1.");
  return r;
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
  /** stable-diffusion.cpp, which makes the images in ComfyUI's place when it is set. */
  private readonly sdcpp: SdCpp | null;
  private readonly downloads: Downloads | null;
  private readonly modelsDir: string;
  private readonly seedvr2Dir: string;
  private readonly comfyGpu: number;
  private readonly log: Logger;
  private readonly idleTimer: NodeJS.Timeout;
  /** Each SeedVR2 part's link name in its folder. */
  private seedvr2Names = new Map<string, string>();

  constructor(o: { book: RecipeBook; runtime: Runtime; comfy: Comfy; sdcpp?: SdCpp | null; downloads: Downloads | null; modelsDir: string; serving: string; comfyGpu: number; log: Logger }) {
    this.book = o.book;
    this.runtime = o.runtime;
    this.comfy = o.comfy;
    this.sdcpp = o.sdcpp ?? null;
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

  /**
   * A recipe as the API lists it. With stable-diffusion.cpp, it does only
   * what sd.cpp can run here. One too big for the image GPU does nothing.
   * Either way it says why when that's nothing.
   */
  private describe(r: Recipe, files: Set<string>) {
    const d = this.book.describe(r, files);
    if ("unsupported" in d) return d;
    const tooBig = r.parts.every((p) => p.file) ? this.runtime.scheduler.neverFits({ model: this.asModel(r), gpu: this.comfyGpu }) : null;
    if (tooBig) return { ...d, does: [], unsupported: tooBig };
    if (!this.sdcpp) return d;
    try {
      sdcppArgs(r, this.modelsDir);
    } catch (e) {
      return { ...d, does: [], unsupported: (e as Error).message };
    }
    return { ...d, does: r.does.filter((a) => a === "create") };
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
      sendJson(res, 200, { recipes: this.book.all().filter((r) => !state || r.state === state).map((r) => this.describe(r, files)) });
      return true;
    }
    if (path === "/host/v1/starters" && method === "GET") {
      sendJson(res, 200, {
        starters: this.starters().map((s) => ({ ...s, parts: s.parts.map((p) => ({ ...p, present: this.have(p) !== null })) })),
      });
      return true;
    }
    const install = path.match(/^\/host\/v1\/starters\/([\w.-]+)\/install$/);
    if (install && method === "POST") {
      const starter = this.starters().find((s) => s.id === install[1]);
      if (!starter) throw notFound("No such starter.");
      // Installing a starter again returns its recipe, and downloads only what's still missing.
      const { recipe, toDownload } = this.book.fromStarter(starter, (p) => this.have(p), (p) => this.downloading(p));
      const downloads = await this.download(toDownload, req);
      sendJson(res, 200, { recipe: this.describe(recipe, files), downloads });
      return true;
    }
    const bulk = path.match(/^\/host\/v1\/recipes\/(confirm|ignore)$/);
    if (bulk && method === "POST") {
      const body = await readJson(req);
      onlyFields(body, ["ids"]);
      if (!Array.isArray(body.ids) || !body.ids.every((i) => typeof i === "string")) throw invalid("ids must be a list.");
      const { done, failed } = this.book.setState(body.ids as string[], bulk[1] === "confirm" ? "confirmed" : "ignored");
      sendJson(res, 200, { recipes: done.map((r) => this.describe(r, files)), failed });
      return true;
    }
    const one = path.match(/^\/host\/v1\/recipes\/([0-9a-f-]{36})(?:\/(confirm|ignore|copy|download-parts))?$/);
    if (one) {
      const [, id, action] = one;
      if (!action && method === "GET") return sendJson(res, 200, this.describe(this.book.get(id!), files)), true;
      if (!action && method === "PATCH") {
        const body = await readJson(req);
        return sendJson(res, 200, this.describe(this.book.patch(id!, body, this.parts), files)), true;
      }
      if (!action && method === "DELETE") return sendJson(res, 200, await this.remove(id!)), true;
      if (action === "confirm" || action === "ignore") {
        if (method !== "POST") return false;
        const { done, failed } = this.book.setState([id!], action === "confirm" ? "confirmed" : "ignored");
        if (failed[0]) throw failed[0].message === "No such recipe." ? notFound(failed[0].message) : invalid(failed[0].message);
        return sendJson(res, 200, this.describe(done[0]!, files)), true;
      }
      if (action === "copy" && method === "POST") {
        const body = await readJson(req);
        onlyFields(body, ["name"]);
        return sendJson(res, 200, this.describe(this.book.copy(id!, body.name), files)), true;
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
        return sendJson(res, 200, { recipe: this.describe(r, files), downloads }), true;
      }
    }
    const make = path.match(/^\/host\/v1\/images\/(create|edit|upscale)$/);
    if (make && method === "POST") {
      // A tagged job is readable from the start, so its client sees it queued while the request is read.
      await this.runtime.jobs.track(this.runtime.jobs.token(req), (job) => this.make(make[1] as "create" | "edit" | "upscale", req, res, job));
      return true;
    }
    if (path === "/host/v1/videos/create" && method === "POST") {
      await this.runtime.jobs.track(this.runtime.jobs.token(req), (job) => this.video(req, res, job));
      return true;
    }
    const job = path.match(/^\/host\/v1\/jobs\/([A-Za-z0-9_-]{16,64})$/);
    if (job && method === "GET") {
      const state = this.runtime.jobs.get(job[1]!);
      if (!state) throw notFound("No such job running.");
      return sendJson(res, 200, state), true;
    }
    return false;
  }

  /** The starters this host can run: a starter for one backend only shows on hosts using it. */
  private starters(): Starter[] {
    const backend = this.sdcpp ? "sdcpp" : "comfyui";
    return this.book.starters.filter((s) => !s.backend || s.backend === backend);
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
      if (this.runtime.models.some((m) => m.id === file)) {
        kept.push({ file, reason: "Also a chat model." });
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

  private async make(action: "create" | "edit" | "upscale", req: IncomingMessage, res: ServerResponse, job: JobProgress): Promise<void> {
    const body = await readJson(req, 4 * IMAGE_LIMIT + 1024 * 1024);
    onlyFields(body, FIELDS[action]);
    if (typeof body.recipe !== "string") throw invalid("recipe is missing.");
    const recipe = this.book.all().find((r) => r.id === body.recipe && r.state === "confirmed");
    if (!recipe || !this.book.ready(recipe, this.files())) throw notFound("No confirmed, ready recipe with that ID.");
    if (!recipe.does.includes(action)) throw invalid(`That recipe doesn't ${action} images.`);
    if (this.sdcpp && action !== "create") throw invalid(`This host makes images with stable-diffusion.cpp, which can't ${action} images here.`);
    const sdArgs = this.sdcpp ? sdcppArgs(recipe, this.modelsDir, this.sdcpp.fullRate()) : null;
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
    if (body.replace !== undefined && (typeof body.replace !== "boolean" || (body.replace && !uploads.mask))) throw invalid("replace must be true or false, and true only with a mask.");
    // The text encoder sees the edited image, except where a masked part is replaced: then only the prompt
    // and references guide it, so the model draws the new thing rather than reshaping what was there.
    if (action === "edit" && !body.replace) values.seen = 1;
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
    const sdcpp = this.sdcpp;
    if (sdcpp && sdArgs) sdcpp.prepare(model.id, sdArgs);
    // stable-diffusion.cpp reports no steps: its job only says it runs.
    const pngs = await scheduler.run(model, "image", () => {
      job.running();
      return scheduler.measuring(model, () =>
        sdcpp ? sdcpp.create(model.id, recipe.template, values, abort.signal) : this.comfy.run(uploads, (names) => {
          const parts = recipe.parts.filter((p): p is typeof p & { file: string } => !!p.file);
          return fill(template, parts, recipe.loras, { ...values, ...names });
        }, abort.signal, job.progress));
    }, this.comfyGpu, abort.signal);
    if (!pngs.length) throw new HostError(503, "model_unavailable", `${sdcpp ? "stable-diffusion.cpp" : "ComfyUI"} returned no image.`);
    const seconds = (Date.now() - started) / 1000;
    this.runtime.count(recipe.id, { requests: 1, images: pngs.length, seconds });
    this.log("image", { recipe: recipe.id, action, images: pngs.length });
    sendJson(res, 200, {
      images: pngs.map((png, i) => {
        const size = imageSize(png);
        // sd.cpp makes each image of a batch from the next seed, so each is reproducible alone; ComfyUI's share one.
        const seed = sdcpp ? Number(values.seed) + i : values.seed;
        return { png: png.toString("base64"), width: size?.width ?? null, height: size?.height ?? null, seed };
      }),
      seconds,
    });
  }

  /**
   * One clip from a video recipe: from the prompt alone (`video`), from a
   * first frame (`animate`), or from an image moved as a driving clip moves
   * (`motion`). The template times it: the duration becomes the model's frame
   * count, and width and height multiples of its size step. Past its longest
   * clip, or with `extend` (a clip to add to), a template with a continuation
   * chains clips into one (clipPlan).
   */
  private async video(req: IncomingMessage, res: ServerResponse, job: JobProgress): Promise<void> {
    const body = await readJson(req, 2 * IMAGE_LIMIT + Math.ceil(DRIVE_LIMIT / 3) * 4);
    onlyFields(body, VIDEO_FIELDS);
    if (typeof body.recipe !== "string") throw invalid("recipe is missing.");
    const recipe = this.book.all().find((r) => r.id === body.recipe && r.state === "confirmed");
    if (!recipe || !this.book.ready(recipe, this.files())) throw notFound("No confirmed, ready recipe with that ID.");
    const extending = body.extend !== undefined;
    if (extending && (body.image !== undefined || body.drive !== undefined)) throw invalid("extend takes no image or driving clip: the clip's own last frames start the next.");
    const action: Action = body.drive !== undefined ? "motion" : body.image === undefined ? "video" : "animate";
    if (!extending && !recipe.does.includes(action)) {
      throw invalid(action === "motion" ? (recipe.does.some((a) => a === "video" || a === "animate") ? "That recipe doesn't move an image as a clip does." : "That recipe doesn't make videos.")
        : recipe.does.includes("motion") ? "That recipe moves an image as a clip does: give it both."
        : recipe.does.includes("animate") ? "That recipe animates an image: give it one." : recipe.does.includes("video") ? "That recipe doesn't animate images." : "That recipe doesn't make videos.");
    }
    if (action === "motion" && body.image === undefined) throw invalid("image is missing: the one whose subject moves.");
    if (this.sdcpp) throw invalid("This host makes images with stable-diffusion.cpp, which can't make videos.");
    const template = this.book.templates.get(recipe.template)!;
    const spec = template.video;
    if (!spec) throw new HostError(500, "internal", `Template ${template.name} has no video settings.`);
    const chain = template.continuation;
    if (extending && !(chain && recipe.does.some((a) => a === "video" || a === "animate"))) throw invalid("That recipe can't extend a clip.");

    const values: Values = { ...BASE_DEFAULTS, duration: 5, ...recipe.defaults };
    if (typeof body.prompt !== "string" || !body.prompt) throw invalid("prompt is missing.");
    values.prompt = body.prompt;
    if (body.negativePrompt !== undefined) {
      if (typeof body.negativePrompt !== "string") throw invalid("negativePrompt must be text.");
      values.negativePrompt = body.negativePrompt;
    }
    values.steps = int(body, "steps", 1, 150) ?? values.steps!;
    values.cfg = num(body, "cfg", 0, 30) ?? values.cfg!;
    const uploads: Record<string, Buffer> = {};
    if (action !== "video") uploads.image = inputImage(body.image, "image");
    let driveSeconds = Infinity;
    if (action === "motion") {
      if (typeof body.drive !== "string") throw invalid("drive must be a base64 MP4.");
      uploads.drive = Buffer.from(body.drive, "base64");
      if (uploads.drive.length > DRIVE_LIMIT) throw invalid("drive is larger than 64 MB.");
      const seconds = mp4Seconds(uploads.drive);
      if (seconds === null) throw invalid("drive isn't an MP4 or QuickTime clip whose length can be read.");
      driveSeconds = seconds;
    }
    let previous: Buffer | null = null;
    const width = int(body, "width", 256, 2048);
    const height = int(body, "height", 256, 2048);
    const ratio = aspectRatio(body.aspectRatio);
    if (ratio !== undefined && (width !== undefined || height !== undefined)) throw invalid("Give a size or an aspect ratio, not both.");
    if (extending) {
      // The next clip continues this one: its size and frame rate must be the recipe's own.
      if (typeof body.extend !== "string") throw invalid("extend must be a base64 MP4.");
      if (width !== undefined || height !== undefined || ratio !== undefined) throw invalid("An extended clip keeps its own size.");
      previous = Buffer.from(body.extend, "base64");
      if (previous.length > DRIVE_LIMIT) throw invalid("extend is larger than 64 MB.");
      const clip = mp4Video(previous);
      if (!clip) throw invalid("extend isn't an MP4 clip whose video track can be read.");
      const fps = clipSpec(spec, present(recipe, this.files())).fps;
      if (Math.abs(clip.fps - fps) > 0.01) throw invalid(`That clip is ${Math.round(clip.fps * 100) / 100} fps; this recipe continues ${fps} fps clips.`);
      if (![clip.width, clip.height].every((n) => n >= 256 && n <= 2048 && n % spec.sizeStep === 0)) throw invalid(`That clip is ${clip.width}×${clip.height}; this recipe makes sizes in steps of ${spec.sizeStep} from 256 to 2048.`);
      values.width = clip.width;
      values.height = clip.height;
    } else {
      // Sizes are snapped to the template's size step. Without them the recipe's area is used, in the shape
      // `aspectRatio` gives, or when animating the image's.
      const snap = (n: number) => Math.min(2048, Math.max(256, Math.round(n / spec.sizeStep) * spec.sizeStep));
      const frame = uploads.image ? imageSize(uploads.image)! : null;
      const area = Number(values.width) * Number(values.height);
      const shape = ratio ?? (frame && width === undefined && height === undefined ? frame.width / frame.height : Number(values.width) / Number(values.height));
      values.width = snap(width ?? (height !== undefined ? height * shape : Math.sqrt(area * shape)));
      values.height = snap(height ?? (width !== undefined ? width / shape : Math.sqrt(area / shape)));
    }
    // A driving clip can't give more moves than it has. Extending, the duration is what's added.
    const longest = extending ? LONGEST_SECONDS : longestSeconds(template);
    const duration = Math.min(num(body, "duration", 1, longest) ?? Math.min(Number(values.duration), longest), driveSeconds);
    const parts = present(recipe, this.files());
    const multiplier = parts.some((p) => p.role === "interpolator") ? spec.interpolate ?? 1 : 1;
    const plan = clipPlan(spec, chain, duration, extending);
    const clips = plan.map((seconds) => videoValues(spec, seconds, Number(values.width), Number(values.height), Number(values.steps), multiplier));
    values.seed = int(body, "seed", 0, 2 ** 48) ?? randomInt(2 ** 47);

    const started = Date.now();
    const model = this.asModel(recipe);
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const scheduler = this.runtime.scheduler;
    // One hold on the GPU for every clip, and one progress, each clip weighted by its frames.
    const total = clips.reduce((n, c) => n + Number(c.frames), 0);
    const { video, poster } = await scheduler.run(model, "image", () => {
      job.running();
      return scheduler.measuring(model, async () => {
        let video = previous;
        let poster: Buffer | null = null;
        let done = 0;
        for (const [i, clip] of clips.entries()) {
          const first = i === 0 && !extending;
          // An animated still stays every later clip's reference: the clip so far may have lost a face the still shows.
          const ref = first ? undefined : uploads.image && chain!.reference;
          const t = first ? template : { ...template, workflow: { ...chain!.workflow, ...ref?.workflow } };
          const step = { ...values, ...clip, seed: Number(values.seed) + i, ...(first ? {} : { overlap: chain!.overlap, prompt: `${ref?.promptPrefix ?? ""}${chain!.promptPrefix ?? ""}${values.prompt}` }) };
          const made = await this.comfy.runVideo(first ? uploads : { previous: video!, ...(ref ? { reference: uploads.image! } : {}) }, (names) => fill(t, parts, recipe.loras, { ...step, ...names }),
            VIDEO_TIMEOUT_MS, abort.signal, (f) => job.progress((done + f * Number(clip.frames)) / total));
          video = made.video;
          poster = made.poster ?? poster;
          done += Number(clip.frames);
        }
        return { video: video!, poster };
      });
    }, this.comfyGpu, abort.signal);
    const seconds = (Date.now() - started) / 1000;
    this.runtime.count(recipe.id, { requests: 1, seconds });
    this.log("video", { recipe: recipe.id, action: extending ? "extend" : action, clips: clips.length, frames: total });
    const size = poster ? imageSize(poster) : null;
    // A chained clip's length is read from the clip itself, or else counted: each continuation drops its overlap.
    const counted = (extending ? mp4Video(previous!)!.frames : Number(clips[0]!.clipFrames))
      + clips.slice(extending ? 0 : 1).reduce((n, c) => n + Number(c.frames) - chain!.overlap, 0);
    const frames = clips.length > 1 || extending ? mp4Video(video)?.frames ?? counted : counted;
    const fps = Number(clips[0]!.fps);
    sendJson(res, 200, {
      video: { mp4: video.toString("base64"), width: size?.width ?? values.width, height: size?.height ?? values.height,
        frames, fps, duration: frames / fps, audio: spec.audio, seed: values.seed },
      poster: poster ? poster.toString("base64") : null,
      seconds,
    });
  }

  /** What stops images being made on this host, for the status. */
  get problems(): string[] {
    const p = (this.sdcpp ?? this.comfy).problem;
    return p ? [`Images: ${p}`] : [];
  }

  /** A recipe as the scheduler sees it. */
  private asModel(r: Recipe): TextModel {
    const size = recipeSize(r, this.parts);
    return {
      id: `recipe:${r.id}`, kind: "image", server: "comfyui", format: "safetensors", size,
      identity: { basename: r.name, sizeLabel: null, finetune: null, baseModels: [] },
      capabilities: { tools: false, vision: false, embedding: false, reasoning: null },
      contextLength: null, kvPerToken: null, mmproj: null, remoteCode: false,
    };
  }
}

/**
 * ComfyUI's memory for a recipe at its peak. It runs the text encoders, then
 * the diffusion model with its LoRAs, then an upscaler, freeing one stage's
 * models when the next needs the room, so the peak is the largest stage plus
 * the VAEs, not every part at once. A video model's two experts run one after
 * the other, each with its own LoRA. A CLIP vision model and a segmenter count with the VAEs.
 */
export function recipeSize(r: Pick<Recipe, "parts" | "loras">, parts: Pick<Part, "file" | "size">[]): number {
  const sizeOf = (f: string | null) => parts.find((p) => p.file === f)?.size ?? 0;
  const stage = (roles: Role[]) => r.parts.filter((p) => roles.includes(p.role)).reduce((n, p) => n + sizeOf(p.file), 0);
  const loras = r.loras.reduce((n, l) => n + sizeOf(l.file), 0);
  // Each expert's slot, or one group for a model without experts; a LoRA joins its expert's group, or the model's.
  const experts = new Set(r.parts.filter((p) => p.role === "diffusion" && p.slot).map((p) => p.slot));
  const groups = new Map<string, number>();
  for (const p of r.parts.filter((p) => ["checkpoint", "diffusion", "lora", "unknown"].includes(p.role))) {
    const group = p.slot && experts.has(p.slot) ? p.slot : "";
    groups.set(group, (groups.get(group) ?? 0) + sizeOf(p.file));
  }
  const model = Math.max(0, ...[...groups].map(([g, n]) => n + (g === "" ? loras : 0)), loras);
  return Math.max(stage(["text_encoder"]), model, stage(["upscaler"])) + stage(["vae", "latent_upscaler", "interpolator", "clip_vision", "segmenter"]);
}

/**
 * A clip's frames and the values a video template reads besides the request's own. With an interpolator
 * (`multiplier` above 1) the model makes `frames` and each gap between two gains frames: `clipFrames` at `fps`.
 */
export function videoValues(spec: VideoSpec, duration: number, width: number, height: number, steps: number, multiplier = 1): Values {
  const k = Math.max(1, Math.ceil((duration * spec.fps - spec.frameOffset) / spec.frameStep));
  const frames = k * spec.frameStep + spec.frameOffset;
  return {
    frames, clipFrames: (frames - 1) * multiplier + 1, fps: spec.fps * multiplier, multiplier,
    // LTX-2 samples at half size and then upscales; Wan's experts split the steps.
    halfWidth: width / 2, halfHeight: height / 2, halfSteps: Math.max(1, Math.floor(steps / 2)),
  };
}

/**
 * The clips that make `seconds` of video, each as the seconds videoValues takes: near-equal clips, the first from the
 * request (unless `extending` a clip), each next one a continuation whose first `overlap` frames repeat the clip so far.
 * Without a continuation it is one clip. A chain's clips are at most `clipSeconds` long.
 */
export function clipPlan(spec: VideoSpec, chain: Continuation | undefined, seconds: number, extending = false): number[] {
  if (!chain) return [seconds];
  const most = Number(videoValues(spec, Math.min(spec.maxSeconds, chain.clipSeconds), 0, 0, 1).frames);
  const want = Math.ceil(seconds * spec.fps);
  if (!extending && want <= most) return [seconds];
  // Each clip adds at most `most - overlap` new frames; the first adds all of its own, which leaves slack.
  const n = Math.ceil(want / (most - chain.overlap));
  const share = want / n;
  const frames = (f: number) => Number(videoValues(spec, f / spec.fps, 0, 0, 1).frames);
  const made = Array.from({ length: n }, (_, i) => Math.min(most, frames(i === 0 && !extending ? share : share + chain.overlap)));
  // Each clip rounds up to the model's frame step, so together they can overshoot by a step per clip: take whole
  // steps back off the longest clips while the new frames still cover what was asked.
  const added = () => made.reduce((sum, f, i) => sum + f - (i === 0 && !extending ? 0 : chain.overlap), 0);
  for (;;) {
    const i = made.indexOf(Math.max(...made));
    if (added() - spec.frameStep < want || made[i]! - spec.frameStep <= chain.overlap) break;
    made[i]! -= spec.frameStep;
  }
  // Just under each count, so videoValues rounds back to it whatever the float error.
  return made.map((f) => (f - 0.5) / spec.fps);
}
