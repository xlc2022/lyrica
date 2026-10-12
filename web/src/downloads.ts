// The Downloads tab's pure parts (src/Downloads.tsx): a host's download in words, a repository named by its owner/name
// or its page's link, and the choices a repository's files make. Kept apart so a test can check them without a page.
import type { Hub } from "./api.ts";

/** A download as the host reports it (host/API.md, "POST /host/v1/downloads"). */
export interface HostDownload {
  id: string;
  source: Hub | "url";
  repo: string | null;
  url: string | null;
  /** Where it goes in the host's models folder: `lyrica/<source>/<repo>/<file>`, or `lyrica/url/<hostname>/<file>`. */
  path: string;
  size: number | null;
  received: number;
  state: "queued" | "downloading" | "verifying" | "done" | "failed" | "cancelled";
  /** true: the checksum matched; false: none was given; null until done. */
  verified: boolean | null;
  error: string | null;
  startedAt: string;
}

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

/** One thing to download from a repository: a GGUF file (its shards together), or the whole repository. */
export interface FileChoice { key: string; label: string; files: string[]; size: number; present: boolean; fits: boolean; parts?: number }

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
      choices.push({
        key, label: split ? `${key}.gguf` : key, files: files.map((f) => f.path).sort(), size: total,
        present: files.every((f) => f.present), fits: split ? total <= list.free : files[0]!.fits, ...(split ? { parts: files.length } : {}),
      });
    }
  } else if (allowed.length) {
    const total = allowed.reduce((n, f) => n + f.size, 0);
    choices.push({ key: "*", label: "Whole repository", files: allowed.map((f) => f.path), size: total, present: allowed.every((f) => f.present), fits: total <= list.free });
  }
  const reasons = new Map<string, number>();
  for (const f of list.files) if (!f.allowed && f.size >= 10 * 2 ** 20) reasons.set(f.reason ?? "", (reasons.get(f.reason ?? "") ?? 0) + 1);
  const refused = [...reasons].map(([reason, n]) => `${n === 1 ? "1 file is" : `${n} files are`} left out.${reason ? ` ${reason}` : ""}`);
  return { choices, refused };
}
