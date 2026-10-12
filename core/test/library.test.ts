import { describe, expect, it } from "vitest";
import { Forbidden, HostRefused, NoModel } from "../src/index.ts";
import { createServer } from "node:net";
import { copyIdentity } from "../src/models/library.ts";
import { fakeHost, type HostModel } from "./fake-host.ts";
import { profile, withModels } from "./helpers.ts";

const qwen = (file: string, identity: Record<string, unknown> | null, extra: Partial<HostModel> = {}): HostModel =>
  ({ id: `lyrica/huggingface/Qwen/Qwen3-8B-GGUF/${file}`, kind: "chat", contextLength: 32768, tools: true, identity, ...extra });

async function setup() {
  const m = await withModels();
  const bob = await m.users.createUser("bob", "pw", profile("Bob"), { admin: false });
  await m.users.authenticate("bob", "pw");
  const big = await fakeHost({
    name: "blackwell", models: [
      qwen("Qwen3-8B-Q8_0.gguf", { basename: "Qwen3", sizeLabel: "8B", finetune: null }, { downloaded: true, sha256: "aa".repeat(32) }),
      qwen("Qwen3-8B-Abliterated-Q4_K_M.gguf", { basename: "Qwen3", sizeLabel: "8B", finetune: null }),
      qwen("Qwen3-8B-Coder-Q4_K_M.gguf", { basename: "Qwen3", sizeLabel: "8B", finetune: "Coder" }),
    ],
  });
  const small = await fakeHost({
    name: "3090", models: [
      qwen("Qwen3-8B-Q4_K_M.gguf", { basename: "Qwen3", sizeLabel: "8B", finetune: null }),
      { id: "shared/lmstudio/odd-name.gguf", identity: { card: { baseModel: ["Qwen/Qwen3-8B"], baseModelRelation: "quantized" } } },
    ],
  });
  const pair = async (name: string, host: Awaited<ReturnType<typeof fakeHost>>) => {
    const ep = await m.models.pairHost(m.ada, { name, addresses: [host.address], code: host.newCode() }, { shared: true });
    await m.models.discover(m.ada, ep.id);
    return ep;
  };
  const bigEp = await pair("blackwell", big);
  const smallEp = await pair("gpu3090", small);
  const offering = (raw: string) => m.models.offerings(m.ada.id, [bigEp.id, smallEp.id].find((id) => m.models.offerings(m.ada.id, id).some((o) => o.modelId.endsWith(raw)))!).find((o) => o.modelId.endsWith(raw))!;
  return { ...m, bob, big, small, bigEp, smallEp, offering };
}

describe("the text library", () => {
  it("lists one entry per model with its copies; only quantized copies join, derived models stand apart linked to their base", async () => {
    const s = await setup();
    const { entries } = s.models.textLibrary(s.ada.id, { search: "qwen3" });
    const base = entries.find((e) => e.name === "qwen3-8b")!;
    expect(base.copies.map((c) => c.rawName.split("/").at(-1)).sort()).toEqual(["Qwen3-8B-Q4_K_M.gguf", "Qwen3-8B-Q8_0.gguf", "odd-name.gguf"]);
    expect(base.copies.find((c) => c.rawName.endsWith("Q8_0.gguf"))).toMatchObject({ downloaded: true, endpointName: "blackwell", kind: "local" });
    const coder = entries.find((e) => e.name === "qwen3-8b-coder")!;
    expect(coder).toMatchObject({ base: { name: "qwen3-8b" } });
    // A finetune whose file records no finetune: never in its base's entry, flagged instead.
    const abl = entries.find((e) => e.name === "qwen3-8b-abliterated")!;
    expect(abl.copies[0]!.flagged).toMatch(/abliterated/);
    expect(abl.base).toEqual({ key: "name:qwen3-8b", name: "qwen3-8b" });
    // Nor is it suggested for the base's group.
    const suggestions = s.models.groupSuggestions(s.ada.id);
    const ablId = s.offering("Abliterated-Q4_K_M.gguf").id;
    expect(suggestions.some((x) => x.members.includes(ablId))).toBe(false);
    expect(suggestions.some((x) => x.members.includes(s.offering("Qwen3-8B-Q8_0.gguf").id) && x.members.includes(s.offering("Qwen3-8B-Q4_K_M.gguf").id))).toBe(true);
  });

  it("moves a copy out with Not this model (an administrator for a shared endpoint), and searches, filters, stars and pages", async () => {
    const s = await setup();
    const odd = s.offering("odd-name.gguf");
    expect(() => s.models.notThisModel(s.bob, odd.id)).toThrow(Forbidden);
    s.models.notThisModel(s.ada, odd.id);
    expect(s.models.textLibrary(s.ada.id).entries.find((e) => e.name === "qwen3-8b")!.copies).toHaveLength(2);
    expect(s.models.textLibrary(s.ada.id, { search: "odd-name" }).entries).toHaveLength(1);
    expect(s.models.textLibrary(s.ada.id, { kind: "cloud" }).entries.map((e) => e.name)).toEqual(["deepseek-4.1-flash"]);
    expect(s.models.textLibrary(s.ada.id, { endpointId: s.smallEp.id }).total).toBe(2);
    expect(s.models.textLibrary(s.ada.id, { capability: "tools" }).entries.every((e) => e.copies.some((c) => c.capabilities.tools))).toBe(true);
    expect(s.models.textLibrary(s.ada.id, { groupsOnly: true }).total).toBe(0);
    s.models.star(s.bob.id, s.offering("Coder-Q4_K_M.gguf").id, true);
    expect(s.models.textLibrary(s.bob.id).entries[0]).toMatchObject({ name: "qwen3-8b-coder", starred: true });
    expect(s.models.textLibrary(s.ada.id).entries[0]!.starred).toBe(false);
    const page = s.models.textLibrary(s.ada.id, { offset: 2, limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.total).toBe(s.models.textLibrary(s.ada.id).total);
  });
});

describe("a copy's identity", () => {
  it("keeps a base model apart from its instruct model, and takes the base a file names", () => {
    const qwen3 = { basename: "Qwen3", sizeLabel: "8B", finetune: null };
    expect(copyIdentity({ id: "a", modelId: "Qwen3-8B-Instruct-Q4_K_M.gguf", identity: qwen3 })).toEqual({ key: "name:qwen3-8b", name: "qwen3-8b" });
    expect(copyIdentity({ id: "b", modelId: "Qwen3-8B-Base-Q4_K_M.gguf", identity: qwen3 })).toMatchObject({ key: "name:qwen3-8b-base", flagged: expect.stringMatching(/base/) });
    // GGUF base_model.*: a finetune links to the model it was made from.
    expect(copyIdentity({ id: "c", modelId: "Hermes-Q4.gguf", identity: { basename: "Hermes", sizeLabel: "8B", finetune: "Pro", baseModels: [{ name: "Llama 3.1 8B" }] } }))
      .toMatchObject({ key: "name:hermes-8b-pro", base: { name: "llama-3.1-8b" } });
  });
});

describe("hub tokens and downloads", () => {
  it("returns only a token's last four characters, and sends it with the requests that need it", async () => {
    const s = await setup();
    s.models.setHubToken(s.bob, "huggingface", "hf_bobsecrettoken1234");
    expect(() => s.models.setHubToken(s.bob, "huggingface", "hf_sharedtoken9999", { shared: true })).toThrow(Forbidden);
    s.models.setHubToken(s.ada, "modelscope", "ms_sharedtoken9999", { shared: true });
    expect(s.models.hubTokens(s.bob.id)).toEqual([{ hub: "huggingface", shared: false, last4: "1234" }, { hub: "modelscope", shared: true, last4: "9999" }]);
    expect(JSON.stringify(s.models.hubTokens(s.bob.id))).not.toContain("secret");
    // Shared hosts take downloads from administrators only.
    await expect(s.models.hubFiles(s.bob, s.bigEp.id, { source: "huggingface", repo: "Qwen/Qwen3-8B-GGUF" })).rejects.toThrow(Forbidden);
    s.models.setHubToken(s.ada, "huggingface", "hf_lisecrettoken5678");
    await s.models.hubFiles(s.ada, s.bigEp.id, { source: "huggingface", repo: "Qwen/Qwen3-8B-GGUF" });
    await s.models.startDownload(s.ada, s.bigEp.id, { source: "huggingface", repo: "Qwen/Qwen3-14B-GGUF", files: ["Qwen3-14B-Q4_K_M.gguf"] });
    expect(s.big.tokens).toEqual(["hf_lisecrettoken5678", "hf_lisecrettoken5678"]);
    // A finished download is read as a new offering at once.
    const d = s.big.downloads[0]!;
    d.state = "done";
    s.big.models.push({ id: d.path, kind: "chat", downloaded: true, identity: { basename: "Qwen3", sizeLabel: "14B", finetune: null } });
    await s.models.downloads(s.ada, s.bigEp.id);
    expect(s.models.offerings(s.ada.id, s.bigEp.id).some((o) => o.modelId === d.path)).toBe(true);
  });

  it("refuses a download the host would refuse, and sends the token for a recipe's missing parts", async () => {
    const s = await setup();
    const start = (body: unknown) => s.models.startDownload(s.ada, s.bigEp.id, body as never);
    await expect(start(null)).rejects.toThrow(/send/);
    await expect(start({ source: "github", repo: "x", files: ["a"] })).rejects.toThrow(/source/);
    await expect(start({ source: "url", url: "http://example.com/m.gguf" })).rejects.toThrow(/https/);
    await expect(start({ source: "url", url: `https://example.com/${"a".repeat(1024)}.gguf` })).rejects.toThrow(/1024/);
    await expect(start({ source: "url", url: "https://me:pw@example.com/m.gguf" })).rejects.toThrow(/user name/);
    await expect(start({ source: "huggingface", repo: "Qwen/Qwen3-8B-GGUF", files: [] })).rejects.toThrow(/files/);
    expect(s.big.downloads).toHaveLength(0);
    // Filling a recipe's missing parts from a gated repository needs the token: the user's own, else the shared one.
    s.big.recipes.push({ id: "r9", name: "Z", state: "confirmed", does: ["create"], parts: [{ role: "vae", file: null, missing: { source: "huggingface", repo: "Comfy-Org/z", path: "vae/ae.safetensors" } }] });
    s.models.setHubToken(s.ada, "huggingface", "hf_sharedtoken9999", { shared: true });
    await s.models.recipe(s.ada, s.bigEp.id, "r9", { do: "download-parts" });
    s.models.setHubToken(s.ada, "huggingface", "hf_lisecrettoken5678");
    await s.models.recipe(s.ada, s.bigEp.id, "r9", { do: "download-parts" });
    expect(s.big.tokens).toEqual(["hf_sharedtoken9999", "hf_lisecrettoken5678"]);
  });

  it("deletes every shard of a split copy, and says what's left when one is in use", async () => {
    const s = await setup();
    const shard = (n: number) => `lyrica/huggingface/Qwen/Qwen3-32B-GGUF/Qwen3-32B-Q4_K_M-0000${n}-of-00003.gguf`;
    s.big.models.push({ id: shard(1), kind: "chat", downloaded: true, identity: { basename: "Qwen3", sizeLabel: "32B", finetune: null } });
    s.big.record.push(shard(2), shard(3), "lyrica/huggingface/Qwen/Qwen3-32B-GGUF/Qwen3-32B-Q8_0-00002-of-00003.gguf");
    await s.models.discover(s.ada, s.bigEp.id);
    const split = s.offering("Qwen3-32B-Q4_K_M-00001-of-00003.gguf");
    expect((await s.models.deleteCopy(s.ada, split.id, { confirm: true })).deleted).toEqual([shard(1), shard(2), shard(3)]);
    expect(s.big.record).toEqual(["lyrica/huggingface/Qwen/Qwen3-32B-GGUF/Qwen3-32B-Q8_0-00002-of-00003.gguf"]);
    // Another, with its last shard held by a running request: what went is gone, the copy leaves every list, and what's left is named.
    const other = (n: number) => `lyrica/huggingface/Qwen/Qwen3-14B-GGUF/Qwen3-14B-Q4_K_M-0000${n}-of-00002.gguf`;
    s.big.models.push({ id: other(1), kind: "chat", downloaded: true, identity: { basename: "Qwen3", sizeLabel: "14B", finetune: null } });
    s.big.record.push(other(2));
    s.big.busy.add(other(2));
    await s.models.discover(s.ada, s.bigEp.id);
    const held = s.offering("Qwen3-14B-Q4_K_M-00001-of-00002.gguf");
    expect(await s.models.deleteCopy(s.ada, held.id, { confirm: true })).toMatchObject({ deleted: [other(1)], left: { files: [other(2)], reason: "A request is running on this file." } });
    expect(s.models.offerings(s.ada.id, s.bigEp.id).some((o) => o.id === held.id)).toBe(false);
  });

  it("deletes only a copy Lyrica downloaded, says where it's used first, and leaves every list working", async () => {
    const s = await setup();
    const q8 = s.offering("Qwen3-8B-Q8_0.gguf");
    const q4 = s.offering("Qwen3-8B-Q4_K_M.gguf");
    s.models.setProfile(s.ada.id, "local", "chat", [{ offeringId: q8.id }, { offeringId: q4.id }]);
    await expect(s.models.deleteCopy(s.bob, q8.id, { confirm: true })).rejects.toThrow(Forbidden);
    expect(await s.models.deleteCopy(s.ada, q8.id)).toEqual({ usedIn: [{ where: "profile", profile: "local", task: "chat" }] });
    await expect(s.models.deleteCopy(s.ada, q4.id, { confirm: true })).rejects.toThrow(HostRefused);
    expect(s.small.models.some((m) => m.id === q4.modelId)).toBe(true);
    expect((await s.models.deleteCopy(s.ada, q8.id, { confirm: true })).deleted).toEqual([q8.modelId]);
    expect(s.big.models.some((m) => m.id === q8.modelId)).toBe(false);
    expect(s.models.resolveModel("chat", { userId: s.ada.id, pool: "private", localOnly: true })).toEqual({ offeringId: q4.id });
  });
});

describe("the image library", () => {
  it("never resolves a proposed recipe, offers a confirmed one, and keeps parts another recipe uses when one is deleted", async () => {
    const s = await setup();
    s.big.parts.push({ file: "vae/ae.safetensors", role: "vae", downloaded: true }, { file: "diffusion/z.safetensors", role: "diffusion", downloaded: true }, { file: "diffusion/z2.safetensors", role: "diffusion", downloaded: true });
    s.big.recipes.push(
      { id: "r1", name: "Z-Image Turbo", state: "proposed", does: ["create"], parts: [{ role: "diffusion", file: "diffusion/z.safetensors" }, { role: "vae", file: "vae/ae.safetensors" }] },
      { id: "r2", name: "Z-Image Other", state: "confirmed", does: ["create"], parts: [{ role: "diffusion", file: "diffusion/z2.safetensors" }, { role: "vae", file: "vae/ae.safetensors" }] },
    );
    await s.models.discover(s.ada, s.bigEp.id);
    const offered = () => s.models.offerings(s.ada.id, s.bigEp.id).filter((o) => o.recipe).map((o) => o.recipe);
    expect(offered()).toEqual(["Z-Image Other"]);
    const lib = await s.models.imageLibrary(s.bob.id, s.bigEp.id);
    expect(lib.recipes).toHaveLength(2);
    expect(Object.keys(lib.parts).sort()).toEqual(["diffusion", "vae"]);
    await expect(s.models.recipe(s.bob, s.bigEp.id, "r1", { do: "confirm" })).rejects.toThrow(Forbidden);
    await s.models.recipe(s.ada, s.bigEp.id, "r1", { do: "confirm" });
    expect(offered().sort()).toEqual(["Z-Image Other", "Z-Image Turbo"]);
    const turbo = s.models.offerings(s.ada.id, s.bigEp.id).find((o) => o.recipe === "Z-Image Turbo")!;
    s.models.setProfile(s.ada.id, "local", "image.create", [{ offeringId: turbo.id }]);
    expect(s.models.resolveModel("image.create", { userId: s.ada.id, pool: "private", localOnly: true })).toEqual({ offeringId: turbo.id });
    expect(await s.models.recipe(s.ada, s.bigEp.id, "r1", { do: "delete" })).toEqual({ deleted: ["diffusion/z.safetensors"], kept: [{ file: "vae/ae.safetensors", reason: "Used by Z-Image Other." }] });
    expect(() => s.models.resolveModel("image.create", { userId: s.ada.id, pool: "private", localOnly: true })).toThrow(NoModel);
  });
});

describe("serving settings", () => {
  it("reads and saves a host model's settings, plans by the context it serves, and passes on the host's refusal", async () => {
    const s = await setup();
    const q8 = s.offering("Qwen3-8B-Q8_0.gguf");
    s.models.setCapabilities(s.ada, q8.id, { contextWindow: 8192 });
    // The host's served context wins over one set by hand.
    expect(s.models.offering(s.ada.id, q8.id)!.offering.contextWindow).toBe(32768);
    expect(s.models.offeringSettings(s.ada.id, q8.id).contextWindow).toEqual({ value: 32768, source: "host" });
    expect(await s.models.servingSettings(s.bob.id, q8.id)).toEqual({ model: q8.modelId, settings: { placement: { mode: "auto" } }, contextLength: 32768 });
    await expect(s.models.setServingSettings(s.bob, q8.id, { contextLength: 16384 })).rejects.toThrow(Forbidden);
    await expect(s.models.setServingSettings(s.ada, q8.id, { placement: { mode: "gpus", gpus: [2] } })).rejects.toThrow("GPU 2 doesn't allow vLLM.");
    await s.models.setServingSettings(s.ada, q8.id, { placement: { mode: "auto" }, contextLength: 16384 });
    expect(s.models.offering(s.ada.id, q8.id)!.offering.contextWindow).toBe(16384);
    await expect(s.models.reloadModel(s.bob, q8.id)).rejects.toThrow(Forbidden);
    expect(await s.models.reloadModel(s.ada, q8.id)).toEqual({ ok: true, body: { model: q8.modelId } });
  });
});

describe("recommended settings and the models tool's reach", () => {
  it("looks up a card as an administrator, with the token for that hub only, and passes on need_repo and above_recommended", async () => {
    const s = await setup();
    const q8 = s.offering("Qwen3-8B-Q8_0.gguf");
    await expect(s.models.lookupRecommended(s.bob, q8.id)).rejects.toThrow(Forbidden);
    s.models.setHubToken(s.ada, "huggingface", "hf_lisecrettoken5678");
    expect((await s.models.lookupRecommended(s.ada, q8.id)).recommended).toMatchObject({ factor: 4, stretched: 131072 });
    await s.models.lookupRecommended(s.ada, q8.id, "modelscope:Qwen/Qwen3-8B");
    // The Hugging Face token goes with a Hugging Face lookup, and never with a ModelScope one.
    expect(s.big.lookups).toEqual([
      { model: q8.modelId, hub: "huggingface", token: "hf_lisecrettoken5678" },
      { model: q8.modelId, repo: "modelscope:Qwen/Qwen3-8B" },
    ]);
    const odd = s.offering("odd-name.gguf");
    await expect(s.models.lookupRecommended(s.ada, odd.id)).rejects.toMatchObject({ code: "need_repo" });
    await expect(s.models.setServingSettings(s.ada, q8.id, { placement: { mode: "auto" }, stretch: { type: "yarn", factor: 8 } })).rejects.toMatchObject({ code: "above_recommended" });
    await s.models.setServingSettings(s.ada, q8.id, { placement: { mode: "auto" }, stretch: { type: "yarn", factor: 8 } }, { anyway: true });
  });

  it("offers host chat models to manage in a general thread only, and only to who can manage the host", async () => {
    const s = await setup();
    const general = { userId: s.ada.id, pool: "general" as const, localOnly: false };
    expect(s.models.hostCopies(s.ada, general).map((c) => c.host)).toContain("blackwell");
    expect(s.models.hostCopies(s.ada, general).find((c) => c.offering === s.offering("Qwen3-8B-Q8_0.gguf").id)).toMatchObject({ name: "Qwen3", host: "blackwell" });
    // A lookup is an outside call: none in a private or local-only thread.
    expect(s.models.hostCopies(s.ada, { ...general, pool: "private" })).toEqual([]);
    expect(s.models.hostCopies(s.ada, { ...general, localOnly: true })).toEqual([]);
    // Shared hosts are an administrator's.
    expect(s.models.hostCopies(s.bob, { ...general, userId: s.bob.id })).toEqual([]);
  });
});

describe("host management", () => {
  it("passes on only host management paths, and only an administrator manages a shared host", async () => {
    const s = await setup();
    expect(await s.models.manageHost(s.ada, s.bigEp.id, "POST", "/host/v1/models/load", { model: "x" })).toEqual({ ok: true, body: { model: "x" } });
    expect(await s.models.manageHost(s.ada, s.bigEp.id, "POST", "/host/v1/models/pin", { model: "x", pinned: true })).toEqual({ ok: true, body: { model: "x", pinned: true } });
    await expect(s.models.manageHost(s.ada, s.bigEp.id, "PUT", "/host/v1/placements/x", {})).rejects.toThrow(/isn't host management/);
    await expect(s.models.manageHost(s.ada, s.bigEp.id, "POST", "/pair/v1", {})).rejects.toThrow(/isn't host management/);
    await expect(s.models.manageHost(s.ada, s.bigEp.id, "GET", "/host/v1/files")).rejects.toThrow(/isn't host management/);
    await expect(s.models.manageHost(s.bob, s.bigEp.id, "POST", "/host/v1/models/unload", { model: "x" })).rejects.toThrow(Forbidden);
    // Serving settings go through setServingSettings, which reads the model again.
    await expect(s.models.manageHost(s.ada, s.bigEp.id, "PUT", "/host/v1/models/settings", {})).rejects.toThrow(/isn't host management/);
    expect(() => s.models.hostDashboard(s.bob, s.bigEp.id)).toThrow(Forbidden);
  });

  it("links the dashboard at the address the host last answered on", async () => {
    const s = await setup();
    const closed = await new Promise<number>((r) => { const srv = createServer().listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => r(p)); }); });
    s.models.setHostAddresses(s.ada, s.bigEp.id, [`127.0.0.1:${closed}`, s.big.address]);
    await s.models.hostStatus(s.ada.id, s.bigEp.id);
    expect(s.models.hostDashboard(s.ada, s.bigEp.id)).toBe(`https://${s.big.address}/`);
  });

  it("gives the Models page an answer within its budget when a host is off, and doesn't ask again while it's down", async () => {
    const s = await setup();
    // A machine that takes the connection and never answers, like a workstation booted into another system.
    const sockets: import("node:net").Socket[] = [];
    const silent = createServer((c) => sockets.push(c));
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    try {
      s.models.setHostAddresses(s.ada, s.bigEp.id, [`127.0.0.1:${(silent.address() as { port: number }).port}`]);
      let t = Date.now();
      expect(await s.models.pageStatus(s.ada.id, s.bigEp.id, 500)).toMatchObject({ state: "down" });
      expect(Date.now() - t).toBeLessThan(1500);
      t = Date.now();
      expect(await s.models.pageStatus(s.ada.id, s.bigEp.id, 500)).toEqual({ state: "down", error: "blackwell is down" });
      expect(Date.now() - t).toBeLessThan(100);
      expect(await s.models.pageStatus(s.ada.id, s.smallEp.id)).toMatchObject({ state: "up", status: { state: "running" } });
    } finally {
      for (const c of sockets) c.destroy();
      silent.close();
    }
  });

  it("says a host that revoked this server is unpaired, until it is paired again", async () => {
    const s = await setup();
    s.big.pinned.clear();
    expect(await s.models.pageStatus(s.ada.id, s.bigEp.id)).toMatchObject({ state: "down", unpaired: true });
    // Still unpaired while it counts as down, without asking again.
    expect(await s.models.pageStatus(s.ada.id, s.bigEp.id)).toEqual({ state: "down", error: "blackwell is down", unpaired: true });
    await s.models.pairHost(s.ada, { name: "blackwell", addresses: [s.big.address], code: s.big.newCode() }, { endpointId: s.bigEp.id });
    const again = await s.models.pageStatus(s.ada.id, s.bigEp.id);
    expect(again).toMatchObject({ state: "up" });
    expect(again.unpaired).toBeUndefined();
  });
});
