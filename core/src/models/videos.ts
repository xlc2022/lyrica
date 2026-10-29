// Principle 2: video calls share the router's cloud boundary, and only model hosts make clips. No disk or logging.
import { hostError, HostIdentityChanged, HostRefused } from "./host.ts";
import { cleanPng, type GeneratedImage, type ImageInput } from "./images.ts";
import { withProgress, type JobProgress } from "./progress.ts";

/** One clip: from a prompt, or from `image` as its first frame. `duration` is seconds; `aspectRatio` (width:height) keeps the recipe's area. */
export interface VideoRequest { prompt: string; image?: ImageInput; size?: { width: number; height: number }; aspectRatio?: string; duration?: number }
export interface GeneratedVideo {
  bytes: Uint8Array; type: "video/mp4"; width: number; height: number; frames: number; fps: number; duration: number; audio: boolean; seed?: number;
  /** Its first frame, the clip's thumbnail. */
  poster: GeneratedImage;
}
/** A host may take two hours over one clip (host/API.md, "Making videos"). */
export const VIDEO_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function validateVideoRequest(r: VideoRequest): void {
  if (!r.prompt.trim()) throw new HostRefused("invalid", "a video needs a prompt");
  if (r.size && ![r.size.width, r.size.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 16 === 0)) throw new HostRefused("invalid", "video size is multiples of 16 from 256 to 2048");
  if (r.aspectRatio !== undefined && (r.size || !/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(r.aspectRatio))) throw new HostRefused("invalid", "a video takes a size or a width:height aspect ratio");
  if (r.duration !== undefined && !(r.duration >= 1 && r.duration <= 15)) throw new HostRefused("invalid", "a video is 1 to 15 seconds");
}

/** An MP4 starts with its `ftyp` box. */
export const isMp4 = (b: Uint8Array) => b.length > 12 && Buffer.from(b.subarray(4, 8)).toString("latin1") === "ftyp";

/** A confirmed host recipe that makes videos: `POST /host/v1/videos/create`, in memory only. */
export async function videoAt(t: { fetch: typeof fetch; baseUrl: string; modelId: string }, r: VideoRequest, signal?: AbortSignal, onProgress?: (p: JobProgress) => void): Promise<GeneratedVideo> {
  if (!t.modelId.startsWith("recipe/")) throw new HostRefused("invalid", "a host video model must be a confirmed recipe");
  // Explicit fields only: the recipe's defaults apply, and callers cannot name parts or LoRAs.
  const body = JSON.stringify({ recipe: t.modelId.slice(7), prompt: r.prompt, ...(r.image ? { image: Buffer.from(r.image.bytes).toString("base64") } : {}),
    ...(r.size ?? {}), ...(r.aspectRatio ? { aspectRatio: r.aspectRatio } : {}), ...(r.duration === undefined ? {} : { duration: r.duration }) });
  const timeout = AbortSignal.timeout(VIDEO_TIMEOUT_MS);
  let res: Response;
  try { res = await withProgress(t, onProgress, (tag) => t.fetch(`${t.baseUrl}/host/v1/videos/create`, { method: "POST", body, headers: { "content-type": "application/json", ...tag }, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout })); }
  catch (e) {
    signal?.throwIfAborted();
    if (e instanceof HostRefused || e instanceof HostIdentityChanged) throw e;
    throw new HostRefused("unavailable", "The video host could not be reached.");
  }
  // A host's message is its own fixed text, never the prompt.
  if (!res.ok) { const err = await hostError(res); throw new HostRefused(err?.code ?? (res.status >= 500 || res.status === 429 ? "unavailable" : "invalid"), `video host answered ${res.status}${err ? `: ${err.message}` : ""}`); }
  let out: any;
  try { out = await res.json(); } catch { throw new HostRefused("invalid", "The video host returned an invalid response."); }
  const v = out?.video;
  const bytes = typeof v?.mp4 === "string" ? Buffer.from(v.mp4, "base64") : undefined;
  if (!bytes || !isMp4(bytes) || typeof out.poster !== "string") throw new HostRefused("invalid", "video host returned no MP4");
  const num = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  return { bytes, type: "video/mp4", width: num(v.width), height: num(v.height), frames: num(v.frames), fps: num(v.fps), duration: num(v.duration), audio: v.audio === true,
    ...(typeof v.seed === "number" ? { seed: v.seed } : {}), poster: cleanPng(Buffer.from(out.poster, "base64")) };
}
