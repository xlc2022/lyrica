// Principle 2: image calls share the router's cloud boundary. No disk or logging.
import { hostError, HostRefused } from "./host.ts";

export interface ImageInput { bytes: Uint8Array; type: "image/png" | "image/jpeg" | "image/webp" }
type Common = { count?: number; references?: ImageInput[] };
export type ImageRequest =
  | (Common & { action: "create"; prompt: string; tier: "fast" | "quality"; size?: { width: number; height: number } })
  | (Common & { action: "edit"; prompt: string; image: ImageInput; mask?: ImageInput })
  | { action: "upscale"; image: ImageInput; scale?: number; maxSize?: number };
export interface GeneratedImage { bytes: Uint8Array; type: "image/png"; width: number; height: number; seed?: number }
interface Target { fetch: typeof fetch; baseUrl: string; host: boolean; modelId: string; apiKey?: string }

export function validateImageRequest(r: ImageRequest): void {
  if (r.action !== "upscale") {
    if (!r.prompt.trim()) throw new Error("an image needs a prompt");
    if (r.count !== undefined && (!Number.isInteger(r.count) || r.count < 1 || r.count > 4)) throw new Error("image count is 1 to 4");
  }
  if (r.action === "create") {
    if (!["fast", "quality"].includes(r.tier)) throw new Error("image tier is fast or quality");
    if (r.size && ![r.size.width, r.size.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 16 === 0)) throw new Error("image size is multiples of 16 from 256 to 2048");
  }
  if (r.action === "upscale") {
    if (r.scale !== undefined && !(r.scale >= 1 && r.scale <= 4)) throw new Error("image scale is 1 to 4");
    if (r.maxSize !== undefined && (!Number.isInteger(r.maxSize) || r.maxSize < 256 || r.maxSize > 8192)) throw new Error("maximum image size is 256 to 8192");
  }
}

/** Keep only PNG rendering chunks: no text, EXIF, profiles or other metadata. */
export function cleanPng(bytes: Uint8Array): GeneratedImage {
  const b = Buffer.from(bytes);
  if (b.length < 33 || !b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("image provider didn't return PNG");
  const chunks = [b.subarray(0, 8)];
  let width = 0, height = 0, ended = false;
  for (let at = 8; at + 12 <= b.length;) {
    const size = b.readUInt32BE(at), end = at + 12 + size;
    if (end > b.length) throw new Error("image provider returned truncated PNG");
    const tag = b.toString("ascii", at + 4, at + 8);
    if (at === 8 && (tag !== "IHDR" || size !== 13)) throw new Error("image provider returned invalid PNG");
    if (tag === "IHDR") { width = b.readUInt32BE(at + 8); height = b.readUInt32BE(at + 12); }
    if (["IHDR", "PLTE", "IDAT", "IEND", "tRNS"].includes(tag)) chunks.push(b.subarray(at, end));
    at = end;
    if (tag === "IEND") { ended = true; break; }
  }
  if (!ended || !width || !height) throw new Error("image provider returned invalid PNG");
  return { bytes: Buffer.concat(chunks), type: "image/png", width, height };
}

async function answer(t: Target, path: string, body: string | FormData, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const res = await t.fetch(`${t.baseUrl}${path}`, { method: "POST", body, headers, redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_800_000)]) : AbortSignal.timeout(1_800_000) });
  if (!res.ok) {
    // Never echo a provider's error message: it may include the prompt.
    const err = t.host ? await hostError(res) : undefined;
    throw new HostRefused(err?.code ?? (res.status >= 500 || res.status === 429 ? "unavailable" : "invalid"), `image endpoint answered ${res.status}`);
  }
  return res.json();
}
const base64 = (i: ImageInput) => Buffer.from(i.bytes).toString("base64");

async function openai(t: Target, r: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
  if (!t.apiKey) throw new Error("a cloud image endpoint needs an API key");
  if (r.action === "upscale") throw new Error("OpenAI images doesn't upscale");
  if (!t.modelId.startsWith("gpt-image-") && t.modelId !== "chatgpt-image-latest") throw new Error("OpenAI images requires a GPT image model");
  const fields: Record<string, string> = { model: t.modelId, prompt: r.prompt, output_format: "png", ...(r.count === undefined ? {} : { n: String(r.count) }) };
  if (r.action === "create") {
    fields.quality = r.tier === "fast" ? "low" : "high";
    if (r.size) fields.size = `${r.size.width}x${r.size.height}`;
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
  if (!Array.isArray(out.data) || !out.data.length) throw new Error("image endpoint returned no images");
  return out.data.map((i: { b64_json?: string }) => {
    if (typeof i.b64_json !== "string") throw new Error("image endpoint returned no image bytes");
    return cleanPng(Buffer.from(i.b64_json, "base64"));
  });
}

/** OpenAI's image wire format, also usable by compatible cloud endpoints with a key. */
export const CLOUD_IMAGE_PROVIDERS = { openai } as const;

export async function imageAt(t: Target, r: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
  if (!t.host) return CLOUD_IMAGE_PROVIDERS.openai(t, r, signal);
  if (!t.modelId.startsWith("recipe/")) throw new Error("a host image model must be a confirmed recipe");
  // Explicit fields only: recipe defaults apply, and callers cannot name parts or LoRAs.
  const fields = { recipe: t.modelId.slice(7),
    ...(r.action === "upscale" ? { image: base64(r.image), ...(r.scale === undefined ? {} : { scale: r.scale }), ...(r.maxSize === undefined ? {} : { maxSize: r.maxSize }) } : {
      prompt: r.prompt, ...(r.count === undefined ? {} : { count: r.count }), ...(r.references ? { references: r.references.map(base64) } : {}),
      ...(r.action === "create" ? r.size ?? {} : { image: base64(r.image), ...(r.mask ? { mask: base64(r.mask) } : {}) }),
    }) };
  const out = await answer(t, `/host/v1/images/${r.action}`, JSON.stringify(fields), { "content-type": "application/json" }, signal);
  if (!Array.isArray(out.images) || !out.images.length) throw new Error("image host returned no images");
  return out.images.map((i: { png: string; seed?: number }) => ({ ...cleanPng(Buffer.from(i.png, "base64")), ...(i.seed === undefined ? {} : { seed: i.seed }) }));
}
