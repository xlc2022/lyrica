import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterEach } from "vitest";
import { fingerprint, pairingProofs } from "../src/index.ts";
import { makeIdentity } from "../src/models/host.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))); });

export interface HostModel { id: string; kind?: "chat" | "embedding"; contextLength?: number; tools?: boolean; reasoning?: string[] | null; sha256?: string | null }

/**
 * A model host as host/PAIRING.md and host/API.md describe it, on 127.0.0.1:
 * TLS 1.3 asking for any client certificate, POST /pair/v1 with the pairing
 * proofs, pinned clients only everywhere else, /v1 (models and streaming
 * chat), /host/v1/models, status, pause and resume.
 */
export async function fakeHost(opts: { name?: string; models?: HostModel[]; port?: number } = {}) {
  let identity = makeIdentity(opts.name ?? "fake-host");
  let code: string | undefined;
  let tries = 0;
  let paused = false;
  let badProof = false;
  const pinned = new Map<string, string>();
  const chats: { model: string; reasoning_effort?: unknown; chat_template_kwargs?: unknown; client: string }[] = [];
  const models = opts.models ?? [{ id: "lyrica/huggingface/Qwen/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf", kind: "chat", contextLength: 32768, tools: true, reasoning: ["off", "on"], sha256: "ab".repeat(32) }];
  let requests = 0;

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
        return json(res, 200, { host: { name: opts.name ?? "fake-host", fingerprint: identity.fingerprint }, proof: badProof ? proofs.client : proofs.host });
      }
      if (!clientFp || !pinned.has(clientFp)) return json(res, 401, { error: { code: "unpaired", message: "This Lyrica server isn't paired with this host." } });
      if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, { object: "list", data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "lyrica-host" })) });
      if (req.method === "GET" && url.pathname === "/host/v1/models") {
        return json(res, 200, models.map((m) => ({
          id: m.id, kind: m.kind ?? "chat", server: "llamacpp", format: "gguf", size: 1, sha256: m.sha256 ?? null, downloaded: true, identity: null,
          capabilities: { tools: m.tools ?? false, vision: false, embedding: m.kind === "embedding", reasoning: m.reasoning ?? null },
          contextLength: m.contextLength ?? null, state: "unloaded", gpu: null, pinned: false, vram: null,
        })));
      }
      const status = () => ({ name: opts.name ?? "fake-host", version: "0.1.0", fingerprint: identity.fingerprint, state: paused ? "paused" : "running", gpus: [], downloads: { active: 0 }, modelsFolder: { path: "/srv/models", free: 1 } });
      if (req.method === "GET" && url.pathname === "/host/v1/status") return json(res, 200, status());
      if (req.method === "POST" && url.pathname === "/host/v1/pause") { paused = true; return json(res, 200, status()); }
      if (req.method === "POST" && url.pathname === "/host/v1/resume") { paused = false; return json(res, 200, status()); }
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
    get requests() { return requests; },
    chats,
    pinned,
    /** Shows a new pairing code on the "dashboard", as typed by a person. */
    newCode(): string {
      const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
      code = [...randomBytes(16)].map((b) => alphabet[b % 32]).join("");
      tries = 0;
      return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`.toLowerCase();
    },
    pause(on = true) { paused = on; },
    /** Answers pairing with the wrong proof, as a machine in the middle would. */
    lie() { badProof = true; },
    /** The same host on another port (it moved). */
    async move(): Promise<void> { await stop(); port = await listen(0); },
    /** Another machine, with another key, at the same address. */
    async replaceKey(): Promise<void> { await stop(); identity = makeIdentity("impostor"); port = await listen(port); },
    stop,
  };
}
