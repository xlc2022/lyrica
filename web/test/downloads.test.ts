// A download's words, a repository's name and the files it offers (web/src/downloads.ts), as the Downloads tab shows them.
import { describe, expect, it } from "vitest";
import { clearFinished, companionsOf, downloadWords, fileChoices, repoName, size, speed, speeds, type HostDownload, type HubFiles } from "../src/downloads.ts";

const GB = 2 ** 30;
const download = (d: Partial<HostDownload>): HostDownload => ({
  id: "d1", source: "huggingface", repo: "unsloth/Qwen3-8B-GGUF", url: null, path: "lyrica/huggingface/unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf",
  size: 4.7 * GB, received: 1.2 * GB, state: "downloading", verified: null, error: null, startedAt: "2026-10-12T10:00:00Z", ...d,
});

describe("a download in words", () => {
  it("names the file, where from and to, and its progress", () => {
    expect(downloadWords(download({}), "box")).toEqual({
      label: "Qwen3-8B-Q4_K_M.gguf", from: "from Hugging Face to box", progress: { phase: "Downloading", got: "1.2 GB", of: "4.7 GB" }, percent: 25,
    });
    expect(downloadWords(download({ state: "verifying", received: 4.7 * GB }), "box").progress).toEqual({ phase: "Checking the checksum", got: "4.7 GB", of: "4.7 GB" });
    expect(downloadWords(download({ state: "queued", received: 0, source: "modelscope" }), "box")).toMatchObject({ from: "from ModelScope to box", progress: { phase: "Queued", got: "0 GB" }, percent: 0 });
    expect(downloadWords(download({ size: null }), "box")).toEqual({ label: "Qwen3-8B-Q4_K_M.gguf", from: "from Hugging Face to box", progress: { phase: "Downloading", got: "1.2 GB" } });
  });

  it("names a link by its site, from the path once the link is gone", () => {
    expect(downloadWords(download({ source: "url", repo: null, url: "https://example.org/m/vae.safetensors?sig=x", path: "lyrica/url/example.org/vae.safetensors" }), "box").from).toBe("from example.org to box");
    expect(downloadWords(download({ source: "url", repo: null, path: "lyrica/url/example.org/vae.safetensors", state: "done", verified: false }), "box")).toEqual({
      label: "vae.safetensors", from: "from example.org to box", ending: { dot: "away", word: "Unverified", note: "no checksum given" },
    });
  });

  it("says how it ended", () => {
    expect(downloadWords(download({ state: "done", verified: true }), "box").ending).toEqual({ dot: "up", word: "Verified" });
    expect(downloadWords(download({ state: "cancelled" }), "box").ending).toEqual({ dot: "none", word: "Cancelled", note: "Nothing was kept." });
    expect(downloadWords(download({ state: "failed", error: "Start this download again to give the token." }), "box").ending)
      .toEqual({ dot: "down", word: "Failed", note: "Start this download again to give the token." });
  });

  it("writes sizes in GB, TB above, and MB under a tenth of a GB", () => {
    expect(size(16.8 * GB)).toBe("16.8 GB");
    expect(size(1.5 * 1024 * GB)).toBe("1.50 TB");
    expect(size(0.02 * GB)).toBe("20 MB");
    expect(size(300)).toBe("1 MB");
    expect(size(0)).toBe("0 GB");
  });
});

describe("a repository's name", () => {
  it("takes owner/name, or a page's link on either hub", () => {
    expect(repoName(" unsloth/Qwen3-8B-GGUF ")).toBe("unsloth/Qwen3-8B-GGUF");
    expect(repoName("https://huggingface.co/unsloth/Qwen3-8B-GGUF/tree/main")).toBe("unsloth/Qwen3-8B-GGUF");
    expect(repoName("https://huggingface.co/unsloth/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf")).toBe("unsloth/Qwen3-8B-GGUF");
    expect(repoName("https://modelscope.cn/models/Qwen/Qwen3-8B-GGUF/files")).toBe("Qwen/Qwen3-8B-GGUF");
  });
  it("refuses anything else", () => {
    expect(repoName("Qwen3-8B")).toBeUndefined();
    expect(repoName("https://example.org/a/b/c")).toBeUndefined();
    expect(repoName("")).toBeUndefined();
  });
});

describe("what a repository offers", () => {
  const file = (path: string, size: number, more: Partial<HubFiles["files"][number]> = {}) => ({ path, size, allowed: true, reason: null, present: false, fits: true, ...more });
  it("offers each GGUF file, a split one once with its shards, and says which are here or too big", () => {
    const list: HubFiles = { source: "huggingface", repo: "a/b", gated: false, free: 20 * GB, files: [
      file("README.md", 4000, { allowed: false, reason: "Only GGUF, safetensors and ONNX files, and the small files a model folder needs, are downloaded." }),
      file("m-Q4_K_M.gguf", 5 * GB, { present: true }),
      file("m-Q8_0.gguf", 30 * GB, { fits: false }),
      file("big/m-Q6_K-00002-of-00002.gguf", 8 * GB),
      file("big/m-Q6_K-00001-of-00002.gguf", 8 * GB),
      file("config.json", 1000),
    ] };
    expect(fileChoices(list)).toEqual({
      choices: [
        { key: "m-Q4_K_M.gguf", label: "m-Q4_K_M.gguf", files: ["m-Q4_K_M.gguf"], size: 5 * GB, present: true, fits: true },
        { key: "m-Q8_0.gguf", label: "m-Q8_0.gguf", files: ["m-Q8_0.gguf"], size: 30 * GB, present: false, fits: false },
        { key: "big/m-Q6_K", label: "big/m-Q6_K.gguf", files: ["big/m-Q6_K-00001-of-00002.gguf", "big/m-Q6_K-00002-of-00002.gguf"], size: 16 * GB, present: false, fits: true, parts: 2 },
      ],
      refused: [],
    });
  });
  it("offers a vision projector and MTP files after the models, and ticks the right ones with a model", () => {
    const list: HubFiles = { source: "huggingface", repo: "a/b", gated: false, free: 100 * GB, files: [
      file("mmproj-F32.gguf", 2 * GB), file("mmproj-BF16.gguf", GB), file("m-Q4_K_M.gguf", 5 * GB), file("m-Q8_0.gguf", 9 * GB),
      file("MTP/mtp-m-Q4_K_M.gguf", GB / 2), file("MTP/mtp-m-Q8_0.gguf", GB),
    ] };
    const { choices } = fileChoices(list);
    expect(choices.map((c) => [c.key, c.kind])).toEqual([
      ["m-Q4_K_M.gguf", undefined], ["m-Q8_0.gguf", undefined],
      ["mmproj-F32.gguf", "vision"], ["mmproj-BF16.gguf", "vision"], ["MTP/mtp-m-Q4_K_M.gguf", "mtp"], ["MTP/mtp-m-Q8_0.gguf", "mtp"],
    ]);
    expect(companionsOf(choices, "m-Q8_0.gguf")).toEqual(["mmproj-BF16.gguf", "MTP/mtp-m-Q8_0.gguf"]);
    // One already on the host isn't ticked again.
    expect(companionsOf(choices.map((c) => (c.kind === "vision" ? { ...c, present: true } : c)), "m-Q4_K_M.gguf")).toEqual(["MTP/mtp-m-Q4_K_M.gguf"]);
  });
  it("offers a safetensors repository whole, and names the big files it leaves out", () => {
    const list: HubFiles = { source: "huggingface", repo: "a/b", gated: false, free: 10 * GB, files: [
      file("model.safetensors", 16 * GB), file("config.json", 1000),
      file("pytorch_model.bin", 16 * GB, { allowed: false, reason: "Pickle files can run code when loaded." }),
      file("training_args.bin", 20 * 2 ** 20, { allowed: false, reason: "Pickle files can run code when loaded." }),
    ] };
    expect(fileChoices(list)).toEqual({
      choices: [{ key: "*", label: "Whole repository", files: ["model.safetensors", "config.json"], size: 16 * GB + 1000, present: false, fits: false }],
      refused: ["2 files are left out. Pickle files can run code when loaded."],
    });
  });
});

it("shows a download's speed from one look to the next, smoothed", () => {
  const seen = new Map();
  const d = (received: number) => [{ id: "a", state: "downloading" as const, received }];
  expect(speeds(d(0), seen, 0).get("a")).toBeUndefined();
  expect(speeds(d(100 * 2 ** 20), seen, 2000).get("a")).toBe(50 * 2 ** 20);
  expect(speeds(d(300 * 2 ** 20), seen, 4000).get("a")).toBe(75 * 2 ** 20);
  expect(speed(75 * 2 ** 20)).toBe("75 MB/s");
  expect(speed(1.5 * 2 ** 30)).toBe("1.5 GB/s");
  expect(speeds([{ id: "a", state: "verifying", received: 0 }], seen, 6000).size).toBe(0);
  expect(seen.size).toBe(0);
});

it("clears every finished ID once after walking the pages, even if deletes leave the list unchanged", async () => {
  const entries = Array.from({ length: 205 }, (_, i) => ({ endpointId: "host", download: { id: String(i) } }));
  const offsets: number[] = [], removed: string[] = [];
  await clearFinished(async (offset) => {
    expect(removed).toEqual([]);
    offsets.push(offset);
    return { entries: entries.slice(offset, offset + 100), total: entries.length };
  }, async (entry) => { removed.push(entry.download.id); });
  expect(offsets).toEqual([0, 100, 200]);
  expect(removed).toEqual(entries.map(e => e.download.id));
});
