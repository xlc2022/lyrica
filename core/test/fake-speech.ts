import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))); });

/** What the fake heard: the model and language of a transcription (with the clip's size), or a spoken request's fields. */
export interface Heard { url: string; model?: string; language?: string; bytes?: number; input?: string; voice?: string; speed?: number; format?: string }

/**
 * A small OpenAI-compatible speech server on 127.0.0.1: GET /v1/models,
 * POST /v1/audio/transcriptions (multipart, answers `text`) and
 * POST /v1/audio/speech (streams PCM in two chunks, `gapMs` apart). It
 * records every request, and how many speech streams were cut off before
 * their end. `fail` makes every speech or transcription request answer
 * with that status and body instead.
 */
export async function fakeSpeech(opts: { models?: Record<string, unknown>[]; text?: string; gapMs?: number; label?: string } = {}) {
  const heard: Heard[] = [];
  let fail: { status: number; body?: unknown } | undefined;
  let cut = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: opts.models ?? [{ id: "whisper-large-v3-turbo" }, { id: "kokoro" }] }));
      }
      if (req.method !== "POST" || (req.url !== "/v1/audio/transcriptions" && req.url !== "/v1/audio/speech")) { res.writeHead(404); return res.end(); }
      if (fail) {
        res.writeHead(fail.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(fail.body ?? { error: { message: "scripted failure" } }));
      }
      if (req.url === "/v1/audio/transcriptions") {
        const form = parseForm(body, String(req.headers["content-type"]));
        heard.push({ url: req.url, model: form.fields.model, language: form.fields.language, bytes: form.file?.length });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ text: ` ${opts.text ?? "hello from the fake"} ` }));
      }
      const spoken = JSON.parse(body.toString("utf8")) as { model: string; input: string; voice?: string; speed?: number; response_format?: string };
      heard.push({ url: req.url, model: spoken.model, input: spoken.input, voice: spoken.voice, speed: spoken.speed, format: spoken.response_format });
      res.writeHead(200, { "content-type": "audio/pcm" });
      let ended = false;
      res.on("close", () => { if (!ended) cut++; });
      // A tenth of a second of 24 kHz s16le audio per chunk.
      res.write(Buffer.alloc(4800, 1));
      await new Promise((r) => setTimeout(r, opts.gapMs ?? 5));
      if (res.destroyed) return;
      ended = true;
      res.end(Buffer.alloc(4800, 2));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    heard,
    /** Speech streams that were cut off before their end. */
    get cut() { return cut; },
    fail: (status: number, body?: unknown) => { fail = { status, body }; },
    heal: () => { fail = undefined; },
    stop: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

function parseForm(body: Buffer, type: string): { fields: Record<string, string>; file?: Buffer } {
  const boundary = /boundary=([^;]+)/.exec(type)?.[1];
  const fields: Record<string, string> = {};
  let file: Buffer | undefined;
  if (!boundary) return { fields };
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const at = part.indexOf("\r\n\r\n");
    if (at < 0) continue;
    const head = part.slice(0, at);
    const value = part.slice(at + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (!name) continue;
    if (name === "file") file = Buffer.from(value, "latin1"); else fields[name] = value;
  }
  return { fields, file };
}

/** A WAV clip of `seconds` of 16 kHz mono 16-bit silence. */
export function wav(seconds: number): Buffer {
  const data = Math.round(seconds * 16_000) * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24); b.writeUInt32LE(32_000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(data, 40);
  return b;
}
