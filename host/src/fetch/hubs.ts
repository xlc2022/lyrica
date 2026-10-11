// Listing a repository's files on Hugging Face or ModelScope, with each file's
// size and checksum as the hub publishes them.
import { DownloadError, type Net } from "./net.ts";

export type Source = "huggingface" | "modelscope" | "url";

export interface Card {
  baseModel: string[];
  baseModelRelation: string | null;
}

export interface HubFile {
  path: string;
  size: number;
  /** SHA-256 for large (LFS) files. */
  sha256: string | null;
  /** The git blob SHA-1 for small files, which is all the hub publishes for them. */
  gitSha1: string | null;
}

export interface Listing {
  revision: string;
  gated: boolean;
  card: Card | null;
  files: HubFile[];
}

export interface Hub {
  host: string;
  list(repo: string, revision: string | undefined, token?: string): Promise<Listing>;
  fileUrl(repo: string, revision: string, path: string): string;
}

const REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

export function checkRepo(repo: unknown): string {
  if (typeof repo !== "string" || !REPO.test(repo) || repo.includes("..")) throw new DownloadError("That isn't a repository name (owner/name).");
  return repo;
}

/** A file path inside a repository: relative, no `..`, no backslashes. */
export function checkRepoPath(path: unknown): string {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.split("/").some((p) => p === ".." || p === "." || p === "")) {
    throw new DownloadError("That isn't a file path in the repository.");
  }
  return path;
}

const ALLOWED = [".gguf", ".safetensors", ".onnx", ".json", ".txt", ".jinja", ".model", ".tiktoken"];
const PICKLE = [".bin", ".pt", ".pth", ".ckpt", ".pkl", ".pickle"];
/**
 * A voice model's voices (Kokoro's ONNX export): raw float32 arrays named
 * .bin, which only the speech server reads, as plain numbers. Checked when
 * downloaded to be neither a pickle nor a zip.
 */
export const VOICE_FILE = /(^|\/)voices\/[\w-]+\.bin$/;

/** Whether a file may be downloaded, and why not. */
export function verdict(path: string): { allowed: boolean; reason: string | null } {
  const name = path.toLowerCase();
  if (VOICE_FILE.test(name)) return { allowed: true, reason: null };
  if (PICKLE.some((e) => name.endsWith(e))) return { allowed: false, reason: "Pickle files can run code when loaded." };
  if (name.endsWith(".py")) return { allowed: false, reason: "Code is never downloaded." };
  if (!ALLOWED.some((e) => name.endsWith(e))) return { allowed: false, reason: "Only GGUF, safetensors and ONNX files, and the small files a model folder needs, are downloaded." };
  return { allowed: true, reason: null };
}

function card(data: any): Card | null {
  if (!data) return null;
  const base = data.base_model;
  const baseModel = Array.isArray(base) ? base.filter((b) => typeof b === "string") : typeof base === "string" ? [base] : [];
  const relation = typeof data.base_model_relation === "string" ? data.base_model_relation : null;
  return baseModel.length || relation ? { baseModel, baseModelRelation: relation } : null;
}

export function huggingFace(net: Net, base = "https://huggingface.co"): Hub {
  const host = new URL(base).hostname;
  return {
    host,
    async list(repo, revision = "main", token) {
      checkRepo(repo);
      const enc = repo.split("/").map(encodeURIComponent).join("/");
      const info = await net.json({ url: `${base}/api/models/${enc}/revision/${encodeURIComponent(revision)}`, token, tokenHost: host });
      const sha = typeof info.sha === "string" ? info.sha : revision;
      const tree = await net.json({ url: `${base}/api/models/${enc}/tree/${encodeURIComponent(sha)}?recursive=true`, token, tokenHost: host });
      const files: HubFile[] = (Array.isArray(tree) ? tree : [])
        .filter((f: any) => f.type === "file" && typeof f.path === "string")
        .map((f: any) => ({
          path: f.path,
          size: Number(f.lfs?.size ?? f.size ?? 0),
          sha256: typeof f.lfs?.oid === "string" ? f.lfs.oid : null,
          gitSha1: !f.lfs && typeof f.oid === "string" ? f.oid : null,
        }));
      return { revision: sha, gated: !!info.gated, card: card(info.cardData), files };
    },
    fileUrl(repo, revision, path) {
      return `${base}/${repo}/resolve/${encodeURIComponent(revision)}/${path.split("/").map(encodeURIComponent).join("/")}`;
    },
  };
}

export function modelScope(net: Net, base = "https://modelscope.cn"): Hub {
  const host = new URL(base).hostname;
  return {
    host,
    async list(repo, revision = "master", token) {
      checkRepo(repo);
      const body = await net.json({ url: `${base}/api/v1/models/${repo}/repo/files?Revision=${encodeURIComponent(revision)}&Recursive=true`, token, tokenHost: host });
      const files: HubFile[] = (body?.Data?.Files ?? [])
        .filter((f: any) => f.Type !== "tree" && typeof f.Path === "string")
        .map((f: any) => ({ path: f.Path, size: Number(f.Size ?? 0), sha256: typeof f.Sha256 === "string" && f.Sha256 ? f.Sha256 : null, gitSha1: null }));
      return { revision, gated: false, card: null, files };
    },
    fileUrl(repo, revision, path) {
      return `${base}/api/v1/models/${repo}/repo?Revision=${encodeURIComponent(revision)}&FilePath=${encodeURIComponent(path)}`;
    },
  };
}
