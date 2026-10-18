// The Downloads tab's pure parts (src/Downloads.tsx): a host's download in words, a repository named by its owner/name
// or its page's link, and the choices a repository's files make. Kept apart so a test can check them without a page.
import type { Hub } from "./api.ts";

import type { HostDownload } from "./api.ts";
export type { HostDownload } from "./api.ts";

/** A repository's files as a host sees them (host/API.md, "GET /host/v1/hub/files"). */
export interface HubFiles {
  source: Hub; repo: string; gated: boolean;
  /** The host's free space, in bytes. */
  free: number;
  files: { path: string; size: number; allowed: boolean; reason: string | null; present: boolean; fits: boolean }[];
}

export const HUB_WORD: Record<Hub, string> = { huggingface: "Hugging Face", modelscope: "ModelScope" };

export const isRunning = (d: Pick<HostDownload, "state">) => d.state === "queued" || d.state === "downloading" || d.state === "verifying";

/** A size as "4.7 GB", "1.25 TB" or, under a tenth of a gigabyte, "180 MB"; nothing yet is "0 GB". */
export function size(bytes: number): string {
  if (bytes <= 0) return "0 GB";
  if (bytes >= 2 ** 40) return `${(bytes / 2 ** 40).toFixed(2)} TB`;
  if (bytes >= 0.1 * 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 2 ** 20))} MB`;
}

/** A download's speed: "42 MB/s", or "1.2 GB/s" from a gigabyte a second. */
export function speed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 2 ** 30) return `${(bytesPerSecond / 2 ** 30).toFixed(1)} GB/s`;
  return `${Math.max(0, Math.round(bytesPerSecond / 2 ** 20))} MB/s`;
}

/**
 * Each running download's speed, from two looks at it: what arrived since the last look over the time between them,
 * smoothed so one slow poll doesn't jump the number. `seen` carries the last look per download, and is updated.
 */
export function speeds(downloads: Pick<HostDownload, "id" | "state" | "received">[], seen: Map<string, { received: number; at: number; rate?: number }>, at: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of downloads) {
    if (d.state !== "downloading") { seen.delete(d.id); continue; }
    const last = seen.get(d.id);
    let rate = last?.rate;
    if (last && at > last.at && d.received >= last.received) {
      const now = ((d.received - last.received) * 1000) / (at - last.at);
      rate = rate === undefined ? now : rate * 0.5 + now * 0.5;
    }
    seen.set(d.id, { received: d.received, at, ...(rate !== undefined ? { rate } : {}) });
    if (rate !== undefined) out.set(d.id, rate);
  }
  return out;
}

const PHASE = { queued: "Queued", downloading: "Downloading", verifying: "Checking the checksum" } as const;

/** How a finished download ended: its dot (§5's colours; none is grey) and word, and what follows the word, muted. */
export interface Ending { dot: "up" | "away" | "down" | "none"; word: string; note?: string }

/**
 * A download in words: its label (the file's name), "from <source> to <host>", and either its progress ("<phase> ·
 * <GB> of <GB>", the sizes apart so the page sets them in mono, and the percent for the bar) or how it ended.
 */
export function downloadWords(d: HostDownload, host: string): {
  label: string; from: string; progress?: { phase: string; got: string; of?: string }; percent?: number; ending?: Ending;
} {
  const label = d.path.split("/").pop() || d.path;
  const site = d.source === "url" ? (d.url ? hostname(d.url) : d.path.split("/")[2]) || "a link" : HUB_WORD[d.source];
  const from = `from ${site} to ${host}`;
  if (isRunning(d)) {
    return {
      label, from,
      progress: { phase: PHASE[d.state as keyof typeof PHASE], got: size(d.received), ...(d.size ? { of: size(d.size) } : {}) },
      ...(d.size ? { percent: Math.min(100, Math.floor((d.received / d.size) * 100)) } : {}),
    };
  }
  if (d.state === "cancelled") return { label, from, ending: { dot: "none", word: "Cancelled", note: "Nothing was kept." } };
  if (d.state === "failed") return { label, from, ending: { dot: "down", word: "Failed", ...(d.error ? { note: d.error } : {}) } };
  return { label, from, ending: d.verified ? { dot: "up", word: "Verified" } : { dot: "away", word: "Unverified", note: "no checksum given" } };
}

function hostname(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

/** owner/name from what was typed: owner/name itself, or a link to the repository's page on Hugging Face or ModelScope. */
export function repoName(text: string): string | undefined {
  const name = text.trim()
    .replace(/^https?:\/\/(www\.)?(huggingface\.co|hf\.co|modelscope\.cn)\//i, "")
    .replace(/^models\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/(tree|blob|resolve|files|summary)(\/.*)?$/, "")
    .replace(/\/+$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : undefined;
}

/** An https link to one .gguf or .safetensors file. */
export function fileLink(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" && /\.(gguf|safetensors)$/i.test(url.pathname);
  } catch { return false; }
}

/**
 * One thing to download from a repository: a GGUF file (its shards together), or the whole repository. `kind`: a
 * file that only helps a model, a vision projector or an MTP draft, which the host keeps beside the model.
 */
export interface FileChoice { key: string; label: string; files: string[]; size: number; present: boolean; fits: boolean; parts?: number; kind?: "vision" | "mtp" }

/** A vision projector (`mmproj` in its name) or an MTP draft (`mtp-…`, or in an `MTP` folder), as the host tells them (host/API.md). */
export function companionKind(path: string): "vision" | "mtp" | undefined {
  const parts = path.split("/");
  const name = parts[parts.length - 1]!.toLowerCase();
  if (name.includes("mmproj")) return "vision";
  if (/^mtp[-_.]/.test(name) || parts.slice(0, -1).some((p) => p.toLowerCase() === "mtp")) return "mtp";
  return undefined;
}

/** How many characters two names share, from the start and from the end. */
function shared(a: string, b: string): number {
  let head = 0, tail = 0;
  while (head < a.length && a[head] === b[head]) head++;
  while (tail < a.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return head + tail;
}

/**
 * What goes with a model when it is ticked: its vision projector (F16 or BF16 first) and the MTP draft whose name is
 * closest to the model's, as the host pairs them. Those already on the host or too big for it are left out.
 */
export function companionsOf(choices: FileChoice[], modelKey: string): string[] {
  const stem = (k: string) => (k.split("/").pop() ?? k).toLowerCase().replace(/\.gguf$/, "").replace(/^mtp[-_.]/, "");
  const usable = (c: FileChoice) => !c.present && c.fits;
  const vision = choices.filter((c) => c.kind === "vision");
  const projector = vision.find((c) => /bf16|f16/i.test(c.key)) ?? vision[0];
  const drafts = choices.filter((c) => c.kind === "mtp").sort((a, b) => shared(stem(b.key), stem(modelKey)) - shared(stem(a.key), stem(modelKey)));
  return [projector, drafts[0]].filter((c): c is FileChoice => !!c && usable(c)).map((c) => c.key);
}

const SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/**
 * What a repository offers to download: each GGUF file, a split one as one choice with its shards, or, with no GGUF
 * in it, the whole repository (a safetensors model is its folder). Files the host won't download are named in
 * `refused`, one line per reason, leaving out small ones such as a README.
 */
export function fileChoices(list: HubFiles): { choices: FileChoice[]; refused: string[] } {
  const allowed = list.files.filter((f) => f.allowed);
  const ggufs = allowed.filter((f) => /\.gguf$/i.test(f.path));
  const choices: FileChoice[] = [];
  if (ggufs.length) {
    const byModel = new Map<string, typeof ggufs>();
    for (const f of ggufs) {
      const key = SHARD.exec(f.path)?.[1] ?? f.path;
      byModel.set(key, [...(byModel.get(key) ?? []), f]);
    }
    for (const [key, files] of byModel) {
      const total = files.reduce((n, f) => n + f.size, 0);
      const split = files.length > 1 || SHARD.test(files[0]!.path);
      const kind = companionKind(files[0]!.path);
      choices.push({
        key, label: split ? `${key}.gguf` : key, files: files.map((f) => f.path).sort(), size: total,
        present: files.every((f) => f.present), fits: split ? total <= list.free : files[0]!.fits, ...(split ? { parts: files.length } : {}), ...(kind ? { kind } : {}),
      });
    }
    // Models first, then what goes with them.
    choices.sort((a, b) => (a.kind ? 1 : 0) - (b.kind ? 1 : 0));
  } else if (allowed.length) {
    const total = allowed.reduce((n, f) => n + f.size, 0);
    choices.push({ key: "*", label: "Whole repository", files: allowed.map((f) => f.path), size: total, present: allowed.every((f) => f.present), fits: total <= list.free });
  }
  const reasons = new Map<string, number>();
  for (const f of list.files) if (!f.allowed && f.size >= 10 * 2 ** 20) reasons.set(f.reason ?? "", (reasons.get(f.reason ?? "") ?? 0) + 1);
  const refused = [...reasons].map(([reason, n]) => `${n === 1 ? "1 file is" : `${n} files are`} left out.${reason ? ` ${reason}` : ""}`);
  return { choices, refused };
}

/** Principle 6: collect a stable finished list before deletion changes the pages. */
export async function clearFinished<T extends { endpointId: string; download: { id: string } }>(
  load: (offset: number) => Promise<{ entries: T[]; total: number }>,
  remove: (entry: T) => Promise<unknown>,
): Promise<void> {
  const finished = new Map<string, T>();
  for (let offset = 0; ; offset += 100) {
    const page = await load(offset);
    for (const entry of page.entries) finished.set(`${entry.endpointId}/${entry.download.id}`, entry);
    if (!page.entries.length || offset + 100 >= page.total) break;
  }
  for (const entry of finished.values()) await remove(entry);
}
