// Principle 2: image calls share the router's cloud boundary. No disk or logging.
import { hostError, HostIdentityChanged, HostRefused } from "./host.ts";

export interface ImageInput { bytes: Uint8Array; type: "image/png" | "image/jpeg" | "image/webp" }
const QUALITY = { fast: "low", quality: "high" } as const;
type Common = { count?: number; references?: ImageInput[] };
export type ImageRequest =
  | (Common & { action: "create"; prompt: string; tier: "fast" | "quality"; size?: { width: number; height: number } })
  | (Common & { action: "edit"; prompt: string; image: ImageInput; mask?: ImageInput; replace?: boolean })
  | { action: "upscale"; image: ImageInput; scale?: number; maxSize?: number };
export interface GeneratedImage { bytes: Uint8Array; type: "image/png"; width: number; height: number; seed?: number }
export interface Target {
  fetch: typeof fetch; baseUrl: string; host: boolean; modelId: string; apiKey?: string; api?: string;
  /** For a ChatGPT plan: the user's Codex, which makes its images (codex.ts). */
  codex?: (r: ImageRequest, signal?: AbortSignal) => Promise<GeneratedImage[]>;
}

export function validateImageRequest(r: ImageRequest): void {
  if (r.action !== "upscale") {
    if (!r.prompt.trim()) throw new HostRefused("invalid", "an image needs a prompt");
    if (r.count !== undefined && (!Number.isInteger(r.count) || r.count < 1 || r.count > 4)) throw new HostRefused("invalid", "image count is 1 to 4");
  }
  if (r.action === "create") {
    if (!["fast", "quality"].includes(r.tier)) throw new HostRefused("invalid", "image tier is fast or quality");
    if (r.size && ![r.size.width, r.size.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 16 === 0)) throw new HostRefused("invalid", "image size is multiples of 16 from 256 to 2048");
  }
  if (r.action === "upscale") {
    if (r.scale !== undefined && !(r.scale >= 1 && r.scale <= 4)) throw new HostRefused("invalid", "image scale is 1 to 4");
    if (r.maxSize !== undefined && (!Number.isInteger(r.maxSize) || r.maxSize < 256 || r.maxSize > 8192)) throw new HostRefused("invalid", "maximum image size is 256 to 8192");
  }
}

/** Keep only PNG rendering chunks: no text, EXIF, profiles or other metadata. */
export function cleanPng(bytes: Uint8Array): GeneratedImage {
  const b = Buffer.from(bytes);
  if (b.length < 33 || !b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new HostRefused("invalid", "image provider didn't return PNG");
  const chunks = [b.subarray(0, 8)];
  let width = 0, height = 0, ended = false;
  for (let at = 8; at + 12 <= b.length;) {
    const size = b.readUInt32BE(at), end = at + 12 + size;
    if (end > b.length) throw new HostRefused("invalid", "image provider returned truncated PNG");
    const tag = b.toString("ascii", at + 4, at + 8);
    if (at === 8 && (tag !== "IHDR" || size !== 13)) throw new HostRefused("invalid", "image provider returned invalid PNG");
    if (tag === "IHDR") { width = b.readUInt32BE(at + 8); height = b.readUInt32BE(at + 12); }
    if (["IHDR", "PLTE", "IDAT", "IEND", "tRNS"].includes(tag)) chunks.push(b.subarray(at, end));
    at = end;
    if (tag === "IEND") { ended = true; break; }
  }
  if (!ended || !width || !height) throw new HostRefused("invalid", "image provider returned invalid PNG");
  return { bytes: Buffer.concat(chunks), type: "image/png", width, height };
}

async function answer(t: Target, path: string, body: string | FormData, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  let res: Response;
  try { res = await t.fetch(`${t.baseUrl}${path}`, { method: "POST", body, headers, redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_800_000)]) : AbortSignal.timeout(1_800_000) });
  } catch (e) {
    signal?.throwIfAborted();
    if (e instanceof HostRefused) throw e;
    // Identity changes must stop rather than trying another host address.
    if (e instanceof HostIdentityChanged) throw e;
    throw new HostRefused("unavailable", "The image endpoint could not be reached.");
  }
  if (!res.ok) {
    // A host's message is its own fixed text, so it is passed on whole (a 413 is a recipe that doesn't fit its GPU).
    // Never echo a cloud provider's message: it may include the prompt. Its code, type and parameter are named instead.
    const err = t.host ? await hostError(res) : undefined;
    const cloud: any = !t.host ? await res.json().catch(() => ({})) : undefined;
    if (isRefusal(cloud?.error?.code) || isRefusal(cloud?.error?.type)) throw imageRefusal();
    const said = err ? `: ${err.message}` : cloudFields(cloud?.error);
    throw new HostRefused(err?.code ?? (res.status >= 500 || res.status === 429 ? "unavailable" : "invalid"), `image endpoint answered ${res.status}${said}`);
  }
  let out: any;
  try { out = await res.json(); }
  catch { throw new HostRefused("invalid", "The image endpoint returned an invalid response."); }
  if (isRefusal(out?.error?.code) || isRefusal(out?.error?.type)) throw imageRefusal();
  return out;
}
/** A cloud error's short identifiers, never its prose: " (code x, type y, parameter z)", or nothing. */
function cloudFields(e: any): string {
  const id = (v: unknown) => typeof v === "string" && /^[\w.\[\]-]{1,64}$/.test(v) ? v : undefined;
  const parts = [["code", id(e?.code)], ["type", id(e?.type)], ["parameter", id(e?.param)]].filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

const base64 = (i: ImageInput) => Buffer.from(i.bytes).toString("base64");

/** The three canvases every GPT Image model takes: the nearest aspect ratio. */
function canvas(size: { width: number; height: number }): string {
  const ratio = size.width / size.height;
  return ratio > 1.2 ? "1536x1024" : ratio < 1 / 1.2 ? "1024x1536" : "1024x1024";
}

async function openai(t: Target, r: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
  if (!t.apiKey) throw new HostRefused("invalid", "a cloud image endpoint needs an API key");
  if (r.action === "upscale") throw new HostRefused("invalid", "OpenAI images doesn't upscale");
  const fields: Record<string, string> = { model: t.modelId, prompt: r.prompt, output_format: "png", ...(r.count === undefined ? {} : { n: String(r.count) }) };
  if (r.action === "create") {
    fields.quality = QUALITY[r.tier];
    if (r.size) {
      fields.size = t.modelId.startsWith("gpt-image-1") ? canvas(r.size) : `${r.size.width}x${r.size.height}`;
    }
  }
  const inputs = [...(r.action === "edit" ? [r.image] : []), ...(r.references ?? [])];
  let body: string | FormData, path: string, headers: Record<string, string> = { authorization: `Bearer ${t.apiKey}` };
  if (inputs.length) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    inputs.forEach((i, n) => form.append("image[]", new Blob([Uint8Array.from(i.bytes)], { type: i.type }), `image-${n}.${i.type.split("/")[1]}`));
    if (r.action === "edit" && r.mask) form.append("mask", new Blob([Uint8Array.from(r.mask.bytes)], { type: r.mask.type }), "mask.png");
    body = form; path = "/images/edits";
  } else { body = JSON.stringify({ ...fields, ...(r.count === undefined ? {} : { n: r.count }) }); path = "/images/generations"; headers["content-type"] = "application/json"; }
  const out = await answer(t, path, body, headers, signal);
  if (!Array.isArray(out.data) || !out.data.length) throw new HostRefused("invalid", "image endpoint returned no images");
  return out.data.map((i: { b64_json?: string }) => {
    if (typeof i.b64_json !== "string") throw new HostRefused("invalid", "image endpoint returned no image bytes");
    return cleanPng(Buffer.from(i.b64_json, "base64"));
  });
}

/** A fixed code and message: provider prose can contain the prompt. */
const isRefusal = (code: unknown) => ["content_policy_violation", "content_filter", "moderation_blocked", "image_refusal"].includes(String(code));
const imageRefusal = () => new HostRefused("image_refusal", "Image generation was refused (image_refusal).");


/** A ChatGPT plan's one image model, made by the user's own Codex, which picks its image model (docs/models.md, "Image canvases"). */
export const PLAN_IMAGE_MODEL = "chatgpt-images";
export const PLAN_IMAGE: { modelId: string; recipe: string; image: true; edit: true; vision: true } = { modelId: PLAN_IMAGE_MODEL, recipe: "ChatGPT Images", image: true, edit: true, vision: true };


export interface CloudImageProvider {
  run: (t: Target, r: ImageRequest, signal?: AbortSignal) => Promise<GeneratedImage[]>;
  create: boolean; edit: boolean; mask: boolean; references: boolean; sizes: boolean; count: number;
  quality: { fast: "low"; quality: "high" };
}
/** Selected by endpoint API, never by the model's name. */
export const CLOUD_IMAGE_PROVIDERS: Readonly<Record<string, CloudImageProvider>> = {
  "openai-compatible": { run: openai, create: true, edit: true, mask: true, references: true, sizes: true, count: 4, quality: QUALITY },
  chatgpt: { run: (t, r, signal) => t.codex ? t.codex(r, signal) : Promise.reject(new HostRefused("unavailable", "Codex isn't set up on this server.")), create: true, edit: true, mask: false, references: true, sizes: true, count: 4, quality: QUALITY },
};

export async function imageAt(t: Target, r: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
  if (!t.host) {
    const provider = CLOUD_IMAGE_PROVIDERS[t.api ?? "openai-compatible"];
    if (!provider) throw new HostRefused("unsupported", "This endpoint has no image provider.");
    try { return await provider.run(t, r, signal); }
    catch (e) {
      signal?.throwIfAborted();
      if (e instanceof HostRefused || e instanceof HostIdentityChanged) throw e;
      throw new HostRefused("invalid", "The image endpoint returned an invalid image response.");
    }
  }
  if (!t.modelId.startsWith("recipe/")) throw new HostRefused("invalid", "a host image model must be a confirmed recipe");
  // Explicit fields only: recipe defaults apply, and callers cannot name parts or LoRAs.
  const fields = { recipe: t.modelId.slice(7),
    ...(r.action === "upscale" ? { image: base64(r.image), ...(r.scale === undefined ? {} : { scale: r.scale }), ...(r.maxSize === undefined ? {} : { maxSize: r.maxSize }) } : {
      prompt: r.prompt, ...(r.count === undefined ? {} : { count: r.count }), ...(r.references ? { references: r.references.map(base64) } : {}),
      ...(r.action === "create" ? r.size ?? {} : { image: base64(r.image), ...(r.mask ? { mask: base64(r.mask), ...(r.replace ? { replace: true } : {}) } : {}) }),
    }) };
  const out = await answer(t, `/host/v1/images/${r.action}`, JSON.stringify(fields), { "content-type": "application/json" }, signal);
  if (!Array.isArray(out.images) || !out.images.length) throw new HostRefused("invalid", "image host returned no images");
  return out.images.map((i: { png: string; seed?: number }) => ({ ...cleanPng(Buffer.from(i.png, "base64")), ...(i.seed === undefined ? {} : { seed: i.seed }) }));
}
