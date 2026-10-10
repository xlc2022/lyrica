// host-api's side of downloads: it asks the fetch service, which alone has
// a route out and write access to lyrica/. A hub token passes through, used
// for that request only, and is never logged or kept.
import type { IncomingMessage, ServerResponse } from "node:http";
import { HostError, invalid, onlyFields, readJson, sendJson } from "./http.ts";
import type { Logger } from "./log.ts";
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
    this.active = (downloads as { state: string }[]).filter((d) => ["queued", "downloading", "verifying"].includes(d.state)).length;
    const finished = (downloads as { id: string; state: string }[]).filter((d) => d.state === "done" && !this.done.has(d.id));
    if (finished.length) {
      for (const d of finished) this.done.add(d.id);
      this.runtime.scan();
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

  private token(req: IncomingMessage): string | undefined {
    const t = req.headers["x-hub-token"];
    return typeof t === "string" && t ? t : undefined;
  }

  async route(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
    const path = url.pathname;
    if (path === "/host/v1/hub/files" && method === "GET") {
      const source = url.searchParams.get("source");
      if (source !== "huggingface" && source !== "modelscope") throw invalid("source must be huggingface or modelscope.");
      const listing = await this.call("/list", {
        body: { source, repo: url.searchParams.get("repo"), revision: url.searchParams.get("revision") ?? undefined, token: this.token(req) },
      });
      sendJson(res, 200, listing);
      return true;
    }
    if (path === "/host/v1/downloads" && method === "POST") {
      const body = await readJson(req);
      onlyFields(body, ["source", "repo", "revision", "files", "url", "sha256"]);
      if (!SOURCES.includes(body.source as string)) throw invalid("source must be huggingface, modelscope or url.");
      // A hub token is for that hub: never sent along with a link.
      const token = body.source === "url" ? undefined : this.token(req);
      const made = await this.call("/downloads", { body: { ...body, token } });
      await this.refresh().catch(() => {});
      sendJson(res, 202, made);
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
      // Unload whatever model uses this file first; a request running on it refuses the delete.
      const unloaded: string[] = [];
      for (const m of this.runtime.models) {
        if (m.id === file || m.mmproj === file || file.startsWith(`${m.id}/`)) {
          if (this.runtime.scheduler.placement(m.id)) {
            await this.runtime.scheduler.unloadNow(m.id);
            unloaded.push(m.id);
          }
        }
      }
      const { deleted } = await this.call("/delete", { body: { path: file } });
      this.log("file deleted", { unloaded: unloaded.length });
      await this.refresh().catch(() => {});
      this.runtime.scan();
      sendJson(res, 200, { deleted, unloaded });
      return true;
    }
    return false;
  }
}
