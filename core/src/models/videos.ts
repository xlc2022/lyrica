// Principle 2: video calls share the router's cloud boundary, and only model hosts make clips. No disk or logging.
import { hostError, HostIdentityChanged, HostRefused } from "./host.ts";
import { cleanPng, type GeneratedImage, type ImageInput } from "./images.ts";
import { validateLoras, type LoraAsk } from "./loras.ts";
import { withProgress, type JobProgress } from "./progress.ts";

/**
 * One clip: from a prompt, from `image` as its first frame, or with `drive` (an MP4) too, `image`'s subject moved as the
 * person in that clip moves. Or `extend` (an MP4) continued for `duration` more seconds, as one clip. `duration` is
 * seconds, past a model's longest clip only on a recipe that chains clips; `aspectRatio` (width:height) keeps the recipe's area; `steps` replaces the recipe's.
 */
export interface VideoRequest { prompt: string; image?: ImageInput; drive?: Uint8Array; extend?: Uint8Array; size?: { width: number; height: number }; aspectRatio?: string; duration?: number; steps?: number; loras?: LoraAsk[] }
/** A host makes videos of at most this many seconds, chained clips included (host/API.md, "Making videos"). */
export const LONGEST_VIDEO_SECONDS = 60;
/** A driving clip's, or a clip to extend's, largest size (host/API.md, "Making videos"). */
export const MAX_DRIVE_BYTES = 64 * 1024 * 1024;
export interface GeneratedVideo {
  bytes: Uint8Array; type: "video/mp4"; width: number; height: number; frames: number; fps: number; duration: number; audio: boolean; seed?: number;
  /** Its first frame, the clip's thumbnail. */
  poster: GeneratedImage;
}
/** A host may take two hours over one clip (host/API.md, "Making videos"). */
export const VIDEO_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/**
 * How long a request may take: a long video, or an extended clip, is chained clips on the host, each with its own
 * two hours. A chain adds at most 7 s a clip (host/API.md), so one allowance per 5 s never cuts it short.
 */
export const videoTimeout = (r: Pick<VideoRequest, "duration">) => VIDEO_TIMEOUT_MS * Math.max(1, Math.ceil((r.duration ?? 5) / 5));

export function validateVideoRequest(r: VideoRequest): void {
  if (!r.prompt.trim()) throw new HostRefused("invalid", "a video needs a prompt");
  if (r.size && ![r.size.width, r.size.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 16 === 0)) throw new HostRefused("invalid", "video size is multiples of 16 from 256 to 2048");
  if (r.aspectRatio !== undefined && (r.size || !/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(r.aspectRatio))) throw new HostRefused("invalid", "a video takes a size or a width:height aspect ratio");
  if (r.duration !== undefined && !(r.duration >= 1 && r.duration <= LONGEST_VIDEO_SECONDS)) throw new HostRefused("invalid", `a video is 1 to ${LONGEST_VIDEO_SECONDS} seconds`);
  if (r.extend && (r.image || r.drive || r.size || r.aspectRatio)) throw new HostRefused("invalid", "an extended clip takes no image, driving clip or size: it keeps its own");
  if (r.extend && (!isMp4(r.extend) || r.extend.length > MAX_DRIVE_BYTES)) throw new HostRefused("invalid", "a clip to extend is an MP4 of at most 64 MB");
  if (r.steps !== undefined && !(Number.isInteger(r.steps) && r.steps >= 1 && r.steps <= 150)) throw new HostRefused("invalid", "a video takes 1 to 150 steps");
  const loras = validateLoras(r.loras);
  if (loras) throw new HostRefused("invalid", loras);
  if (r.drive && !r.image) throw new HostRefused("invalid", "a driving clip needs the image whose subject moves");
  if (r.drive && (!isMp4(r.drive) || r.drive.length > MAX_DRIVE_BYTES)) throw new HostRefused("invalid", "a driving clip is an MP4 of at most 64 MB");
}

/** An MP4 starts with its `ftyp` box. */
export const isMp4 = (b: Uint8Array) => b.length > 12 && Buffer.from(b.subarray(4, 8)).toString("latin1") === "ftyp";

/** A confirmed host recipe that makes videos: `POST /host/v1/videos/create`, in memory only. */
export async function videoAt(t: { fetch: typeof fetch; baseUrl: string; modelId: string; loras?: { file: string; strength: number }[] }, r: VideoRequest, signal?: AbortSignal, onProgress?: (p: JobProgress) => void): Promise<GeneratedVideo> {
  if (!t.modelId.startsWith("recipe/")) throw new HostRefused("invalid", "a host video model must be a confirmed recipe");
  // Explicit fields only: the recipe's defaults apply, and callers cannot name parts. LoRAs are only those the recipe takes.
  const body = JSON.stringify({ recipe: t.modelId.slice(7), prompt: r.prompt, ...(t.loras?.length ? { loras: t.loras } : {}), ...(r.image ? { image: Buffer.from(r.image.bytes).toString("base64") } : {}),
    ...(r.drive ? { drive: Buffer.from(r.drive).toString("base64") } : {}), ...(r.extend ? { extend: Buffer.from(r.extend).toString("base64") } : {}),
    ...(r.size ?? {}), ...(r.aspectRatio ? { aspectRatio: r.aspectRatio } : {}), ...(r.duration === undefined ? {} : { duration: r.duration }),
    ...(r.steps === undefined ? {} : { steps: r.steps }) });
  const timeout = AbortSignal.timeout(videoTimeout(r));
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
