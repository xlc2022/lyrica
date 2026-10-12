// host-api's side of downloads: it asks the fetch service, which alone has
// a route out and write access to lyrica/. A hub token passes through, used
// for that request only, and is never logged or kept.
import type { IncomingMessage, ServerResponse } from "node:http";
import { HostError, invalid, onlyFields, readJson, sendJson } from "./http.ts";
import type { Logger } from "./log.ts";
import type { TextModel } from "./library.ts";
import { parseRecipe, parseRepo, repoOf, type HubName, type Recommended } from "./recommended.ts";
import type { Runtime } from "./runtime.ts";

export interface RecordEntry {
  path: string;
  size: number;
  sha256: string;
  verified: boolean;
  downloadedAt: string;
  source: string;
  repo: string | null;
  revision: string | null;
  url: string | null;
  card: { baseModel: string[]; baseModelRelation: string | null } | null;
}

const SOURCES = ["huggingface", "modelscope", "url"];

export class Downloads {
  private readonly url: string;
  private readonly runtime: Runtime;
  private readonly log: Logger;
  private watching: NodeJS.Timeout | null = null;
  private done = new Set<string>();
  active = 0;
  /** The paths being downloaded now (queued, downloading or verifying). */
  inFlight = new Set<string>();

  constructor(o: { url: string; runtime: Runtime; log: Logger }) {
    this.url = o.url;
    this.runtime = o.runtime;
    this.log = o.log;
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new HostError(503, "unavailable", "The download service isn't running.");
    }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new HostError(res.status, body?.error?.code ?? "unavailable", body?.error?.message ?? "The download service failed.");
    return body;
  }

  /** Reads the record and the downloads, rescanning when one has finished. */
  async refresh(): Promise<void> {
    const [{ files }, { downloads }] = await Promise.all([this.call("/record"), this.call("/downloads")]);
    this.runtime.record = new Map((files as RecordEntry[]).map((r) => [r.path, r]));
    const going = (downloads as { state: string; path: string }[]).filter((d) => ["queued", "downloading", "verifying"].includes(d.state));
    this.active = going.length;
    this.inFlight = new Set(going.map((d) => d.path));
    const finished = (downloads as { id: string; state: string }[]).filter((d) => d.state === "done" && !this.done.has(d.id));
    if (finished.length) {
      for (const d of finished) this.done.add(d.id);
      this.runtime.scan();
      // A model just downloaded gets its card's recommendations, from the repository it came from.
      for (const m of this.runtime.models) {
        if (m.kind !== "chat" || this.runtime.state.get().recommended[m.id]) continue;
        const r = this.downloadedFrom(m);
        if (r) void this.lookup(m, r.hub, r.repo, r.revision).catch(() => this.log("lookup failed", {}));
      }
    }
    if (this.active && !this.watching) {
      this.watching = setInterval(() => void this.refresh().catch(() => {}), 3000);
      this.watching.unref();
    } else if (!this.active && this.watching) {
      clearInterval(this.watching);
      this.watching = null;
    }
  }

  async start(): Promise<void> {
    await this.refresh().catch(() => this.log("fetch unavailable", {}));
    // Downloads finished before this start are already in the scan.
    const { downloads } = await this.call("/downloads").catch(() => ({ downloads: [] }));
    for (const d of downloads as { id: string; state: string }[]) if (d.state === "done") this.done.add(d.id);
  }

  close(): void {
    if (this.watching) clearInterval(this.watching);
  }

  list(source: string, repo: string | null, revision: string | undefined, token: string | undefined): Promise<any> {
    return this.call("/list", { body: { source, repo, revision, token } });
  }

  async request(request: Record<string, unknown>, token: string | undefined): Promise<{ downloads: unknown[] }> {
    const made = await this.call("/downloads", { body: { ...request, token: request.source === "url" ? undefined : token } });
    await this.refresh().catch(() => {});
    return made;
  }

  /** Deletes one downloaded file, unloading any model that uses it first. */
  async remove(file: string): Promise<{ deleted: string; unloaded: string[] }> {
    const unloaded: string[] = [];
    for (const m of this.runtime.models) {
      if ((m.id === file || m.mmproj === file || file.startsWith(`${m.id}/`)) && this.runtime.scheduler.placement(m.id)) {
        await this.runtime.scheduler.unloadNow(m.id);
        unloaded.push(m.id);
      }
    }
    const { deleted } = await this.call("/delete", { body: { path: file } });
    this.log("file deleted", { unloaded: unloaded.length });
    await this.refresh().catch(() => {});
    this.runtime.scan();
    return { deleted, unloaded };
  }

  /** The repository a downloaded model came from, by the download record. */
  private downloadedFrom(m: TextModel): { hub: HubName; repo: string; revision: string | undefined } | null {
    const entry = this.runtime.record.get(m.id) ?? [...this.runtime.record.values()].find((r) => r.path.startsWith(`${m.id}/`));
    if (!entry?.repo || (entry.source !== "huggingface" && entry.source !== "modelscope")) return null;
    return { hub: entry.source, repo: entry.repo, revision: entry.revision ?? undefined };
  }

  /** One small file through fetch, or null when the repository hasn't it. */
  private async read(hub: HubName, repo: string, revision: string | undefined, path: string, token?: string) {
    try {
      return (await this.call("/read", { body: { source: hub, repo, revision, path, token } })) as { revision: string; card: { baseModel: string[] } | null; text: string };
    } catch (e) {
      if (e instanceof HostError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Reads a repository's config.json and README.md for the model's
   * recommended context, following `base_model` one hop when the card says
   * nothing (a quantization's card), and keeps the result with the model.
   * Only a repository name and revision leave the host.
   */
  async lookup(m: TextModel, hub: HubName, repo: string, revision?: string, token?: string): Promise<Recommended> {
    const at = new Date().toISOString();
    const one = async (r: string, rev?: string) => {
      const [config, readme] = await Promise.all([this.read(hub, r, rev, "config.json", token), this.read(hub, r, rev, "README.md", token)]);
      let json: unknown = null;
      try {
        json = config ? JSON.parse(config.text) : null;
      } catch {}
      const listed = config ?? readme;
      if (!listed) throw new HostError(404, "not_found", `${repo} has no config.json or README.md to read.`);
      return { recipe: parseRecipe(json, readme?.text ?? null, m.server), revision: listed.revision, base: listed.card?.baseModel[0] };
    };
    const found = await one(repo, revision);
    let recipe = found.recipe;
    let source = { repo, revision: found.revision };
    const base = !recipe?.factor && found.base ? parseRepo(found.base) : null;
    if (base) {
      const b = await one(base.repo).catch(() => null);
      if (b?.recipe?.factor) {
        recipe = { ...b.recipe, native: recipe?.native ?? b.recipe.native };
        source = { repo: base.repo, revision: b.revision };
      }
    }
    const recommended: Recommended = { ...recipe, native: recipe?.native ?? m.contextLength, source: { hub, ...source, at } };
    this.runtime.state.update((s) => {
      s.recommended[m.id] = recommended;
    });
    this.log("looked up", { factor: recommended.factor ?? null });
    return recommended;
  }

  private token(req: IncomingMessage): string | undefined {
    const t = req.headers["x-hub-token"];
    return typeof t === "string" && t ? t : undefined;
  }

  async route(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
    const path = url.pathname;
    if (path === "/host/v1/hub/files" && method === "GET") {
      const source = url.searchParams.get("source");
      if (source !== "huggingface" && source !== "modelscope") throw invalid("source must be huggingface or modelscope.");
      sendJson(res, 200, await this.list(source, url.searchParams.get("repo"), url.searchParams.get("revision") ?? undefined, this.token(req)));
      return true;
    }
    if (path === "/host/v1/models/lookup" && method === "POST") {
      const body = await readJson(req);
      onlyFields(body, ["model", "repo"]);
      const m = this.runtime.find(body.model);
      if (m.kind !== "chat") throw invalid("Only chat models have a recommended context.");
      if (body.repo !== undefined && (typeof body.repo !== "string" || !parseRepo(body.repo))) throw invalid("repo is owner/name, modelscope:owner/name, or a link to the repository.");
      const named = typeof body.repo === "string" ? parseRepo(body.repo) : null;
      const from = named ? { ...named, revision: undefined } : this.downloadedFrom(m) ?? (repoOf(m) ? { ...repoOf(m)!, revision: undefined } : null);
      if (!from) throw new HostError(400, "need_repo", "The host doesn't know which repository this model came from. Name it.");
      // A token goes only to the hub it is for, which the caller names.
      const token = req.headers["x-hub"] === from.hub ? this.token(req) : undefined;
      await this.lookup(m, from.hub, from.repo, from.revision, token);
      sendJson(res, 200, this.runtime.servingEntry(m));
      return true;
    }
    if (path === "/host/v1/downloads" && method === "POST") {
      const body = await readJson(req);
      onlyFields(body, ["source", "repo", "revision", "files", "url", "sha256"]);
      if (!SOURCES.includes(body.source as string)) throw invalid("source must be huggingface, modelscope or url.");
      // A hub token is for that hub: never sent along with a link.
      sendJson(res, 202, await this.request(body, body.source === "url" ? undefined : this.token(req)));
      return true;
    }
    if (path === "/host/v1/downloads" && method === "GET") {
      sendJson(res, 200, await this.call("/downloads"));
      return true;
    }
    const one = path.match(/^\/host\/v1\/downloads\/([0-9a-f-]{36})$/);
    if (one && (method === "GET" || method === "DELETE")) {
      sendJson(res, 200, await this.call(`/downloads/${one[1]}`, { method }));
      if (method === "DELETE") await this.refresh().catch(() => {});
      return true;
    }
    if (path === "/host/v1/files" && method === "GET") {
      sendJson(res, 200, await this.call("/record"));
      return true;
    }
    if (path === "/host/v1/files" && method === "DELETE") {
      const file = url.searchParams.get("path");
      if (!file) throw invalid("path is missing.");
      // A request running on a model using it refuses the delete.
      sendJson(res, 200, await this.remove(file));
      return true;
    }
    return false;
  }
}
