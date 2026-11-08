// The image routes in API.md ("Image models"): parts, recipes, starters, and
// create, edit and upscale through ComfyUI, and videos from video recipes.
import { createHash, randomInt } from "node:crypto";
import { mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { imageSize, mp4Seconds, mp4Sound, mp4Video, type ComfyGpus } from "./comfy.ts";
import type { Downloads } from "./downloads.ts";
import { HostError, invalid, notFound, onlyFields, readJson, sendJson } from "./http.ts";
import type { JobProgress } from "./jobs.ts";
import type { TextModel } from "./library.ts";
import type { Logger } from "./log.ts";
import { scanParts, type Part, type Role } from "./parts.ts";
import { clipSpec, COLOR_MATCH, loraFits, present, RecipeBook, starterPath, type Recipe, type Starter } from "./recipes.ts";
import type { Runtime } from "./runtime.ts";
import { sdcppArgs, type SdCpp } from "./sdcpp.ts";
import { fill, LONGEST_SECONDS, longestSeconds, type Action, type Continuation, type Lora, type Template, type Values, type VideoSpec } from "./templates.ts";
import { checkTemplate, CUSTOM_ACTIONS, customAction, filesIn, importWorkflow, label, parseWorkflow, partSpecs, recipeParts, videoSpec, layoutOf, type NodeList, type Workflows } from "./workflows.ts";
import { checkDefault, DEFAULT_KEYS } from "./recipes.ts";

/** How many reference images a workflow's blanks take: its highest `$reference<n>`. */
const referenceCount = (wf: Template["workflow"]) =>
  Math.max(0, ...Object.values(wf).flatMap((n) => Object.values(n.inputs)).map((v) => (typeof v === "string" ? Number(/^\$reference(\d)$/.exec(v)?.[1] ?? 0) : 0)));

/** A custom workflow's request body: an export, with room for its long prompts and many nodes. */
const WORKFLOW_LIMIT = 2 * 1024 * 1024;

const IMAGE_LIMIT = 20 * 1024 * 1024;
const MAX_SIDE = 8192;
const MAX_PIXELS = 36_000_000;
const MAX_RESOLUTION = 4096;
const BASE_DEFAULTS: Values = {
  negativePrompt: "", steps: 20, cfg: 1, sampler: "euler", scheduler: "simple", width: 1024, height: 1024, shift: 3, guidance: 3.5, scale: 2, maxSize: 4096, colorMatch: "lab",
  // Krea 2's second pass (host/workflows/krea2.json), which runs only when a recipe sets `refine`, its denoise.
  refineSteps: 8, refineSampler: "res_2s", refineScheduler: "bong_tangent", refineEta: 0.9,
};
const IDLE_FREE_MS = 10 * 60_000;
/** How long one clip may take: a 14B model on a 24 GB card can take most of an hour. */
const VIDEO_TIMEOUT_MS = 2 * 60 * 60_000;
const VIDEO_FIELDS = ["recipe", "prompt", "negativePrompt", "image", "drive", "extend", "source", "width", "height", "duration", "steps", "cfg", "seed", "aspectRatio", "loras"];
/** A request names at most this many LoRA files of the host's for one job (API.md, "LoRAs for one job"): four LoRAs, each maybe a high and low noise pair. */
const MAX_REQUEST_LORAS = 8;
/** A driving clip (`motion`), a clip to extend or one to edit (`edit_video`): only its first seconds are used. */
const DRIVE_LIMIT = 64 * 1024 * 1024;
const CLIP_UPSCALE_FIELDS = ["recipe", "video", "scale", "maxSize", "colorMatch", "seed"];
/**
 * An upscaled clip's frames times its pixels, at most: ComfyUI holds every frame in system memory at 12 bytes a
 * pixel, so this is about 18 GB of frames (15 s at 24 fps from 720p to 1440p).
 */
const MAX_CLIP_UPSCALE_PIXELS = 1_500_000_000;
/** SeedVR2 takes seeds up to 2^32 - 1. */
const UPSCALE_SEEDS = 2 ** 32;

const FIELDS: Record<"create" | "edit" | "upscale", string[]> = {
  create: ["recipe", "prompt", "negativePrompt", "width", "height", "count", "steps", "cfg", "seed", "references", "loras"],
  edit: ["recipe", "prompt", "negativePrompt", "count", "steps", "cfg", "seed", "references", "image", "mask", "replace", "loras"],
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
  /** A ComfyUI per image GPU. */
  private readonly comfy: ComfyGpus;
  /** stable-diffusion.cpp, which makes the images in ComfyUI's place when it is set. */
  private readonly sdcpp: SdCpp | null;
  private readonly downloads: Downloads | null;
  private readonly modelsDir: string;
  private readonly seedvr2Dir: string;
  /** The GPUs images and videos run on: each ComfyUI's, or stable-diffusion.cpp's one. */
  private readonly gpus: number[];
  /** Jobs given to each GPU and not yet done. */
  private readonly jobsOn = new Map<number, number>();
  private readonly log: Logger;
  private readonly idleTimer: NodeJS.Timeout;
  /** Each SeedVR2 part's link name in its folder. */
  private seedvr2Names = new Map<string, string>();

  /** Custom workflows; absent, the host keeps none. */
  private readonly workflows: Workflows | null;

  constructor(o: { book: RecipeBook; workflows?: Workflows | null; runtime: Runtime; comfy: ComfyGpus; sdcpp?: SdCpp | null; downloads: Downloads | null; modelsDir: string; serving: string; log: Logger }) {
    this.book = o.book;
    this.workflows = o.workflows ?? null;
    this.runtime = o.runtime;
    this.comfy = o.comfy;
    this.sdcpp = o.sdcpp ?? null;
    this.downloads = o.downloads;
    this.modelsDir = o.modelsDir;
    this.seedvr2Dir = join(o.serving, "seedvr2");
    this.gpus = this.sdcpp ? this.comfy.gpus.slice(0, 1) : this.comfy.gpus;
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
   * what sd.cpp can run here. One too big for every image GPU does nothing.
   * Either way it says why when that's nothing.
   */
  private describe(r: Recipe, files: Set<string>) {
    const book = this.book.describe(r, files);
    if ("unsupported" in book) return book;
    const t = this.book.templates.get(r.template)!;
    const unready = t.custom && this.workflows?.nodes ? this.workflowProblem(t, this.workflows.nodes) : null;
    if (unready) return { ...book, does: [], unsupported: unready };
    const d = { ...book, takesLoras: this.sdcpp ? [] : this.takesLoras(r).map((p) => p.file) };
    const reasons = r.parts.every((p) => p.file) ? this.gpus.map((gpu) => this.runtime.scheduler.neverFits({ model: this.asModel(r, gpu), gpu })) : [];
    const tooBig = reasons.length && reasons.every((x) => x) ? reasons[0]! : null;
    if (tooBig) return { ...d, does: [], unsupported: tooBig };
    if (!this.sdcpp) return d;
    try {
      sdcppArgs(r, this.modelsDir);
    } catch (e) {
      return { ...d, does: [], unsupported: (e as Error).message };
    }
    return { ...d, does: r.does.filter((a) => a === "create") };
  }

  /** The built-in template a copied workflow came from, whose own nodes it may keep. */
  private baseOf(t: Template): Template | undefined {
    return t.custom?.base ? this.book.templates.get(t.custom.base) : undefined;
  }

  /** Why a custom workflow can't run against ComfyUI's node list, or null when it can. */
  private workflowProblem(t: Template, nodes: NodeList): string | null {
    const check = checkTemplate(t, nodes, this.baseOf(t));
    if (check.missingNodes?.length) return `Its workflow needs ComfyUI nodes this host doesn't have: ${check.missingNodes.join(", ")}.`;
    return check.problems.length ? `Its workflow can't run here: ${check.problems[0]}` : null;
  }

  /**
   * Checked again as a custom workflow's job starts, after ComfyUI has started and reported its nodes:
   * one saved before the host knew them may hold a node that writes files.
   */
  private checkBeforeRun(t: Template): void {
    if (!t.custom) return;
    const nodes = this.workflows?.nodes;
    const problem = nodes ? this.workflowProblem(t, nodes) : "ComfyUI hasn't reported its nodes yet.";
    if (problem) throw new HostError(503, "model_unavailable", problem);
  }

  /**
   * The LoRAs on this host a request may add to a recipe for one job: those whose architecture fits it,
   * other than the ones its template loads itself. A template that loads its own parts takes none.
   */
  private takesLoras(r: Recipe): Part[] {
    const t = this.book.templates.get(r.template);
    if (!t || t.loaders === "template") return [];
    const own = new Set(r.parts.map((p) => p.file));
    return this.parts.filter((p) => p.role === "lora" && loraFits(r.arch, p.arch) && !own.has(p.file));
  }

  /**
   * The LoRAs one job applies: the recipe's own, then `asked` (a request's `loras`), whose strength
   * replaces the recipe's for a LoRA it already has. Each with its part's slot, so an expert's LoRA goes onto that expert.
   */
  private jobLoras(r: Recipe, asked: unknown): Lora[] {
    const slotOf = (file: string) => this.parts.find((p) => p.file === file)?.slot ?? null;
    const out: Lora[] = r.loras.map((l) => ({ ...l, slot: slotOf(l.file) }));
    if (asked === undefined) return out;
    if (!Array.isArray(asked) || asked.length > MAX_REQUEST_LORAS) throw invalid(`loras must be a list of at most ${MAX_REQUEST_LORAS}.`);
    if (asked.length && this.sdcpp) throw invalid("This host makes images with stable-diffusion.cpp, which takes no LoRAs here.");
    const takes = new Set(this.takesLoras(r).map((p) => p.file));
    const seen = new Set<string>();
    for (const l of asked as { file?: unknown; strength?: unknown }[]) {
      if (!l || typeof l !== "object" || typeof l.file !== "string") throw invalid("Each of loras needs a file.");
      if (typeof l.strength !== "number" || !Number.isFinite(l.strength) || l.strength < -4 || l.strength > 4) throw invalid("A LoRA's strength must be a number from -4 to 4.");
      if (seen.has(l.file)) throw invalid("loras names a LoRA twice.");
      seen.add(l.file);
      const built = out.find((o) => o.file === l.file);
      if (built) built.strength = l.strength;
      else if (takes.has(l.file)) out.push({ file: l.file, strength: l.strength, slot: slotOf(l.file) });
      else throw invalid(`${basename(l.file)} isn't a LoRA on this host that this recipe takes.`);
    }
    return out;
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
    const one = path.match(/^\/host\/v1\/recipes\/([0-9a-f-]{36})(?:\/(confirm|ignore|copy|download-parts|workflow))?$/);
    if (one) {
      const [, id, action] = one;
      if (action === "workflow") return this.recipeWorkflowRoute(req, res, method, id!);
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
    if (path === "/host/v1/workflows" || path.startsWith("/host/v1/workflows/")) return this.workflowRoute(req, res, path, method, files);
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
    if (path === "/host/v1/videos/upscale" && method === "POST") {
      await this.runtime.jobs.track(this.runtime.jobs.token(req), (job) => this.upscaleClip(req, res, job));
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

  /** A custom workflow as the API lists it; `full` adds its nodes, its check and the node types' inputs it uses. */
  private workflowInfo(t: Template, full = false) {
    const nodes = this.workflows?.nodes ?? null;
    const base = this.baseOf(t);
    const info = {
      name: t.name, label: t.custom!.name, from: t.custom!.from, base: t.custom!.base ?? null, made: t.custom!.made,
      revision: t.custom!.revision ?? 1, saved: t.custom!.saved ?? t.custom!.made, by: t.custom!.by ?? "app", does: t.does, arch: t.arch,
      loaders: t.loaders ?? null, video: t.video ?? null, references: t.references, files: t.files ?? [], layout: t.custom!.layout ?? null,
      recipes: this.book.all().filter((r) => r.template === t.name).map((r) => ({ id: r.id, name: r.name })), nodesChecked: !!nodes,
    };
    if (!full) return info;
    const used = new Set(Object.values(t.workflow).map((n) => n.class_type));
    return { ...info, workflow: t.workflow, ...checkTemplate(t, nodes, base), nodes: nodes ? Object.fromEntries([...used].filter((c) => nodes[c]).map((c) => [c, nodes[c]!.inputs])) : null };
  }

  /** The recipe parts of a workflow that loads its own files: those of them on this host, for sizing and "used by". */
  private ownFileParts(files: string[]) {
    return files.flatMap((f) => {
      const p = this.parts.find((x) => x.file === f);
      return p ? [{ role: p.role, slot: null, file: f, added: false }] : [];
    });
  }

  /** The custom workflow routes (API.md, "Custom workflows"). */
  private async workflowRoute(req: IncomingMessage, res: ServerResponse, path: string, method: string, files: Set<string>): Promise<boolean> {
    const store = this.workflows;
    if (!store) throw notFound("This host keeps no custom workflows.");
    if (this.sdcpp) throw invalid("This host makes images with stable-diffusion.cpp, which runs no ComfyUI workflows.");
    const templates = this.book.templates;
    const nodes = store.nodes;
    if (path === "/host/v1/workflows" && method === "GET") {
      return sendJson(res, 200, { workflows: [...templates.values()].filter((t) => t.custom).map((t) => this.workflowInfo(t)), nodesChecked: !!nodes }), true;
    }
    if (path === "/host/v1/workflows/nodes" && method === "GET") return sendJson(res, 200, { nodes }), true;
    if (path === "/host/v1/workflows/import" && method === "POST") {
      const body = await readJson(req, WORKFLOW_LIMIT);
      onlyFields(body, ["workflow", "name", "does"]);
      const draft = importWorkflow(body.workflow, label(body.name), customAction(body.does), this.parts);
      const check = checkTemplate({ workflow: draft.workflow, does: [draft.does], loaders: draft.loaders ?? undefined, parts: partSpecs(draft.parts), video: draft.video ?? undefined }, nodes);
      return sendJson(res, 200, { draft, ...check }), true;
    }
    if (path === "/host/v1/workflows" && method === "POST") {
      const body = await readJson(req, WORKFLOW_LIMIT);
      onlyFields(body, ["name", "does", "arch", "workflow", "loaders", "clipType", "video", "parts", "loras", "defaults", "layout"]);
      const name = label(body.name);
      const does = customAction(body.does);
      const workflow = parseWorkflow(body.workflow);
      if (body.loaders !== null && body.loaders !== undefined && body.loaders !== "template") throw invalid("loaders must be \"template\" or null.");
      const own = body.loaders === "template";
      if (body.clipType !== null && body.clipType !== undefined && (typeof body.clipType !== "string" || !/^[a-z0-9_]{1,32}$/.test(body.clipType))) throw invalid("clipType must be a ComfyUI CLIP type or null.");
      if (typeof body.arch !== "string" || !/^[\w.-]{1,40}$/.test(body.arch)) throw invalid("arch must be a short name.");
      const fileList = filesIn(workflow);
      const parts = own ? this.ownFileParts(fileList) : recipeParts(body.parts, this.parts);
      if (!own && !parts.some((p) => p.role === "checkpoint" || p.role === "diffusion")) throw invalid("parts must include the model: a checkpoint or a diffusion model.");
      const loras = own ? [] : this.customLoras(body.loras);
      const defaults = this.customDefaults(body.defaults);
      const video = does === "video" || does === "animate" ? videoSpec(body.video) : undefined;
      const references = referenceCount(workflow);
      const t: Template = {
        name: store.newName(templates), arch: body.arch, does: [does], checkpoint: parts.some((p) => p.role === "checkpoint"), clipType: (body.clipType as string | null) ?? null,
        ...(own ? { loaders: "template" as const } : {}), parts: own ? [] : partSpecs(parts), references, mask: false, ...(video ? { video } : {}), workflow,
        custom: { name, from: "import", made: new Date().toISOString(), ...withLayout(layoutOf(body.layout, workflow)) }, files: fileList,
      };
      const check = checkTemplate(t, nodes);
      if (check.problems.length) throw invalid(check.problems.join(" "));
      templates.set(t.name, store.save(t));
      const recipe = this.book.add({ name, state: "confirmed", arch: t.arch, template: t.name, does: [does], useFor: "both", parts, loras, defaults, base: null, starter: null });
      return sendJson(res, 200, { workflow: this.workflowInfo(t, true), recipe: this.describe(recipe, files) }), true;
    }
    if (path === "/host/v1/workflows/copy" && method === "POST") {
      const body = await readJson(req, WORKFLOW_LIMIT);
      onlyFields(body, ["recipe", "name", "workflow", "video", "layout"]);
      const name = label(body.name);
      const from = this.book.get(String(body.recipe ?? ""));
      const source = templates.get(from.template);
      if (!source) throw notFound(`This host has no template ${from.template}.`);
      if (!source.does.some((a) => CUSTOM_ACTIONS.includes(a))) throw invalid("Only workflows that make, edit or animate can be copied.");
      const baseName = source.custom ? source.custom.base : source.name;
      const t: Template = { ...structuredClone(source), name: store.newName(templates), custom: { name, from: "copy", made: new Date().toISOString(), ...(baseName ? { base: baseName } : {}) } };
      t.files = filesIn(t.workflow);
      const { recipe: _r, name: _n, ...edits } = body;
      const saved = this.updateWorkflow(t, edits, undefined, true);
      const recipe = this.book.copy(from.id, name);
      recipe.template = saved.name;
      this.book.save();
      return sendJson(res, 200, { workflow: this.workflowInfo(saved, true), recipe: this.describe(recipe, files) }), true;
    }
    const one = path.match(/^\/host\/v1\/workflows\/(custom-[0-9a-f]{8})(?:\/revisions(?:\/(\d{1,6})(\/restore)?)?)?$/);
    if (!one) return false;
    const t = templates.get(one[1]!);
    if (!t?.custom) throw notFound("No such workflow.");
    const revisionsPath = path.endsWith("/revisions");
    if (revisionsPath && method === "GET") {
      const list = [...store.revisions(t.name), t].map((r) => ({ revision: r.custom?.revision ?? 1, saved: r.custom?.saved ?? r.custom?.made ?? null, by: r.custom?.by ?? "app", name: r.custom?.name ?? "" }));
      return sendJson(res, 200, { current: t.custom.revision ?? 1, revisions: list.reverse() }), true;
    }
    if (one[2]) {
      const n = Number(one[2]);
      const old = n === (t.custom.revision ?? 1) ? t : store.revisions(t.name).find((r) => (r.custom?.revision ?? 1) === n);
      if (!old) throw notFound("No such revision.");
      if (!one[3] && method === "GET") return sendJson(res, 200, { revision: n, workflow: old.workflow, video: old.video ?? null, name: old.custom?.name ?? "", layout: old.custom?.layout ?? null }), true;
      if (one[3] && method === "POST") {
        const body = await readJson(req);
        onlyFields(body, ["by"]);
        const restored = this.updateWorkflow(t, { workflow: old.workflow, ...(old.video ? { video: old.video } : {}), name: old.custom?.name ?? t.custom.name, layout: old.custom?.layout ?? null }, body.by);
        return sendJson(res, 200, this.workflowInfo(restored, true)), true;
      }
      return false;
    }
    if (revisionsPath) return false;
    if (method === "GET") return sendJson(res, 200, this.workflowInfo(t, true)), true;
    if (method === "PUT") {
      const body = await readJson(req, WORKFLOW_LIMIT);
      onlyFields(body, ["name", "workflow", "video", "by", "layout"]);
      return sendJson(res, 200, this.workflowInfo(this.updateWorkflow(t, body, body.by), true)), true;
    }
    return false;
  }

  /**
   * A model's workflow (API.md, "Custom workflows"): the built-in template it runs on, or its own custom workflow.
   * GET reads it; PUT saves it, giving a model on a built-in template a workflow of its own first (the built-in stays
   * as shipped, for the other models on it and for updates); DELETE puts such a model back on the built-in.
   */
  private async recipeWorkflowRoute(req: IncomingMessage, res: ServerResponse, method: string, id: string): Promise<boolean> {
    const store = this.workflows;
    if (!store) throw notFound("This host keeps no custom workflows.");
    if (this.sdcpp) throw invalid("This host makes images with stable-diffusion.cpp, which runs no ComfyUI workflows.");
    const templates = this.book.templates;
    const r = this.book.get(id);
    const t = templates.get(r.template);
    if (!t) throw notFound(`This host has no template ${r.template}.`);
    if (method === "GET") return sendJson(res, 200, this.recipeWorkflowInfo(r, t)), true;
    if (method === "PUT") {
      const body = await readJson(req, WORKFLOW_LIMIT);
      onlyFields(body, ["workflow", "video", "by", "layout", "name"]);
      if (t.custom) return sendJson(res, 200, this.recipeWorkflowInfo(r, this.updateWorkflow(t, body, body.by))), true;
      if (r.state !== "confirmed") throw invalid("Confirm the model first.");
      if (!t.does.some((a) => CUSTOM_ACTIONS.includes(a))) throw invalid("Only workflows that make, edit or animate can be edited.");
      // The model's own revision of the built-in: its name, the built-in as its base (whose blanks and nodes it may keep).
      const own: Template = { ...structuredClone(t), name: store.newName(templates), custom: { name: r.name, from: "copy", made: new Date().toISOString(), base: t.name } };
      own.files = filesIn(own.workflow);
      const { name: _n, ...edits } = body;
      const saved = this.updateWorkflow(own, edits, body.by, true);
      r.template = saved.name;
      this.book.save();
      return sendJson(res, 200, this.recipeWorkflowInfo(r, saved)), true;
    }
    if (method === "DELETE") {
      const base = t.custom?.base ? templates.get(t.custom.base) : undefined;
      if (!t.custom || !base) throw invalid(t.custom ? "This workflow was imported: it has no template to go back to." : "This model is on its template already.");
      r.template = base.name;
      this.book.save();
      if (!this.book.all().some((o) => o.template === t.name)) {
        templates.delete(t.name);
        store.remove(t.name);
      }
      return sendJson(res, 200, this.recipeWorkflowInfo(r, base)), true;
    }
    return false;
  }

  /** A model's workflow as GET …/recipes/<id>/workflow gives it: a custom one in full, or the built-in template as it ships. */
  private recipeWorkflowInfo(r: Recipe, t: Template) {
    if (t.custom) return { ...this.workflowInfo(t, true), builtIn: false };
    const nodes = this.workflows?.nodes ?? null;
    const used = new Set(Object.values(t.workflow).map((n) => n.class_type));
    return {
      name: t.name, label: r.name, from: "template", base: t.name, made: null, revision: 0, saved: null, by: "app", does: t.does, arch: t.arch,
      loaders: t.loaders ?? null, video: t.video ?? null, references: t.references, files: [], layout: null, recipes: [{ id: r.id, name: r.name }], nodesChecked: !!nodes,
      workflow: t.workflow, problems: [], missingNodes: nodes ? [...used].filter((c) => !nodes[c]) : null,
      nodes: nodes ? Object.fromEntries([...used].filter((c) => nodes[c]).map((c) => [c, nodes[c]!.inputs])) : null, builtIn: true,
    };
  }

  /**
   * A new version of a custom workflow: its nodes, clip settings or name changed, checked as any save, the version it
   * replaces kept as a revision. `by` "lyrica" marks a change Lyrica made at the user's word. `first`: the workflow's
   * first save (a model's own revision of a built-in, or a copy), revision 1 with nothing to keep.
   */
  private updateWorkflow(t: Template, body: Record<string, unknown>, by: unknown, first = false): Template {
    const store = this.workflows!;
    const templates = this.book.templates;
    const base = t.custom!.base ? templates.get(t.custom!.base) : undefined;
    const workflow = body.workflow === undefined ? t.workflow : parseWorkflow(body.workflow);
    const video = body.video === undefined ? t.video : videoSpec(body.video);
    if (video && !t.video) throw invalid("This workflow doesn't make videos.");
    // A layout not sent keeps the nodes that are still there where they were.
    const { layout: _old, ...custom } = t.custom!;
    const layout = layoutOf(body.layout === undefined ? t.custom!.layout : body.layout, workflow);
    const next: Template = { ...t, workflow, ...(video ? { video } : {}), files: filesIn(workflow), custom: { ...custom, ...(body.name !== undefined ? { name: label(body.name) } : {}), ...withLayout(layout) } };
    if (t.custom!.from === "import") next.references = referenceCount(workflow);
    const check = checkTemplate(next, store.nodes, base);
    if (check.problems.length) throw invalid(check.problems.join(" "));
    const saved = store.save(next, first ? undefined : t, by === "lyrica" ? "lyrica" : "app");
    templates.set(t.name, saved);
    // A workflow that loads its own files: its recipes' parts follow the files it now names.
    if (saved.loaders === "template" && t.custom!.from === "import") {
      for (const r of this.book.all().filter((r) => r.template === t.name)) r.parts = this.ownFileParts(saved.files ?? []);
      this.book.save();
    }
    return saved;
  }

  private customLoras(v: unknown): { file: string; strength: number }[] {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 8) throw invalid("loras must be a list of at most 8.");
    return v.map((l: Record<string, unknown>) => {
      const p = this.parts.find((x) => x.file === l?.file && x.role === "lora");
      if (!p) throw invalid(`${String(l?.file)} isn't a LoRA on this host.`);
      if (typeof l.strength !== "number" || l.strength < -4 || l.strength > 4) throw invalid("A LoRA's strength must be a number from -4 to 4.");
      return { file: p.file, strength: l.strength };
    });
  }

  private customDefaults(v: unknown): Record<string, string | number> {
    if (v === undefined) return {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid("defaults must be an object.");
    for (const [k, x] of Object.entries(v)) {
      if (!DEFAULT_KEYS.includes(k)) throw invalid(`Unknown default: ${k}.`);
      checkDefault(k, x);
    }
    return { ...(v as Record<string, string | number>) };
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
    // Hugging Face's or ModelScope's token, and Civitai's apart: each goes only to its own hub's parts.
    const header = (name: string) => (typeof req.headers[name] === "string" && req.headers[name] ? (req.headers[name] as string) : undefined);
    const tokenFor = (source: string) => (source === "civitai" ? header("x-civitai-token") : source === "url" ? undefined : header("x-hub-token"));
    const groups = new Map<string, typeof parts>();
    for (const p of parts) groups.set(`${p.source} ${p.repo}`, [...(groups.get(`${p.source} ${p.repo}`) ?? []), p]);
    const made: unknown[] = [];
    for (const group of groups.values()) {
      const { source, repo } = group[0]!;
      const token = tokenFor(source);
      if (source === "huggingface" || source === "modelscope" || source === "civitai") {
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
    const template = this.book.get(id).template;
    const { candidates, kept } = this.book.remove(id);
    // A custom workflow goes with its last recipe, revisions and all.
    if (this.book.templates.get(template)?.custom && !this.book.all().some((r) => r.template === template)) {
      this.book.templates.delete(template);
      this.workflows?.remove(template);
    }
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
    const sdArgs = this.sdcpp ? sdcppArgs(recipe, this.modelsDir, this.sdcpp.card(), (file) => statSync(join(this.modelsDir, file)).size) : null;
    const template = this.book.templates.get(recipe.template)!;
    const loras = this.jobLoras(recipe, body.loras);

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
      // A template that makes one image a job (P-H3-Image's latent can't be batched) says so rather than making fewer.
      if (Number(values.count) > 1 && !JSON.stringify(template.workflow).includes('"$count"')) throw invalid("This recipe makes one image at a time: ask for one.");
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
      // A custom workflow loads each of its references: it can't leave one out as a built-in template can.
      if (template.custom && template.references && (Array.isArray(refs) ? refs.length : 0) !== template.references) {
        throw invalid(`This recipe's workflow takes ${template.references} reference image${template.references > 1 ? "s" : ""}.`);
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
    values.seed = action === "upscale" ? int(body, "seed", 0, UPSCALE_SEEDS - 1) ?? randomInt(UPSCALE_SEEDS) : int(body, "seed", 0, 2 ** 48) ?? randomInt(2 ** 47);

    const started = Date.now();
    const gpu = this.pick(recipe);
    const model = this.asModel(recipe, gpu);
    const comfy = this.comfy.byGpu.get(gpu)!;
    // A client that goes away cancels its job, queued or running.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const scheduler = this.runtime.scheduler;
    const sdcpp = this.sdcpp;
    if (sdcpp && sdArgs) sdcpp.prepare(model.id, sdArgs);
    // stable-diffusion.cpp reports no steps: its job only says it runs.
    const pngs = await this.on(gpu, () => scheduler.run(model, "image", () => {
      job.running();
      return scheduler.measuring(model, () =>
        sdcpp ? sdcpp.create(model.id, recipe.template, values, abort.signal) : comfy.run(uploads, (names) => {
          this.checkBeforeRun(template);
          const parts = recipe.parts.filter((p): p is typeof p & { file: string } => !!p.file);
          return fill(template, parts, loras, { ...values, ...names });
        }, abort.signal, job.progress));
    }, gpu, abort.signal));
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
   * (`motion`), or a clip edited as the prompt says (`edit_video`, from `source`). The template times it: the duration becomes the model's frame
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
    if (body.source !== undefined && (extending || body.image !== undefined || body.drive !== undefined)) throw invalid("source takes no image, driving clip or clip to extend: the edit is of that clip alone.");
    const action: Action = body.source !== undefined ? "edit_video" : body.drive !== undefined ? "motion" : body.image === undefined ? "video" : "animate";
    if (!extending && !recipe.does.includes(action)) {
      throw invalid(action === "motion" ? (recipe.does.some((a) => a === "video" || a === "animate") ? "That recipe doesn't move an image as a clip does." : "That recipe doesn't make videos.")
        : action === "edit_video" ? "That recipe doesn't edit clips."
        : recipe.does.includes("edit_video") ? "That recipe edits a clip: give it source."
        : recipe.does.includes("motion") ? "That recipe moves an image as a clip does: give it both."
        : recipe.does.includes("animate") ? "That recipe animates an image: give it one." : recipe.does.includes("video") ? "That recipe doesn't animate images." : "That recipe doesn't make videos.");
    }
    if (action === "motion" && body.image === undefined) throw invalid("image is missing: the one whose subject moves.");
    if (this.sdcpp) throw invalid("This host makes images with stable-diffusion.cpp, which can't make videos.");
    const template = this.book.templates.get(recipe.template)!;
    const spec = template.video;
    if (!spec) throw new HostError(500, "internal", `Template ${template.name} has no video settings.`);
    const chain = template.continuation;
    const loras = this.jobLoras(recipe, body.loras);
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
    if (action === "animate" || action === "motion") uploads.image = inputImage(body.image, "image");
    let driveSeconds = Infinity;
    if (action === "motion") {
      if (typeof body.drive !== "string") throw invalid("drive must be a base64 MP4.");
      uploads.drive = Buffer.from(body.drive, "base64");
      if (uploads.drive.length > DRIVE_LIMIT) throw invalid("drive is larger than 64 MB.");
      const seconds = mp4Seconds(uploads.drive);
      if (seconds === null) throw invalid("drive isn't an MP4 or QuickTime clip whose length can be read.");
      driveSeconds = seconds;
    }
    // A clip to edit: its own shape and length, at most the recipe's longest clip.
    let source: { width: number; height: number; frames: number; fps: number } | null = null;
    if (action === "edit_video") {
      if (typeof body.source !== "string") throw invalid("source must be a base64 MP4.");
      uploads.source = Buffer.from(body.source, "base64");
      if (uploads.source.length > DRIVE_LIMIT) throw invalid("source is larger than 64 MB.");
      source = mp4Video(uploads.source);
      if (!source || !source.fps) throw invalid("source isn't an MP4 clip whose video track can be read.");
      if (Math.floor(source.frames * spec.fps / source.fps) < spec.frameStep + spec.frameOffset) throw invalid(`That clip is too short to edit: it needs at least ${Math.ceil((spec.frameStep + spec.frameOffset) / spec.fps * 10) / 10} s.`);
    }
    let previous: Buffer | null = null;
    const width = int(body, "width", 256, 2048);
    const height = int(body, "height", 256, 2048);
    const ratio = aspectRatio(body.aspectRatio);
    if (ratio !== undefined && (width !== undefined || height !== undefined)) throw invalid("Give a size or an aspect ratio, not both.");
    if (source && (width !== undefined || height !== undefined || ratio !== undefined)) throw invalid("An edited clip keeps its own shape.");
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
      const shape = ratio ?? (source ? source.width / source.height : frame && width === undefined && height === undefined ? frame.width / frame.height : Number(values.width) / Number(values.height));
      values.width = snap(width ?? (height !== undefined ? height * shape : Math.sqrt(area * shape)));
      values.height = snap(height ?? (width !== undefined ? width / shape : Math.sqrt(area / shape)));
    }
    // A driving clip can't give more moves than it has. Extending, the duration is what's added.
    const longest = extending ? LONGEST_SECONDS : longestSeconds(template);
    let duration = Math.min(num(body, "duration", 1, longest) ?? Math.min(Number(values.duration), longest), driveSeconds);
    if (source) {
      // The whole clip unless fewer seconds are asked for, in the model's frame counts, never past the clip's own frames.
      const have = Math.min(Math.floor(source.frames * spec.fps / source.fps), Number(videoValues(spec, spec.maxSeconds, 0, 0, 1).frames));
      const fit = Math.floor((have - spec.frameOffset) / spec.frameStep) * spec.frameStep + spec.frameOffset;
      const asked = body.duration === undefined ? fit : Math.min(fit, Number(videoValues(spec, duration, 0, 0, 1).frames));
      // Just under the count, so videoValues rounds back to it whatever the float error.
      duration = (asked - 0.5) / spec.fps;
    }
    const parts = present(recipe, this.files());
    const multiplier = parts.some((p) => p.role === "interpolator") ? spec.interpolate ?? 1 : 1;
    const plan = source ? [duration] : clipPlan(spec, chain, duration, extending);
    const clips = plan.map((seconds) => videoValues(spec, seconds, Number(values.width), Number(values.height), Number(values.steps), multiplier));
    values.seed = int(body, "seed", 0, 2 ** 48) ?? randomInt(2 ** 47);

    const started = Date.now();
    // Every clip of a chain runs on one GPU.
    const gpu = this.pick(recipe);
    const model = this.asModel(recipe, gpu);
    const comfy = this.comfy.byGpu.get(gpu)!;
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const scheduler = this.runtime.scheduler;
    // One hold on the GPU for every clip, and one progress, each clip weighted by its frames.
    const total = clips.reduce((n, c) => n + Number(c.frames), 0);
    const { video, poster } = await this.on(gpu, () => scheduler.run(model, "image", () => {
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
          const made = await comfy.runVideo(first ? uploads : { previous: video!, ...(ref ? { reference: uploads.image! } : {}) }, (names) => (this.checkBeforeRun(t), fill(t, parts, loras, { ...step, ...names })),
            VIDEO_TIMEOUT_MS, abort.signal, (f) => job.progress((done + f * Number(clip.frames)) / total));
          video = made.video;
          poster = made.poster ?? poster;
          done += Number(clip.frames);
        }
        return { video: video!, poster };
      });
    }, gpu, abort.signal));
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

  /**
   * A whole clip through an upscaler whose template has a clip workflow (SeedVR2's): its frames in batches, at
   * `scale` times the shorter side as for images, keeping its frame rate and sound.
   */
  private async upscaleClip(req: IncomingMessage, res: ServerResponse, job: JobProgress): Promise<void> {
    const body = await readJson(req, Math.ceil(DRIVE_LIMIT / 3) * 4 + 1024 * 1024);
    onlyFields(body, CLIP_UPSCALE_FIELDS);
    if (typeof body.recipe !== "string") throw invalid("recipe is missing.");
    const recipe = this.book.all().find((r) => r.id === body.recipe && r.state === "confirmed");
    if (!recipe || !this.book.ready(recipe, this.files())) throw notFound("No confirmed, ready recipe with that ID.");
    const template = this.book.templates.get(recipe.template)!;
    if (!recipe.does.includes("upscale") || !template.clipWorkflow) throw invalid("That recipe doesn't upscale clips.");
    if (this.sdcpp) throw invalid("This host makes images with stable-diffusion.cpp, which can't upscale clips.");
    if (typeof body.video !== "string") throw invalid("video must be a base64 MP4.");
    const clip = Buffer.from(body.video, "base64");
    if (clip.length > DRIVE_LIMIT) throw invalid("video is larger than 64 MB.");
    const source = mp4Video(clip);
    if (!source) throw invalid("video isn't an MP4 clip whose video track can be read.");

    const values: Values = { ...BASE_DEFAULTS, batchSize: 33, temporalOverlap: 3, ...recipe.defaults };
    const scale = num(body, "scale", 1, 4) ?? Number(values.scale);
    values.maxSize = int(body, "maxSize", 256, 8192) ?? values.maxSize!;
    if (body.colorMatch !== undefined && !COLOR_MATCH.includes(body.colorMatch as string)) throw invalid(`colorMatch must be one of ${COLOR_MATCH.join(", ")}.`);
    values.colorMatch = (body.colorMatch as string) ?? values.colorMatch!;
    const short = Math.min(source.width, source.height), long = Math.max(source.width, source.height);
    values.resolution = Math.min(MAX_RESOLUTION, Math.round(short * scale));
    // The upscaler scales the shorter side to `resolution`, then both down again if the longer passes maxSize.
    const k = Math.min(Number(values.resolution) / short, Number(values.maxSize) / long);
    const width = Math.round(source.width * k), height = Math.round(source.height * k);
    if (width * height * source.frames > MAX_CLIP_UPSCALE_PIXELS) {
      const most = Math.floor(MAX_CLIP_UPSCALE_PIXELS / (width * height));
      throw invalid(`At ${width}×${height} a clip upscales at most ${most} frames (${(most / source.fps).toFixed(1)} s); this one has ${source.frames}. Use a smaller scale or a shorter clip.`);
    }
    for (const p of recipe.parts) if (p.file) values[`${p.role}Name`] = this.seedvr2Names.get(p.file) ?? basename(p.file);
    values.seed = int(body, "seed", 0, UPSCALE_SEEDS - 1) ?? randomInt(UPSCALE_SEEDS);

    const started = Date.now();
    const gpu = this.pick(recipe);
    const model = this.asModel(recipe, gpu);
    const comfy = this.comfy.byGpu.get(gpu)!;
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const scheduler = this.runtime.scheduler;
    const parts = present(recipe, this.files());
    const { video, poster } = await this.on(gpu, () => scheduler.run(model, "image", () => {
      job.running();
      return scheduler.measuring(model, () => comfy.runVideo({ source: clip }, (names) => fill({ ...template, workflow: template.clipWorkflow! }, parts, [], { ...values, ...names }),
        VIDEO_TIMEOUT_MS, abort.signal, job.progress));
    }, gpu, abort.signal));
    const seconds = (Date.now() - started) / 1000;
    this.runtime.count(recipe.id, { requests: 1, seconds });
    this.log("video", { recipe: recipe.id, action: "upscale", frames: source.frames });
    const made = mp4Video(video);
    const size = poster ? imageSize(poster) : null;
    const frames = made?.frames ?? source.frames, fps = made?.fps ?? source.fps;
    sendJson(res, 200, {
      video: { mp4: video.toString("base64"), width: size?.width ?? made?.width ?? width, height: size?.height ?? made?.height ?? height,
        frames, fps, duration: frames / fps, audio: mp4Sound(video), seed: values.seed },
      poster: poster ? poster.toString("base64") : null,
      seconds,
    });
  }

  /** What stops images being made on this host, for the status. */
  get problems(): string[] {
    if (this.sdcpp) return this.sdcpp.problem ? [`Images: ${this.sdcpp.problem}`] : [];
    const several = this.gpus.length > 1;
    return this.comfy.problems.map(({ gpu, problem }) => `Images${several ? ` on GPU ${gpu}` : ""}: ${problem}`);
  }

  /**
   * The GPU for a job of this recipe: the one with the fewest jobs; on a tie,
   * one that has the recipe loaded, then the first listed. Only GPUs whose
   * ComfyUI can run and that it fits, while there are any.
   */
  private pick(r: Recipe): number {
    const runs = this.sdcpp ? this.gpus : this.gpus.filter((gpu) => !this.comfy.byGpu.get(gpu)!.problem);
    const fits = (runs.length ? runs : this.gpus).filter((gpu) => !this.runtime.scheduler.neverFits({ model: this.asModel(r, gpu), gpu }));
    const ranked = (fits.length ? fits : runs.length ? runs : this.gpus).map((gpu, i) => ({
      gpu, i, jobs: this.jobsOn.get(gpu) ?? 0, loaded: this.runtime.scheduler.placement(this.asModel(r, gpu).id) ? 0 : 1,
    }));
    ranked.sort((a, b) => a.jobs - b.jobs || a.loaded - b.loaded || a.i - b.i);
    return ranked[0]!.gpu;
  }

  /** Runs a job counted against its GPU. */
  private async on<T>(gpu: number, fn: () => Promise<T>): Promise<T> {
    this.jobsOn.set(gpu, (this.jobsOn.get(gpu) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      this.jobsOn.set(gpu, this.jobsOn.get(gpu)! - 1);
    }
  }

  /** A recipe as the scheduler sees it, on one GPU: with several image GPUs, each GPU's copy is its own model. */
  private asModel(r: Recipe, gpu: number): TextModel {
    const size = recipeSize(r, this.parts);
    return {
      id: this.gpus.length > 1 ? `recipe:${r.id}@gpu${gpu}` : `recipe:${r.id}`, kind: "image", server: "comfyui", format: "safetensors", size,
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
 * the other, each with its own LoRAs. A CLIP vision model and a segmenter count with the VAEs.
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
  // A LoRA not made for one expert goes onto both.
  const model = Math.max(0, ...[...groups].map(([, n]) => n + loras), loras);
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

const withLayout = (layout: Record<string, [number, number]> | undefined) => (layout ? { layout } : {});
