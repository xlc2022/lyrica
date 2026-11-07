import http from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Downloads } from "../src/downloads.ts";
import { Downloader } from "../src/fetch/downloads.ts";
import { isPublic } from "../src/fetch/guard.ts";
import { huggingFace, modelScope } from "../src/fetch/hubs.ts";
import { Net } from "../src/fetch/net.ts";
import { fetchServer } from "../src/fetch/server.ts";
import { ggufBytes } from "../src/gguf.ts";
import { Runtime } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { FakeBackend, FakeGpus, TOKEN, fakeHub } from "./fakes.ts";
import { call, lyrica, pair, startHost } from "./helpers.ts";

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

async function stack(opts: Parameters<typeof fakeHub>[0] = {}) {
  const hub = await fakeHub(opts);
  // The hub serves a real GGUF header, so the scan finds a model.
  hub.files["model-Q4_K_M.gguf"] = Buffer.concat([ggufBytes({ "general.architecture": "llama", "general.basename": "Tiny", "tokenizer.ggml.model": "gpt2" }), Buffer.alloc(1000)]);
  open.push(hub);
  const models = mkdtempSync(join(tmpdir(), "lyrica-dl-models-"));
  const lines: string[] = [];
  const log = (event: string, fields?: object) => void lines.push(JSON.stringify({ event, ...fields }));
  const net = new Net({ allowed: (a) => a === "127.0.0.1" || a === "::1" || isPublic(a), ca: hub.ca });
  const downloader = new Downloader({
    models, data: mkdtempSync(join(tmpdir(), "lyrica-dl-data-")), net,
    hubs: { huggingface: huggingFace(net, hub.base), modelscope: modelScope(net, hub.base) }, log, free: () => 1e12,
  });
  let callers = ["127.0.0.1"];
  const fetchSrv = fetchServer(downloader, async (a) => callers.includes(a));
  await new Promise<void>((r) => fetchSrv.listen(0, "127.0.0.1", r));
  open.push({ close: () => new Promise((r) => { fetchSrv.closeAllConnections(); fetchSrv.close(r); }) });
  const fetchUrl = `http://127.0.0.1:${(fetchSrv.address() as AddressInfo).port}`;

  const h = await startHost({ log, modelsDir: models });
  open.push(h.host);
  const gpus = new FakeGpus([24]);
  const backend = new FakeBackend(gpus);
  const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp: backend, vllm: backend }, state: h.host.state, log });
  h.host.runtime = new Runtime({ scheduler, modelsDir: models, state: h.host.state, log });
  h.host.downloads = new Downloads({ url: fetchUrl, runtime: h.host.runtime, log });
  await h.host.downloads.start();
  await h.host.runtime.start();

  const code: string = await new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: h.local, path: "/dashboard/pairing", method: "POST", headers: { host: "127.0.0.1:7236" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d).code));
    });
    r.end();
  });
  const me = lyrica();
  const pinned = await pair(h.tls, me, code);
  const api = (path: string, init: { method?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}) =>
    call({ port: h.tls, path, identity: me, pinned, ...init });
  return { ...h, hub, models, lines, api, fetchUrl, backend, setCallers: (c: string[]) => (callers = c) };
}

/** Waits on the clock, not a count of tries, so a busy machine only makes it slower. */
async function finished(api: Awaited<ReturnType<typeof stack>>["api"]) {
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const { body } = await api("/host/v1/downloads");
    if (body.downloads.every((d: { state: string }) => !["queued", "downloading", "verifying"].includes(d.state))) return body.downloads;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("downloads didn't finish");
}

describe("downloads through host-api", () => {
  it("lists, downloads and offers the model at once, with the token kept out of logs and disk", async () => {
    const s = await stack({ gated: true });
    const listed = await s.api("/host/v1/hub/files?source=huggingface&repo=org/repo", { headers: { "x-hub-token": TOKEN } });
    expect(listed.status).toBe(200);
    expect(listed.body.files.map((f: { path: string; allowed: boolean }) => [f.path, f.allowed])).toContainEqual(["pytorch_model.bin", false]);

    const started = await s.api("/host/v1/downloads", { body: { source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf"] }, headers: { "x-hub-token": TOKEN } });
    expect(started.status).toBe(202);
    const [done] = await finished(s.api);
    expect(done).toMatchObject({ state: "done", verified: true, path: "lyrica/huggingface/org/repo/model-Q4_K_M.gguf" });
    expect(done.from).toBeUndefined();

    await s.host.downloads!.refresh();
    const { body } = await s.api("/host/v1/models");
    expect(body.models).toEqual([
      expect.objectContaining({ id: "lyrica/huggingface/org/repo/model-Q4_K_M.gguf", downloaded: true, identity: expect.objectContaining({ basename: "Tiny", card: { baseModel: ["org/base"], baseModelRelation: "quantized" } }) }),
    ]);
    expect(s.lines.join("\n")).not.toContain(TOKEN);
    for (const f of readdirSync(s.dataDir)) expect(readFileSync(join(s.dataDir, f), "latin1")).not.toContain(TOKEN);
  });

  it("refuses a pickle file and a link to the LAN", async () => {
    const s = await stack();
    const pickle = await s.api("/host/v1/downloads", { body: { source: "huggingface", repo: "org/repo", files: ["pytorch_model.bin"] } });
    expect(pickle.status).toBe(403);
    expect(pickle.body.error.code).toBe("refused");
    expect(pickle.body.error.message).toContain("Pickle files can run code");
    await s.api("/host/v1/downloads", { body: { source: "url", url: "https://192.168.1.20/model.gguf" } });
    const [lan] = await finished(s.api);
    expect(lan).toMatchObject({ state: "failed", error: "192.168.1.20 is a private or local address, which downloads may not use." });
  });

  it("unloads a loaded model before deleting its file, and refuses one in use", async () => {
    const s = await stack();
    await s.api("/host/v1/downloads", { body: { source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf"] } });
    await finished(s.api);
    await s.host.downloads!.refresh();
    const id = "lyrica/huggingface/org/repo/model-Q4_K_M.gguf";
    expect((await s.api("/host/v1/models/load", { body: { model: id } })).body.state).toBe("loaded");

    const model = s.host.runtime!.models[0]!;
    let release: (() => void) | undefined;
    const busy = s.host.runtime!.scheduler.run(model, "chat", () => new Promise<void>((r) => (release = r)));
    while (!release) await new Promise((r) => setTimeout(r, 10));
    const refused = await s.api(`/host/v1/files?path=${encodeURIComponent(id)}`, { method: "DELETE" });
    expect(refused.body.error.code).toBe("in_use");
    release();
    await busy;

    const deleted = await s.api(`/host/v1/files?path=${encodeURIComponent(id)}`, { method: "DELETE" });
    expect(deleted.body).toEqual({ deleted: id, unloaded: [id] });
    expect(s.backend.calls).toContain(`unload ${id}`);
    expect((await s.api("/host/v1/models")).body.models).toEqual([]);
    expect((await s.api("/host/v1/files")).body.files).toEqual([]);

    const outside = await s.api(`/host/v1/files?path=${encodeURIComponent("lyrica/../x.gguf")}`, { method: "DELETE" });
    expect(outside.body.error).toEqual({ code: "refused", message: "That path is outside the host's downloads." });
  });

  it("fills a downloaded model's recommended context from its base model's card, and looks up again on request", async () => {
    // The quantization's card says nothing; its base model's has the recipe. Both written for this test.
    const recipe = "```json\n{ \"rope_scaling\": { \"rope_type\": \"yarn\", \"factor\": 4.0, \"original_max_position_embeddings\": 32768 } }\n```\n```\nllama-server -c 131072 --yarn-orig-ctx 32768\n```\n";
    const s = await stack({ readme: "# A quantization of org/base\n", base: { config: JSON.stringify({ max_position_embeddings: 40960 }), readme: recipe } });
    await s.api("/host/v1/downloads", { body: { source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf"] } });
    await finished(s.api);
    await s.host.downloads!.refresh();
    const id = "lyrica/huggingface/org/repo/model-Q4_K_M.gguf";
    const settings = async () => (await s.api(`/host/v1/models/settings?model=${encodeURIComponent(id)}`)).body;
    for (const until = Date.now() + 20_000; Date.now() < until && !(await settings()).recommended; ) await new Promise((r) => setTimeout(r, 20));
    expect((await settings()).recommended).toMatchObject({ native: 32768, factor: 4, originalContext: 32768, stretched: 131072, source: { hub: "huggingface", repo: "org/base", revision: "def456" } });
    // Look up names the repository it reads, which needs no hint for a downloaded model.
    const again = await s.api("/host/v1/models/lookup", { body: { model: id } });
    expect(again.body.recommended.source.repo).toBe("org/base");
    // A repository that isn't a name is refused before anything leaves the host.
    expect((await s.api("/host/v1/models/lookup", { body: { model: id, repo: "../x" } })).body.error.code).toBe("invalid");
    expect(JSON.stringify(s.host.state.get())).not.toContain("llama-server");
  });

  it("asks for the repository when the host can't tell which one a model came from", async () => {
    const s = await stack();
    writeFileSync(join(s.models, "found.gguf"), ggufBytes({ "general.architecture": "llama", "tokenizer.ggml.model": "gpt2", "llama.context_length": 8192 }));
    await s.api("/host/v1/scan", { method: "POST" });
    const asked = await s.api("/host/v1/models/lookup", { body: { model: "found.gguf" } });
    expect(asked.body.error.code).toBe("need_repo");
  });

  it("takes an upload in pieces, carries on from what arrived, and offers the model once it's whole", async () => {
    const s = await stack();
    const file = Buffer.concat([ggufBytes({ "general.architecture": "llama", "general.basename": "Mine", "tokenizer.ggml.model": "gpt2" }), Buffer.alloc(3000, 7)]);
    const piece = (id: string, offset: number, bytes: Buffer) => s.api(`/host/v1/uploads/${id}?offset=${offset}`, { method: "PUT", raw: bytes, headers: { "content-type": "application/octet-stream" } });

    expect((await s.api("/host/v1/uploads", { body: { name: "model.bin", size: 10 } })).body.error.code).toBe("refused");
    expect((await s.api("/host/v1/uploads", { body: { name: "../x.gguf", size: 10 } })).body.error.code).toBe("invalid");
    const started = await s.api("/host/v1/uploads", { body: { name: "mine.gguf", size: file.length } });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ source: "upload", state: "uploading", path: "lyrica/upload/mine.gguf", size: file.length, received: 0 });
    const id = started.body.id;

    expect((await piece(id, 0, file.subarray(0, 1000))).body).toMatchObject({ state: "uploading", received: 1000 });
    // A piece from the wrong place is refused; starting again with the same name and size says where it stands.
    expect((await piece(id, 0, file.subarray(0, 1000))).body.error.code).toBe("in_use");
    expect((await s.api("/host/v1/uploads", { body: { name: "mine.gguf", size: file.length } })).body).toMatchObject({ id, received: 1000 });
    // Never past the file's size.
    expect((await piece(id, 1000, Buffer.alloc(file.length))).body.error.code).toBe("invalid");
    expect((await piece(id, 1000, file.subarray(1000))).status).toBe(200);
    const [done] = await finished(s.api);
    expect(done).toMatchObject({ id, state: "done", verified: false, size: file.length });

    await s.host.downloads!.refresh();
    expect((await s.api("/host/v1/models")).body.models).toEqual([expect.objectContaining({ id: "lyrica/upload/mine.gguf", downloaded: true })]);
    expect((await s.api("/host/v1/files")).body.files).toEqual([expect.objectContaining({ path: "lyrica/upload/mine.gguf", source: "upload", verified: false })]);
    expect((await s.api("/host/v1/uploads", { body: { name: "mine.gguf", size: file.length } })).body.error.message).toContain("already on this host");
    // It is deleted like any download.
    expect((await s.api(`/host/v1/files?path=${encodeURIComponent("lyrica/upload/mine.gguf")}`, { method: "DELETE" })).body.deleted).toBe("lyrica/upload/mine.gguf");
  });

  it("deletes an upload that isn't what its name says, and cancels one part way", async () => {
    const s = await stack();
    const fake = Buffer.alloc(500, 1);
    const bad = await s.api("/host/v1/uploads", { body: { name: "fake.gguf", size: fake.length } });
    await s.api(`/host/v1/uploads/${bad.body.id}?offset=0`, { method: "PUT", raw: fake, headers: { "content-type": "application/octet-stream" } });
    const [failed] = await finished(s.api);
    expect(failed).toMatchObject({ state: "failed", error: "The file isn't a valid model file, so it was deleted." });
    expect(readdirSync(join(s.models, "lyrica", "upload"))).toEqual([]);

    const half = await s.api("/host/v1/uploads", { body: { name: "half.safetensors", size: 1000 } });
    await s.api(`/host/v1/uploads/${half.body.id}?offset=0`, { method: "PUT", raw: Buffer.alloc(400), headers: { "content-type": "application/octet-stream" } });
    await s.api(`/host/v1/downloads/${half.body.id}`, { method: "DELETE" });
    expect((await s.api(`/host/v1/downloads/${half.body.id}`)).body.state).toBe("cancelled");
    expect(readdirSync(join(s.models, "lyrica", "upload"))).toEqual([]);
  });

  it("carries an upload on across a restart, and checks one whose last piece arrived before it", async () => {
    const models = mkdtempSync(join(tmpdir(), "lyrica-up-models-"));
    const data = mkdtempSync(join(tmpdir(), "lyrica-up-data-"));
    const net = new Net({ allowed: () => false });
    const make = () => new Downloader({ models, data, net, hubs: { huggingface: huggingFace(net, "https://x"), modelscope: modelScope(net, "https://x") }, log: () => {}, free: () => 1e12 });
    const file = Buffer.concat([ggufBytes({ "general.architecture": "llama", "tokenizer.ggml.model": "gpt2" }), Buffer.alloc(2000)]);
    const first = make();
    const half = first.startUpload({ name: "half.gguf", size: file.length });
    await first.receivePiece(half.id, 0, [file.subarray(0, 1000)]);
    const whole = first.startUpload({ name: "whole.gguf", size: file.length });
    await first.receivePiece(whole.id, 0, [file.subarray(0, 1000)]);
    // The stop came after the last piece was written, past the file's size, before anything else.
    const part = join(models, "lyrica", "upload", ".whole.gguf.lyrica-part");
    writeFileSync(part, Buffer.concat([file, Buffer.alloc(10)]));

    const again = make();
    expect(again.get(half.id)).toMatchObject({ state: "uploading", received: 1000 });
    await again.receivePiece(half.id, 1000, [file.subarray(1000)]);
    for (const until = Date.now() + 10_000; Date.now() < until && [half.id, whole.id].some((id) => again.get(id)!.state !== "done"); ) await new Promise((r) => setTimeout(r, 20));
    expect(again.get(half.id)).toMatchObject({ state: "done", received: file.length });
    expect(again.get(whole.id)).toMatchObject({ state: "done", received: file.length });
    expect(readFileSync(join(models, "lyrica", "upload", "whole.gguf")).equals(file)).toBe(true);
  });

  it("fetch answers only host-api", async () => {
    const s = await stack();
    s.setCallers(["10.9.9.9"]);
    await expect(fetch(`${s.fetchUrl}/record`)).rejects.toThrow();
  });
});
