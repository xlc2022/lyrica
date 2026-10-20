import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterEach } from "vitest";
import { fingerprint, pairingProofs } from "../src/index.ts";
import { makeIdentity } from "../src/models/host.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))); });

export interface HostModel {
  id: string; kind?: "chat" | "embedding" | "transcribe" | "speak"; contextLength?: number; tools?: boolean; reasoning?: string[] | null; opensThinking?: boolean; sha256?: string | null;
  downloaded?: boolean; identity?: Record<string, unknown> | null;
  /** The sampling its file recommends. */
  sampling?: Record<string, number>;
  /** A speak model's voices. */
  voices?: { id: string; language: string }[];
}
export interface Recipe { id: string; name: string; state: "proposed" | "confirmed" | "ignored"; does: string[]; parts: { role: string; file: string | null; missing?: { source: string; repo: string; path: string } }[] }

/**
 * A model host as host/PAIRING.md and host/API.md describe it, on 127.0.0.1:
 * TLS 1.3 asking for any client certificate, POST /pair/v1 with the pairing
 * proofs, pinned clients only everywhere else, /v1 (models and streaming
 * chat), /host/v1/models, status, pause and resume.
 */
export async function fakeHost(opts: { name?: string; models?: HostModel[]; port?: number; identity?: ReturnType<typeof makeIdentity> } = {}) {
  let identity = opts.identity ?? makeIdentity(opts.name ?? "fake-host");
  let code: string | undefined;
  let tries = 0;
  let paused = false;
  const updates: string[] = [];
  let badProof = false;
  let lieAboutKey = false;
  const pinned = new Map<string, string>();
  const chats: { model: string; reasoning_effort?: unknown; chat_template_kwargs?: unknown; client: string }[] = [];
  const recipes: Recipe[] = [];
  const served = new Map<string, unknown>();
  const parts: { file: string; role: string; downloaded: boolean }[] = [];
  const tokens: (string | undefined)[] = [];
  /** The starter recipes it ships, as host/API.md lists them. */
  const starters: { id: string; name: string; template: string; parts: { role: string; source: string; repo: string; path: string; sha256: string; size?: number; present: boolean }[]; loras: []; defaults: Record<string, number> }[] = [];
  const lookups: { model: string; repo?: string; hub?: string; token?: string }[] = [];
  const downloads: { id: string; path: string; state: string }[] = [];
  /** More files in the download record (a split model's other shards), and files a running request holds. */
  const record: string[] = [];
  const busy = new Set<string>();
  const models: HostModel[] = opts.models ?? [{ id: "lyrica/huggingface/Qwen/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf", kind: "chat", contextLength: 32768, tools: true, reasoning: ["off", "on"], opensThinking: true, sha256: "ab".repeat(32), sampling: { temperature: 0.7, topP: 0.8, topK: 20 } }];
  let requests = 0;
  /** Speech requests, by path; while `speechDown`, the speech server is off and they answer with that code. */
  const speech: string[] = [];
  let speechDown: string | false = false;

  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    requests++;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const peer = (req.socket as TLSSocket).getPeerX509Certificate?.();
      const clientFp = peer ? fingerprint(peer) : undefined;
      const url = new URL(req.url ?? "/", "https://host");
      if (req.method === "POST" && url.pathname === "/pair/v1") {
        if (!clientFp) return json(res, 400, { error: { code: "client_certificate_required", message: "A client certificate is required." } });
        if (!code) return json(res, 403, { error: { code: "no_code", message: "There is no pairing code." } });
        const body = JSON.parse(raw) as { name: string; clientNonce: string; proof: string };
        const proofs = pairingProofs(code, identity.fingerprint, clientFp, body.clientNonce);
        const a = Buffer.from(proofs.client);
        const b = Buffer.from(String(body.proof));
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          if (++tries >= 5) code = undefined;
          return json(res, 403, { error: { code: "pairing_failed", message: "Pairing failed." } });
        }
        pinned.set(clientFp, body.name);
        code = undefined;
        return json(res, 200, { host: { name: opts.name ?? "fake-host", fingerprint: lieAboutKey ? "0".repeat(64) : identity.fingerprint }, proof: badProof ? proofs.client : proofs.host });
      }
      if (!clientFp || !pinned.has(clientFp)) return json(res, 401, { error: { code: "unpaired", message: "This Lyrica server isn't paired with this host." } });
      if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, { object: "list", data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "lyrica-host" })) });
      // Lists come wrapped, as the real host sends them (host/src/runtime.ts, images.ts).
      if (req.method === "GET" && url.pathname === "/host/v1/models") {
        return json(res, 200, { models: models.map((m) => ({
          id: m.id, kind: m.kind ?? "chat", server: "llamacpp", format: "gguf", size: 1, sha256: m.sha256 ?? null, downloaded: m.downloaded ?? false, identity: m.identity ?? null,
          capabilities: {
            tools: m.tools ?? false, vision: false, embedding: m.kind === "embedding", reasoning: m.reasoning ?? null, ...(m.opensThinking ? { opensThinking: true } : {}),
            ...(m.kind === "transcribe" ? { transcribe: true } : {}), ...(m.kind === "speak" ? { speak: { voices: m.voices ?? [] } } : {}),
          },
          contextLength: m.contextLength ?? null, parallel: m.kind === "chat" || !m.kind ? 1 : null, sampling: m.sampling ?? null, state: "unloaded", gpu: null, pinned: false, vram: null,
        })) });
      }
      const status = () => ({
        name: opts.name ?? "fake-host", version: "0.1.0", fingerprint: identity.fingerprint, state: paused ? "paused" : "running", gpus: [], downloads: { active: 0 }, modelsFolder: { path: "/srv/models", free: 1 },
        update: { available: true, state: updates.length ? "requested" : "idle" },
      });
      if (req.method === "POST" && url.pathname === "/host/v1/update") { updates.push(JSON.parse(raw).tag); return json(res, 202, { update: status().update }); }
      if (req.method === "POST" && url.pathname === "/host/v1/models-folder") { updates.push(`models ${JSON.parse(raw).path}`); return json(res, 202, { update: status().update }); }
      if (req.method === "GET" && url.pathname === "/host/v1/status") return json(res, 200, status());
      if (req.method === "POST" && url.pathname === "/host/v1/pause") { paused = true; return json(res, 200, status()); }
      if (req.method === "POST" && url.pathname === "/host/v1/resume") { paused = false; return json(res, 200, status()); }
      // The download record: files the host downloaded.
      if (req.method === "GET" && url.pathname === "/host/v1/files") return json(res, 200, [...models.filter((m) => m.downloaded).map((m) => m.id), ...record].map((path) => ({ path, size: 1, sha256: "00", verified: true })));
      if (req.method === "DELETE" && url.pathname === "/host/v1/files") {
        const path = url.searchParams.get("path");
        if (busy.has(path!)) return json(res, 409, { error: { code: "in_use", message: "A request is running on this file." } });
        const i = models.findIndex((m) => m.id === path && m.downloaded);
        if (i < 0 && !record.includes(path!)) return json(res, 403, { error: { code: "refused", message: "Only files the host downloaded can be deleted." } });
        if (i >= 0) models.splice(i, 1); else record.splice(record.indexOf(path!), 1);
        return json(res, 200, { deleted: path, unloaded: [] });
      }
      if (req.method === "GET" && url.pathname === "/host/v1/hub/files") {
        tokens.push(req.headers["x-hub-token"] as string | undefined);
        return json(res, 200, { source: url.searchParams.get("source"), repo: url.searchParams.get("repo"), revision: "abc", gated: false, card: null, free: 100, files: [{ path: "m-Q4_K_M.gguf", size: 10, sha256: null, allowed: true, reason: null, present: false, fits: true }] });
      }
      if (req.method === "POST" && url.pathname === "/host/v1/downloads") {
        tokens.push(req.headers["x-hub-token"] as string | undefined);
        const body = JSON.parse(raw) as { repo: string; files: string[] };
        const made = body.files.map((f) => ({ id: randomBytes(4).toString("hex"), path: `lyrica/huggingface/${body.repo}/${f}`, state: "downloading" }));
        downloads.push(...made);
        return json(res, 202, { downloads: made });
      }
      if (req.method === "GET" && url.pathname === "/host/v1/downloads") return json(res, 200, downloads);
      if (req.method === "GET" && url.pathname === "/host/v1/starters") return json(res, 200, { starters });
      const install = /^\/host\/v1\/starters\/([\w.-]+)\/install$/.exec(url.pathname);
      if (install && req.method === "POST") {
        const st = starters.find((x) => x.id === install[1]);
        if (!st) return json(res, 404, { error: { code: "not_found", message: "No such starter." } });
        tokens.push(req.headers["x-hub-token"] as string | undefined);
        const made = st.parts.filter((p) => !p.present).map((p) => ({ id: randomBytes(4).toString("hex"), path: `lyrica/${p.source}/${p.repo}/${p.path}`, state: "downloading" }));
        downloads.push(...made);
        const recipe = { id: `starter-${st.id}`, name: st.name, state: "confirmed", does: ["create"], parts: [] } as unknown as Recipe;
        if (!recipes.some((r) => r.id === recipe.id)) recipes.push(recipe);
        return json(res, 200, { recipe, downloads: made });
      }
      if (req.method === "GET" && url.pathname === "/host/v1/recipes") {
        const state = url.searchParams.get("state");
        return json(res, 200, { recipes: recipes.filter((r) => !state || r.state === state) });
      }
      if (req.method === "GET" && url.pathname === "/host/v1/parts") return json(res, 200, { parts: parts.map((p) => ({ ...p, usedBy: recipes.filter((r) => r.parts.some((x) => x.file === p.file)).map((r) => r.id) })) });
      const recipe = /^\/host\/v1\/recipes\/([^/]+)(?:\/(confirm|ignore|download-parts))?$/.exec(url.pathname);
      if (recipe) {
        const r = recipes.find((x) => x.id === recipe[1]);
        if (!r) return json(res, 404, { error: { code: "not_found", message: "No such recipe." } });
        if (req.method === "GET" && !recipe[2]) return json(res, 200, r);
        if (req.method === "POST" && recipe[2] === "download-parts") {
          tokens.push(req.headers["x-hub-token"] as string | undefined);
          return json(res, 202, { downloads: [] });
        }
        if (req.method === "POST" && recipe[2]) { r.state = recipe[2] === "confirm" ? "confirmed" : "ignored"; return json(res, 200, r); }
        if (req.method === "DELETE") {
          recipes.splice(recipes.indexOf(r), 1);
          const deleted: string[] = [];
          const kept: { file: string; reason: string }[] = [];
          for (const p of r.parts) {
            if (!p.file) continue;
            const other = recipes.find((x) => x.parts.some((y) => y.file === p.file));
            if (other) kept.push({ file: p.file, reason: `Used by ${other.name}.` });
            else { deleted.push(p.file); parts.splice(parts.findIndex((x) => x.file === p.file), 1); }
          }
          return json(res, 200, { deleted, kept });
        }
      }
      if (req.method === "POST" && url.pathname === "/host/v1/models/lookup") {
        const { model, repo } = JSON.parse(raw) as { model: string; repo?: string };
        lookups.push({ model, repo, hub: req.headers["x-hub"] as string | undefined, token: req.headers["x-hub-token"] as string | undefined });
        if (!repo && model.startsWith("shared/")) return json(res, 400, { error: { code: "need_repo", message: "Name the repository." } });
        return json(res, 200, { model, settings: { placement: { mode: "auto" } }, contextLength: 32768, recommended: { native: 32768, factor: 4, originalContext: 32768, stretched: 131072, source: { hub: "huggingface", repo: repo ?? "Qwen/Qwen3-8B", revision: "r1", at: "2026-10-12T00:00:00Z" } } });
      }
      if (url.pathname === "/host/v1/models/settings") {
        const id = req.method === "GET" ? url.searchParams.get("model") : (JSON.parse(raw) as { model: string }).model;
        const m = models.find((x) => x.id === id);
        if (!m) return json(res, 404, { error: { code: "not_found", message: "No such model." } });
        if (req.method === "GET") return json(res, 200, { model: m.id, settings: served.get(m.id) ?? { placement: { mode: "auto" } }, contextLength: m.contextLength ?? 32768 });
        const { settings, anyway } = JSON.parse(raw) as { settings: { contextLength?: number; placement?: { gpus?: number[] }; stretch?: { factor: number } }; anyway?: boolean };
        if ((settings.stretch?.factor ?? 0) > 4 && !anyway) return json(res, 409, { error: { code: "above_recommended", message: "Qwen documents 4." } });
        if (settings.placement?.gpus?.includes(2)) return json(res, 400, { error: { code: "invalid", message: "GPU 2 doesn't allow vLLM." } });
        served.set(m.id, settings);
        if (settings.contextLength) m.contextLength = settings.contextLength;
        return json(res, 200, { id: m.id, contextLength: m.contextLength });
      }
      if (req.method === "POST" && /^\/host\/v1\/models\/(load|unload|pin|reload)$/.test(url.pathname)) return json(res, 200, { ok: true, body: JSON.parse(raw || "{}") });
      if (req.method === "POST" && (url.pathname === "/v1/audio/speech" || url.pathname === "/v1/audio/transcriptions")) {
        speech.push(url.pathname);
        if (paused) return json(res, 503, { error: { code: "paused", message: "The host is paused." } });
        if (speechDown) return json(res, 503, { error: { code: speechDown, message: "The speech server isn't running." } });
        if (url.pathname === "/v1/audio/transcriptions") return json(res, 200, { text: "heard on the host" });
        res.writeHead(200, { "content-type": "audio/pcm" });
        return res.end(Buffer.alloc(4800));
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        if (paused) return json(res, 503, { error: { code: "paused", message: "The model host is paused." } });
        const chat = JSON.parse(raw) as { model: string; reasoning_effort?: unknown; chat_template_kwargs?: unknown };
        chats.push({ model: chat.model, reasoning_effort: chat.reasoning_effort, chat_template_kwargs: chat.chat_template_kwargs, client: clientFp });
        const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: chat.model };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `ok from ${opts.name ?? "fake-host"}` }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        send({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        return res.end("data: [DONE]\n\n");
      }
      json(res, 404, { error: { code: "not_found", message: "Not found." } });
    });
  };

  let server!: Server;
  const listen = async (port: number) => {
    server = createServer({ key: identity.key, cert: identity.cert, minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: false }, handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  };
  const stop = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  let port = await listen(opts.port ?? 0);

  return {
    get address() { return `127.0.0.1:${port}`; },
    get fingerprint() { return identity.fingerprint; },
    get identity() { return identity; },
    /** Names another key in its pairing answer: Lyrica pins the key it saw, not the one it is told. */
    lieAboutKey() { lieAboutKey = true; },
    get requests() { return requests; },
    chats,
    pinned,
    models,
    recipes,
    parts,
    tokens,
    starters,
    lookups,
    downloads,
    record,
    busy,
    /** Shows a new pairing code on the "dashboard", as typed by a person. */
    newCode(): string {
      const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
      code = [...randomBytes(16)].map((b) => alphabet[b % 32]).join("");
      tries = 0;
      return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`.toLowerCase();
    },
    pause(on = true) { paused = on; },
    /** The update tags Lyrica asked for. */
    updates,
    speech,
    /** The speech server is off: requests answer `code` (model_unavailable, or unavailable for an older host). */
    speechOff(code: string | false = "model_unavailable") { speechDown = code; },
    /** Answers pairing with the wrong proof, as a machine in the middle would. */
    lie() { badProof = true; },
    /** The same host on another port (it moved). */
    async move(): Promise<void> { await stop(); port = await listen(0); },
    /** Another machine, with another key, at the same address. */
    async replaceKey(): Promise<void> { await stop(); identity = makeIdentity("impostor"); port = await listen(port); },
    stop,
  };
}
