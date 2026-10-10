import http from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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

async function stack(opts: { gated?: boolean } = {}) {
  const hub = await fakeHub(opts);
  // The hub serves a real GGUF header, so the scan finds a model.
  hub.files["model-Q4_K_M.gguf"] = Buffer.concat([ggufBytes({ "general.architecture": "llama", "general.basename": "Tiny", "tokenizer.ggml.model": "gpt2" }), Buffer.alloc(1000)]);
  open.push(hub);
  const models = mkdtempSync(join(tmpdir(), "lyrica-dl-models-"));
  const lines: string[] = [];
  const log = (event: string, fields?: object) => void lines.push(JSON.stringify({ event, ...fields }));
  const net = new Net({ allowed: (a) => a === "127.0.0.1" || isPublic(a), ca: hub.ca });
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
  const api = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    call({ port: h.tls, path, identity: me, pinned, ...init });
  return { ...h, hub, models, lines, api, fetchUrl, backend, setCallers: (c: string[]) => (callers = c) };
}

async function finished(api: Awaited<ReturnType<typeof stack>>["api"]) {
  for (let i = 0; i < 200; i++) {
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
    let release!: () => void;
    const busy = s.host.runtime!.scheduler.run(model, "chat", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 10));
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

  it("fetch answers only host-api", async () => {
    const s = await stack();
    s.setCallers(["10.9.9.9"]);
    await expect(fetch(`${s.fetchUrl}/record`)).rejects.toThrow();
  });
});
