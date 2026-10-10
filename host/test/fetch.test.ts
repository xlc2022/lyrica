import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Downloader } from "../src/fetch/downloads.ts";
import { isPublic } from "../src/fetch/guard.ts";
import { huggingFace, modelScope } from "../src/fetch/hubs.ts";
import { Net } from "../src/fetch/net.ts";
import { TOKEN, fakeHub as makeHub, sha256 } from "./fakes.ts";

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

async function fakeHub(opts?: Parameters<typeof makeHub>[0]) {
  const hub = await makeHub(opts);
  open.push(hub);
  return hub;
}


function setup(hub: { base: string; ca: string }, free = 100 * 1024 ** 3) {
  const models = mkdtempSync(join(tmpdir(), "lyrica-fetch-models-"));
  const data = mkdtempSync(join(tmpdir(), "lyrica-fetch-data-"));
  const lines: string[] = [];
  // The fake hub is on loopback; everything else follows the real rule.
  const net = new Net({ allowed: (a) => a === "127.0.0.1" || a === "::1" || isPublic(a), ca: hub.ca });
  const make = () =>
    new Downloader({ models, data, net, hubs: { huggingface: huggingFace(net, hub.base), modelscope: modelScope(net, hub.base) }, log: (e, f) => void lines.push(JSON.stringify({ e, ...f })), free: () => free });
  return { models, data, lines, make, d: make() };
}

async function settle(d: Downloader) {
  for (let i = 0; i < 200 && d.list().some((x) => ["queued", "downloading", "verifying"].includes(x.state)); i++) await new Promise((r) => setTimeout(r, 20));
}

/** Every file under a folder, with its contents. */
function everything(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "latin1"))
    .join("\n");
}

describe("addresses", () => {
  it("refuses this machine, the LAN, the tailnet and other private ranges", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.10", "169.254.169.254", "100.100.1.1", "0.0.0.0", "::1", "fe80::1", "fd7a:115c:a1e0::1", "::ffff:192.168.1.1", "::ffff:c0a8:101", "224.0.0.1"]) {
      expect(isPublic(a), a).toBe(false);
    }
    for (const a of ["1.1.1.1", "18.164.0.1", "2606:4700::1111"]) expect(isPublic(a), a).toBe(true);
  });
});

describe("connections", () => {
  it("refuses a name that resolves to a private address", async () => {
    const hub = await fakeHub();
    const net = new Net({ ca: hub.ca }); // the real rule: localhost is refused
    await expect(net.get({ url: `${hub.base}/api/models/org/repo/revision/main` })).rejects.toThrow("localhost is a private or local address");
    expect(hub.seen).toEqual([]);
  });
});

describe("downloads", () => {
  it("lists a repository, marking pickle files refused", async () => {
    const hub = await fakeHub();
    const { d } = setup(hub);
    const listing = await d.listRepo("huggingface", "org/repo", undefined);
    expect(listing.revision).toBe("abc123");
    expect(listing.card).toEqual({ baseModel: ["org/base"], baseModelRelation: "quantized" });
    expect(listing.files.find((f) => f.path === "pytorch_model.bin")).toMatchObject({ allowed: false, reason: "Pickle files can run code when loaded." });
    expect(listing.files.find((f) => f.path === "model-Q4_K_M.gguf")).toMatchObject({ allowed: true, present: false, fits: true });
  });

  it("refuses a pickle file", async () => {
    const hub = await fakeHub();
    const { d } = setup(hub);
    await expect(d.request({ source: "huggingface", repo: "org/repo", files: ["pytorch_model.bin"] })).rejects.toThrow("Pickle files can run code");
    await expect(d.request({ source: "url", url: "https://example.com/model.ckpt" })).rejects.toThrow("Pickle");
  });

  it("downloads, checks the checksum, then records the file", async () => {
    const hub = await fakeHub();
    const { d, models } = setup(hub);
    const [gguf, config] = await d.request({ source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf", "config.json"] });
    await settle(d);
    expect(d.get(gguf!.id)).toMatchObject({ state: "done", verified: true, received: 300_000 });
    expect(d.get(config!.id)).toMatchObject({ state: "done", verified: true });
    expect(readFileSync(join(models, "lyrica/huggingface/org/repo/model-Q4_K_M.gguf"))).toEqual(hub.files["model-Q4_K_M.gguf"]);
    expect(d.record().map((r) => [r.path, r.sha256, r.verified])).toEqual([
      ["lyrica/huggingface/org/repo/model-Q4_K_M.gguf", sha256(hub.files["model-Q4_K_M.gguf"]!), true],
      ["lyrica/huggingface/org/repo/config.json", sha256(hub.files["config.json"]!), true],
    ]);
    expect(d.record()[0]!.card).toEqual({ baseModel: ["org/base"], baseModelRelation: "quantized" });
  });

  it("leaves nothing behind when the checksum is wrong", async () => {
    const hub = await fakeHub({ lie: true });
    const { d, models } = setup(hub);
    const [x] = await d.request({ source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf"] });
    await settle(d);
    expect(d.get(x!.id)).toMatchObject({ state: "failed", error: "The file's checksum doesn't match the hub's, so it was deleted." });
    expect(readdirSync(join(models, "lyrica/huggingface/org/repo"))).toEqual([]);
    expect(d.record()).toEqual([]);
  });

  it("refuses a link to a LAN address, and a redirect to one", async () => {
    const lan = await fakeHub();
    const direct = setup(lan);
    const [a] = await direct.d.request({ source: "url", url: "https://192.168.1.10/model.gguf" });
    await settle(direct.d);
    expect(direct.d.get(a!.id)).toMatchObject({ state: "failed", error: "192.168.1.10 is a private or local address, which downloads may not use." });
    await expect(direct.d.request({ source: "url", url: "http://example.com/model.gguf" })).rejects.toThrow("Only https");

    const hub = await fakeHub({ redirectTo: "https://10.0.0.7/model.gguf" });
    const { d, models } = setup(hub);
    const [b] = await d.request({ source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf"] });
    await settle(d);
    expect(d.get(b!.id)).toMatchObject({ state: "failed", error: "10.0.0.7 is a private or local address, which downloads may not use." });
    expect(existsSync(join(models, "lyrica/huggingface/org/repo/model-Q4_K_M.gguf"))).toBe(false);
  });

  it("uses a gated repository's token without writing it to disk or the log", async () => {
    const hub = await fakeHub({ gated: true });
    const { d, data, models, lines, make } = setup(hub);
    await expect(d.listRepo("huggingface", "org/repo", undefined)).rejects.toThrow("needs an access token");
    const [x] = await d.request({ source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf"] }, TOKEN);
    await settle(d);
    expect(d.get(x!.id)!.state).toBe("done");
    expect(hub.seen).toContain(`Bearer ${TOKEN}`);
    expect(everything(data)).not.toContain(TOKEN);
    expect(everything(models)).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain(TOKEN);
    // A gated download interrupted by a restart can't continue without the token.
    writeFileSync(join(data, "downloads.json"), JSON.stringify(d.list().map((y) => ({ ...y, id: "00000000-0000-0000-0000-000000000001", state: "downloading", path: "lyrica/huggingface/org/repo/again.gguf" }))));
    const again = make();
    again.start();
    await settle(again);
    expect(again.list()[0]).toMatchObject({ state: "failed", error: "Start this download again to give the token." });
  });

  it("resumes a partial file after a restart", async () => {
    const hub = await fakeHub();
    const { d, models, data, make } = setup(hub);
    const [x] = await d.request({ source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf"] });
    await settle(d);
    // Pretend it stopped at 100 kB: delete the result, keep a partial, mark it downloading.
    const dir = join(models, "lyrica/huggingface/org/repo");
    unlinkSync(join(dir, "model-Q4_K_M.gguf"));
    writeFileSync(join(dir, ".model-Q4_K_M.gguf.lyrica-part"), hub.files["model-Q4_K_M.gguf"]!.subarray(0, 100_000));
    writeFileSync(join(data, "record.json"), "[]");
    writeFileSync(join(data, "downloads.json"), JSON.stringify([{ ...d.get(x!.id), state: "downloading", received: 100_000, finishedAt: null }]));
    const again = make();
    again.start();
    await settle(again);
    expect(again.get(x!.id)).toMatchObject({ state: "done", verified: true, received: 300_000 });
    expect(readFileSync(join(dir, "model-Q4_K_M.gguf"))).toEqual(hub.files["model-Q4_K_M.gguf"]);
  });

  it("checks free space first", async () => {
    const hub = await fakeHub();
    const { d } = setup(hub, 1000);
    await expect(d.request({ source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf"] })).rejects.toThrow("enough free space");
  });

  it("cancels, deleting the partial file", async () => {
    const hub = await fakeHub();
    const { d, models } = setup(hub);
    const [x] = await d.request({ source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf"] });
    d.cancel(x!.id);
    await settle(d);
    expect(d.get(x!.id)!.state).toBe("cancelled");
    expect(readdirSync(join(models, "lyrica/huggingface/org/repo"))).toEqual([]);
  });
});

describe("deleting", () => {
  async function downloaded() {
    const hub = await fakeHub();
    const s = setup(hub);
    await s.d.request({ source: "huggingface", repo: "org/repo", files: ["model-Q4_K_M.gguf", "config.json"] });
    await settle(s.d);
    return s;
  }

  it("deletes a downloaded file that hasn't changed", async () => {
    const { d, models } = await downloaded();
    await d.remove("lyrica/huggingface/org/repo/config.json");
    expect(existsSync(join(models, "lyrica/huggingface/org/repo/config.json"))).toBe(false);
    expect(d.record().map((r) => r.path)).toEqual(["lyrica/huggingface/org/repo/model-Q4_K_M.gguf"]);
  });

  it("refuses paths outside lyrica/, through .. or a symlink", async () => {
    const { d, models } = await downloaded();
    writeFileSync(join(models, "lmstudio.gguf"), "theirs");
    await expect(d.remove("lmstudio.gguf")).rejects.toThrow("outside the host's downloads");
    await expect(d.remove("lyrica/../lmstudio.gguf")).rejects.toThrow("outside the host's downloads");
    mkdirSync(join(models, "elsewhere"));
    writeFileSync(join(models, "elsewhere/model-Q4_K_M.gguf"), "theirs");
    symlinkSync(join(models, "elsewhere"), join(models, "lyrica/linked"));
    await expect(d.remove("lyrica/linked/model-Q4_K_M.gguf")).rejects.toThrow("outside the host's downloads");
    expect(readFileSync(join(models, "elsewhere/model-Q4_K_M.gguf"), "utf8")).toBe("theirs");
  });

  it("refuses a file put there by hand, and a downloaded file that changed", async () => {
    const { d, models } = await downloaded();
    writeFileSync(join(models, "lyrica/by-hand.gguf"), "mine");
    await expect(d.remove("lyrica/by-hand.gguf")).rejects.toThrow("Only files the host downloaded");
    const path = join(models, "lyrica/huggingface/org/repo/model-Q4_K_M.gguf");
    const changed = readFileSync(path);
    changed[10] = 99;
    writeFileSync(path, changed);
    await expect(d.remove("lyrica/huggingface/org/repo/model-Q4_K_M.gguf")).rejects.toThrow("changed since it was downloaded");
    expect(existsSync(path)).toBe(true);
  });
});
