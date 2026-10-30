// The text models and their routes: the OpenAI-compatible /v1, and the
// management calls in API.md ("Status and control").
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { RecordEntry } from "./downloads.ts";
import { HostError, invalid, notFound, onlyFields, readJson, sendJson } from "./http.ts";
import { projectorFiles, scanTextModels, type TextModel } from "./library.ts";
import type { Logger } from "./log.ts";
import { SERVER_NAMES, SERVERS, concurrentOf, contextOf, maxContextOf, serverOf, sizes, usesVision, validate, type Server } from "./placement.ts";
import { PRIORITIES, type Priority, type Scheduler } from "./scheduler.ts";
import { Jobs } from "./jobs.ts";

/** How long a /v1 request tagged with X-Lyrica-Job may wait for the GPU: long enough to load a very large model. */
export const TAGGED_WAIT_MS = 15 * 60_000;
import { NO_USAGE, type StateFile, type Usage } from "./state.ts";

const BODY_LIMIT = 64 * 1024 * 1024;
/** The speech server's audio: 16-bit mono PCM at 24 kHz. */
const SPEECH_RATE = 24000;
const KIND_USE: Record<TextModel["kind"], string> = {
  chat: "chat", embedding: "embeddings", image: "images", transcribe: "dictation", speak: "speech",
};

/** A WAV clip's length in seconds, from its header; 0 if it isn't one. */
export function wavSeconds(b: Buffer): number {
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return 0;
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= b.length) {
    const id = b.toString("latin1", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "fmt " && at + 16 <= b.length) byteRate = b.readUInt32LE(at + 16);
    if (id === "data") return byteRate ? Math.min(size, b.length - at - 8) / byteRate : 0;
    at += 8 + size + (size % 2);
  }
  return 0;
}

/** Finds the token counts in a response, streamed or not, without keeping its text. */
class UsageSniffer {
  private partial = "";
  private whole: Buffer[] | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

  constructor(streaming: boolean) {
    this.whole = streaming ? null : [];
  }

  feed(chunk: Buffer): void {
    if (this.whole) {
      this.whole.push(chunk);
      return;
    }
    const lines = (this.partial + chunk.toString("utf8")).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (!line.startsWith("data:") || !line.includes('"usage"')) return;
    try {
      const usage = JSON.parse(line.slice(5)).usage;
      if (usage) this.usage = usage;
    } catch {}
  }

  done(): void {
    if (this.whole) {
      try {
        this.usage = JSON.parse(Buffer.concat(this.whole).toString("utf8")).usage ?? null;
      } catch {}
      this.whole = null;
    } else this.line(this.partial);
  }
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new HostError(400, "invalid", "The request is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export class Runtime {
  models: TextModel[] = [];
  /** Every vision projector in the models folder: what a model's projector may be picked from. */
  projectors: { path: string; size: number }[] = [];
  /** The projector each model's name matches, which a pick in its settings replaces. */
  private readonly matched = new Map<string, { path: string; size: number } | null>();
  /** The download record, by path, from the fetch service. */
  record = new Map<string, RecordEntry>();
  /** Scans image parts too (set when the host has ComfyUI). */
  afterScan: (() => { parts: number; proposals: number }) | null = null;
  readonly scheduler: Scheduler;
  /** Jobs a client tagged with X-Lyrica-Job, text and image alike, for their progress. */
  readonly jobs = new Jobs();
  private readonly modelsDir: string;
  readonly state: StateFile;
  private readonly log: Logger;
  private readonly pending = new Map<string, Usage>();
  private readonly flusher: NodeJS.Timeout;

  constructor(o: { scheduler: Scheduler; modelsDir: string; state: StateFile; log: Logger }) {
    this.scheduler = o.scheduler;
    this.modelsDir = o.modelsDir;
    this.state = o.state;
    this.log = o.log;
    this.flusher = setInterval(() => this.flush(), 60_000);
    this.flusher.unref();
  }

  scan(): { models: number; parts: number; proposals: number } {
    this.models = scanTextModels(this.modelsDir).filter((m) => this.scheduler.serves(m));
    this.projectors = projectorFiles(this.modelsDir);
    this.matched.clear();
    for (const m of this.models) {
      this.matched.set(m.id, m.mmproj ? { path: m.mmproj, size: m.mmprojSize ?? 0 } : null);
      this.pickProjector(m, this.scheduler.settings(m).mmproj);
    }
    const images = this.afterScan?.() ?? { parts: 0, proposals: 0 };
    this.log("scanned", { models: this.models.length, ...images });
    return { models: this.models.length, ...images };
  }

  async start(): Promise<void> {
    this.scan();
    await this.scheduler.start(this.models);
  }

  /**
   * The model's projector: the one picked in its settings while that file is
   * still here, else the one its name matches. Its sight follows.
   */
  private pickProjector(m: TextModel, picked: string | undefined): void {
    if (m.server !== "llamacpp" || m.kind !== "chat") return;
    const p = (picked ? this.projectors.find((x) => x.path === picked) : undefined) ?? this.matched.get(m.id) ?? null;
    m.mmproj = p?.path ?? null;
    if (p) m.mmprojSize = p.size;
    else delete m.mmprojSize;
    m.capabilities = { ...m.capabilities, vision: !!p };
  }

  find(id: unknown): TextModel {
    if (typeof id !== "string" || !id) throw invalid("model is missing.");
    const model = this.models.find((m) => m.id === id);
    if (!model) throw notFound("No model with that ID on this host.");
    return model;
  }

  count(id: string, add: Partial<Usage>): void {
    const u = this.pending.get(id) ?? NO_USAGE();
    for (const k of Object.keys(add) as (keyof Usage)[]) u[k] += add[k] ?? 0;
    this.pending.set(id, u);
  }

  flush(): void {
    if (!this.pending.size) return;
    const pending = [...this.pending];
    this.pending.clear();
    this.state.update((s) => {
      for (const [id, add] of pending) {
        const u = (s.usage[id] ??= NO_USAGE());
        for (const k of Object.keys(add) as (keyof Usage)[]) u[k] += add[k];
      }
    });
  }

  close(): void {
    clearInterval(this.flusher);
    this.flush();
  }

  /** Handles /v1 and the management routes. Returns false for anything else. */
  async route(req: IncomingMessage, res: ServerResponse, pathname: string, method: string): Promise<boolean> {
    if (pathname === "/v1/models" && method === "GET") {
      sendJson(res, 200, { object: "list", data: this.models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "lyrica-host" })) });
      return true;
    }
    if ((pathname === "/v1/chat/completions" || pathname === "/v1/embeddings") && method === "POST") {
      await this.proxy(req, res, pathname);
      return true;
    }
    if (pathname === "/v1/audio/transcriptions" && method === "POST") {
      await this.transcribe(req, res);
      return true;
    }
    if (pathname === "/v1/audio/speech" && method === "POST") {
      await this.speak(req, res);
      return true;
    }
    if (pathname === "/host/v1/models" && method === "GET") {
      sendJson(res, 200, { models: this.models.map((m) => this.describe(m)) });
      return true;
    }
    if (pathname === "/host/v1/scan" && method === "POST") {
      sendJson(res, 200, this.scan());
      return true;
    }
    if (pathname === "/host/v1/usage" && method === "GET") {
      this.flush();
      const s = this.state.get();
      sendJson(res, 200, { since: s.usageSince, models: Object.entries(s.usage).map(([id, u]) => ({ id, ...u })) });
      return true;
    }
    const s = this.scheduler;
    if (pathname === "/host/v1/models/settings" && method === "GET") {
      const model = this.find(new URL(req.url ?? "/", "http://host").searchParams.get("model"));
      sendJson(res, 200, this.servingEntry(model));
      return true;
    }
    if (pathname === "/host/v1/models/settings" && method === "PUT") {
      const body = await readJson(req);
      onlyFields(body, ["model", "settings", "anyway"]);
      const model = this.find(body.model);
      if (!body.settings || typeof body.settings !== "object") throw invalid("settings is needed.");
      const picked = (body.settings as Record<string, unknown>).mmproj;
      if (picked !== undefined && !this.projectors.some((p) => p.path === picked)) throw invalid("There's no projector at that path in the models folder.");
      // Checked with the projector it would have.
      const as = { ...model, capabilities: { ...model.capabilities } };
      this.pickProjector(as, picked as string | undefined);
      // Refused when saved if the placement can't work, with the reason. Applies at the next load, or on Reload.
      const saved = validate(as, body.settings as Record<string, unknown>, await s.validationGpus(serverOf(model)), (i) => s.gpuSettings(i), s.onCpu(model));
      // A stretch past what the publisher documents was never tested by them: saved only when asked for anyway.
      const rec = this.state.get().recommended[model.id];
      if (saved.stretch && rec?.factor && saved.stretch.factor > rec.factor && body.anyway !== true) {
        throw new HostError(409, "above_recommended", `${rec.source.repo.split("/")[0]} documents ${rec.factor}.`);
      }
      s.saveSettings(model, saved);
      this.pickProjector(model, saved.mmproj);
      sendJson(res, 200, this.describe(model));
      return true;
    }
    // Look up is the download side's: it goes through fetch.
    if (method === "POST" && pathname.startsWith("/host/v1/models/") && pathname !== "/host/v1/models/lookup") {
      const body = await readJson(req);
      const action = pathname.slice("/host/v1/models/".length);
      if (action === "load") {
        onlyFields(body, ["model"]);
        await s.loadNow(this.find(body.model));
      } else if (action === "unload") {
        onlyFields(body, ["model"]);
        await s.unloadNow(this.find(body.model).id);
      } else if (action === "reload") {
        onlyFields(body, ["model"]);
        await s.reload(this.find(body.model));
      } else if (action === "pin") {
        onlyFields(body, ["model", "pinned"]);
        if (typeof body.pinned !== "boolean") throw invalid("pinned is needed.");
        await s.pin(this.find(body.model), body.pinned);
      } else throw notFound();
      sendJson(res, 200, this.describe(this.find(body.model)));
      return true;
    }
    const gpu = pathname.match(/^\/host\/v1\/gpus\/(\d+)$/);
    if (gpu && method === "PUT") {
      const body = await readJson(req);
      onlyFields(body, ["servers", "keepFree", "excluded"]);
      const servers = body.servers ?? s.servers;
      if (!Array.isArray(servers) || servers.some((x) => !SERVERS.includes(x as Server))) throw invalid(`servers lists any of ${SERVERS.join(", ")}.`);
      const missing = (servers as Server[]).filter((x) => !s.servers.includes(x));
      if (missing.length) throw invalid(`This host doesn't run ${missing.join(" or ")}; it runs ${s.servers.join(", ")}.`);
      const keepFree = body.keepFree ?? 512 * 1024 * 1024;
      const total = s.knownGpus.find((g) => g.index === Number(gpu[1]))?.total ?? Infinity;
      if (typeof keepFree !== "number" || !Number.isFinite(keepFree) || keepFree < 0 || keepFree >= total) {
        throw invalid("keepFree is bytes, from 0 to less than the GPU's memory.");
      }
      if (body.excluded !== undefined && typeof body.excluded !== "boolean") throw invalid("excluded is true or false.");
      await s.setGpu(Number(gpu[1]), { servers: [...new Set(servers as Server[])], keepFree, excluded: body.excluded === true });
      sendJson(res, 200, { settings: s.gpuSettings(Number(gpu[1])) });
      return true;
    }
    if (method === "POST" && ["/host/v1/pause", "/host/v1/resume", "/host/v1/restart"].includes(pathname)) {
      if (pathname.endsWith("pause")) await s.pause();
      else if (pathname.endsWith("resume")) await s.resume(this.models);
      else await s.restart(this.models);
      sendJson(res, 200, { state: s.runState });
      return true;
    }
    return false;
  }

  /**
   * A model's serving settings, with what they mean: the context it is
   * served with and its maximum, what it was trained for, the KV cache at
   * that context, and what its card recommends.
   */
  servingEntry(m: TextModel) {
    const settings = this.scheduler.settings(m);
    const served = this.scheduler.served(m);
    const sized = m.kind === "image" || m.kind === "speak" ? null : sizes(m, served);
    return {
      model: m.id,
      settings,
      contextLength: contextOf(m, served),
      maxContextLength: maxContextOf(m, settings),
      trainedContextLength: m.contextLength,
      kvBytes: sized && m.kvPerToken !== null ? sized.kv : null,
      recommended: this.state.get().recommended[m.id] ?? null,
      // vLLM 0.30 misreads the original context on Qwen3.5-style M-RoPE (vllm#58870).
      stretchUntested: m.server === "vllm",
      // What the Vision and MTP switches can turn off: a projector, and an MTP file or the model's own MTP layers.
      extras: { vision: !!m.mmproj, mtp: m.mtp ? "file" : m.builtInMtp ? "built-in" : null },
      ...(m.server === "llamacpp" && m.kind === "chat" ? this.companionFacts(m) : {}),
    };
  }

  /**
   * A GGUF chat model's companion files: the projector it loads (picked or
   * matched by name), the projector its name matches, every projector here
   * (its own folders first) to pick from, and the repository it was
   * downloaded from, where a missing projector or MTP file can be found.
   */
  private companionFacts(m: TextModel) {
    const dirs = (p: string) => p.split("/").slice(0, -1);
    const near = (p: string) => { const a = dirs(p), b = dirs(m.id); let n = 0; while (n < a.length && a[n] === b[n]) n++; return n; };
    const entry = this.record.get(m.id);
    return {
      projector: m.mmproj,
      matchedProjector: this.matched.get(m.id)?.path ?? null,
      projectors: [...this.projectors].sort((a, b) => near(b.path) - near(a.path) || a.path.localeCompare(b.path)),
      origin: entry?.repo && (entry.source === "huggingface" || entry.source === "modelscope") ? { source: entry.source, repo: entry.repo, revision: entry.revision } : null,
    };
  }

  describe(m: TextModel) {
    const at = this.scheduler.placement(m.id);
    const s = this.state.get();
    const entry = this.record.get(m.id);
    const folder = m.format !== "gguf" ? [...this.record.values()].find((r) => r.path.startsWith(`${m.id}/`)) : undefined;
    return {
      id: m.id,
      kind: m.kind,
      server: m.server,
      format: m.format,
      size: m.size,
      sha256: entry?.sha256 ?? null,
      downloaded: !!(entry ?? folder),
      identity: { ...m.identity, card: (entry ?? folder)?.card ?? null },
      // A projector left out by its setting takes the model's sight with it.
      capabilities: { ...m.capabilities, ...(m.mmproj ? { vision: usesVision(m, this.scheduler.settings(m)) } : {}) },
      // The context it is served with; maxContextLength is what it was trained for.
      contextLength: m.kind === "image" || m.kind === "speak" ? null : contextOf(m, this.scheduler.served(m)),
      maxContextLength: m.contextLength,
      // Requests it serves at once, sharing that context.
      parallel: concurrentOf(m, this.scheduler.served(m)),
      // What its publisher recommends, which its server uses for a setting a request leaves out.
      sampling: m.sampling ?? null,
      kvBytes: this.servingEntry(m).kvBytes,
      stretch: this.scheduler.settings(m).stretch?.factor ?? null,
      state: at?.state ?? "unloaded",
      gpus: at?.gpus ?? null,
      placement: this.scheduler.settings(m).placement,
      pinned: s.pins.includes(m.id),
      vram: Object.fromEntries(Object.entries(s.vram).filter(([k]) => k.startsWith(`${m.id}@`)).map(([k, v]) => [k.slice(m.id.length + 1), v])),
    };
  }

  private priority(req: IncomingMessage): Priority {
    const header = req.headers["x-lyrica-priority"];
    return PRIORITIES.includes(header as Priority) ? (header as Priority) : "chat";
  }

  /** The model a /v1 request names, refused unless it is of the kind the route serves. */
  private modelFor(id: unknown, want: TextModel["kind"]): TextModel {
    const model = this.find(id);
    if (model.kind !== want) throw invalid(`That model is for ${KIND_USE[model.kind]}, not ${KIND_USE[want]}.`);
    return model;
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const raw = await readRaw(req);
    let body: { model?: unknown; stream?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw invalid("The body isn't valid JSON.");
    }
    const model = this.modelFor(body.model, path === "/v1/embeddings" ? "embedding" : "chat");
    const started = Date.now();
    const sniffer = new UsageSniffer(body.stream === true);
    await this.pass(req, res, model, path, raw, "application/json", (chunk) => sniffer.feed(chunk));
    sniffer.done();
    this.count(model.id, {
      requests: 1,
      promptTokens: sniffer.usage?.prompt_tokens ?? 0,
      completionTokens: sniffer.usage?.completion_tokens ?? 0,
      seconds: (Date.now() - started) / 1000,
    });
  }

  /**
   * Dictation: OpenAI's multipart form, passed to vLLM unchanged. Only the
   * model's name is read from it; the audio is never kept.
   */
  private async transcribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const type = req.headers["content-type"] ?? "";
    if (!type.startsWith("multipart/form-data")) throw invalid("Send the audio as multipart/form-data, with file and model.");
    const raw = await readRaw(req);
    let form: FormData;
    try {
      form = await new Response(raw, { headers: { "content-type": type } }).formData();
    } catch {
      throw invalid("The form couldn't be read.");
    }
    const file = form.get("file");
    if (!(file instanceof Blob) || !file.size) throw invalid("file is missing: the audio to transcribe.");
    const model = this.modelFor(form.get("model"), "transcribe");
    const started = Date.now();
    await this.pass(req, res, model, "/v1/audio/transcriptions", raw, type);
    this.count(model.id, { requests: 1, seconds: (Date.now() - started) / 1000, audioSeconds: wavSeconds(Buffer.from(await file.arrayBuffer())) });
  }

  /** Her voice: the speech server's audio, streamed back as it is made. */
  private async speak(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, 128 * 1024);
    onlyFields(body, ["model", "input", "voice", "speed", "response_format"]);
    const model = this.modelFor(body.model, "speak");
    if (typeof body.input !== "string" || !body.input.trim() || [...body.input].length > 4096) throw invalid("input is the text to read, 1 to 4096 characters.");
    const voices = model.capabilities.speak?.voices ?? [];
    if (typeof body.voice !== "string" || !voices.some((v) => v.id === body.voice)) {
      throw invalid(`voice is one of this model's voices: ${voices.map((v) => v.id).slice(0, 12).join(", ")}${voices.length > 12 ? " …" : ""}.`);
    }
    const speed = body.speed ?? 1;
    if (typeof speed !== "number" || !(speed >= 0.25 && speed <= 4)) throw invalid("speed is from 0.25 to 4.");
    if (body.response_format !== undefined && body.response_format !== "pcm") throw invalid("response_format is pcm: 16-bit mono at 24 kHz.");
    const raw = Buffer.from(JSON.stringify({ model: model.id, input: body.input, voice: body.voice, speed }));
    const started = Date.now();
    let bytes = 0;
    await this.pass(req, res, model, "/v1/audio/speech", raw, "application/json", (chunk) => (bytes += chunk.length));
    this.count(model.id, { requests: 1, seconds: (Date.now() - started) / 1000, audioSeconds: bytes / (SPEECH_RATE * 2) });
  }

  /**
   * Passes one request to the server holding the model, loading it first,
   * and its answer back as it arrives. A client that goes away cancels the
   * request, queued or running; an answer the server cuts short is cut short
   * too. A server that doesn't answer is `unavailable`. A request tagged with
   * X-Lyrica-Job waits for the GPU up to 15 minutes, and its job
   * says what it waits for.
   */
  private async pass(req: IncomingMessage, res: ServerResponse, model: TextModel, path: string, raw: Buffer, type: string, onChunk?: (chunk: Buffer) => void): Promise<void> {
    const token = this.jobs.token(req);
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    await this.jobs.track(token, (job) => this.scheduler.run(model, this.priority(req), async (base) => {
      job.running();
      // http.request, not fetch: fetch gives up on headers after 300 seconds,
      // which a long answer that isn't streamed can take.
      const url = new URL(base + path);
      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const r = http.request(url, { method: "POST", headers: { "content-type": type, "content-length": raw.length }, signal: abort.signal }, resolve);
        r.on("error", () => reject(new HostError(503, "model_unavailable", `The ${SERVER_NAMES[serverOf(model)]} server didn't answer.`)));
        r.end(raw);
      });
      if (model.server === "llamacpp" && upstream.statusCode === 400) {
        const chunks: Buffer[] = [];
        for await (const chunk of upstream) chunks.push(Buffer.from(chunk));
        const error = Buffer.concat(chunks);
        if (/model (?:is )?not loaded/i.test(error.toString("utf8"))) {
          this.scheduler.missing(model.id);
          throw new HostError(503, "model_unavailable", "llama.cpp no longer has this model loaded; try again.");
        }
        res.writeHead(400, { "content-type": upstream.headers["content-type"] ?? "application/json" });
        res.end(error);
        return;
      }
      res.writeHead(upstream.statusCode ?? 502, { "content-type": upstream.headers["content-type"] ?? "application/json", "cache-control": "no-store" });
      // A server that dies half way through ends the answer: "close" always
      // comes, and an answer cut short isn't "complete".
      await new Promise<void>((resolve) => {
        upstream.on("data", (chunk: Buffer) => {
          onChunk?.(chunk);
          res.write(chunk);
        });
        upstream.on("error", () => {});
        upstream.on("close", () => {
          if (upstream.complete) res.end();
          else res.destroy();
          resolve();
        });
      });
    }, undefined, abort.signal, token ? { waitLimit: TAGGED_WAIT_MS, phase: (p) => job.waiting(p) } : {}));
  }
}
