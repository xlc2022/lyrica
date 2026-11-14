// Auto-name in the Files panel's Images and Videos tabs (docs/ux.md §6): a name for each image, or clip by its poster,
// from what the `vision` task's model sees, for names a machine made up; a name a person chose stays unless asked. Principles 1 and 2: the call goes through core/models with the thread's own CallContext, so a private or
// local-only thread gets local models only, and a photo of the user reaches a cloud model only under the user's own
// photo setting. The image and the names are never logged; the call is recorded like any other (task, model).
import { posix } from "node:path";
import { WORKDIR, type CallContext, type Models, type Pool, type Workspace } from "@lyrica/core";
import { modelRuntimeFor, piModelFor, timedReply } from "@lyrica/extension";
import type { AutoName } from "./api.ts";

/** At most this many images in one ask: each is one model call. */
export const AUTO_NAME_LIMIT = 50;
/**
 * Calls in flight at once, here and in the drawer (web/src/MediaTools.tsx). A local server takes them as its slots
 * allow (extension/src/model-share.ts), so more only queue there; a cloud model or a multi-slot server answers them
 * side by side.
 */
export const AUTO_NAME_AT_ONCE = 3;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
/** A clip, named from its poster (the thumbnail kept when it was made); one without a poster can't be named. */
const VIDEO = /\.(mp4|webm)$/i;

// Words a camera, phone, screenshot tool or image app puts in a name it makes up, never words a person picked.
const MACHINE_WORDS = new Set([
  "img", "image", "images", "photo", "photos", "pic", "pics", "picture", "dsc", "dscn", "dscf", "dcim", "pxl", "mvimg", "vid", "video", "mov",
  "movie", "clip", "gopr", "gopro", "dji", "cam", "camera", "screenshot", "screenshots", "screen", "shot", "recording", "capture", "snapshot",
  "untitled", "unnamed", "download", "downloaded", "file", "at", "am", "pm", "copy", "edited", "edit", "hdr", "burst", "portrait", "night",
  "bokeh", "mp", "raw", "cover", "original", "export", "exported", "scaled", "resized", "thumb", "thumbnail", "whatsapp", "signal", "telegram",
  "received", "fb", "wa", "comfyui", "output", "generated", "render", "frame",
]);
const machineToken = (t: string) => /^\d+$/.test(t) || MACHINE_WORDS.has(t)
  || /^[a-z]{1,5}\d{4,}[a-z]?$/.test(t) // IMG1234, DSC0001, P1010001, WA0001
  || /^(?=.*\d)(?=.*[a-f])[0-9a-f]{6,}$/.test(t) // a hash, or part of a UUID
  || (t.length >= 8 && /^[a-z0-9]+$/.test(t) && (t.match(/[a-z]\d|\d[a-z]/g)?.length ?? 0) >= 3); // a random token: a8f3klq9zx

/**
 * Whether a file's name looks made up by a machine (a camera's IMG_0042, a screenshot's date, a hash, a UUID, a
 * random token, "image (1)") rather than chosen by a person: every word in its stem is a number, a camera or app
 * word, or random letters and digits. Auto-name renames only these unless the user ticks **Chosen names**.
 */
export function machineName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  // A UUID's own parts are short, so it is taken whole: Lyrica names what she makes this way.
  const stem = (dot > 0 ? name.slice(0, dot) : name).toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, " ");
  const tokens = stem.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.every(machineToken);
}
/** A name's stem at most this long, before its extension. */
const STEM = 60;

const SYSTEM = [
  "Name the file from what the picture shows: two to six plain words that would let someone find it again, such as \"red-bicycle-by-a-canal\".",
  "Lowercase, words joined by hyphens, no extension, no quotes, no other text. Reply with the name only.",
].join(" ");

/** The model's reply as a file name's stem: lowercase letters, digits and hyphens, or empty when nothing usable came back. */
export function stemOf(reply: string): string {
  const line = reply.trim().split("\n")[0] ?? "";
  const s = line.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\.(png|jpe?g|gif|webp|mp4|webm)$/, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, STEM).replace(/-+$/, "");
}

/** `stem` + `ext`, or with -2, -3… where that name is taken in the folder or by an earlier suggestion. */
export function freeName(stem: string, ext: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const name = `${stem}${n > 1 ? `-${n}` : ""}${ext}`;
    if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
  }
}

const dayOf = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

/**
 * A suggested name for each image or clip, nothing renamed: the panel shows them and the user applies them with Rename.
 * One whose name a person chose (not `machineName`) comes back as it is with `kept`, and no model is asked, unless
 * `all`. One that couldn't be named carries `error` in place of `name`. Every call is the thread's own, so its
 * models are the thread's; a portrait counts as local-only unless the user's photo setting is Always, or Ask
 * with today's approval given.
 */
export async function autoNames(models: Models, workspace: Workspace, t: { userId: string; pool: Pool; threadId: string; coordinates?: boolean }, paths: string[], o: { all?: boolean; now?: Date } = {}): Promise<AutoName[]> {
  const now = o.now ?? new Date();
  const files = workspace.files(t);
  const images = workspace.imageFiles(t);
  const settings = workspace.settings(t.userId);
  const base = models.callContext(t.userId, t.pool, t.threadId);
  const cloudPhotos = () => { const p = settings.photoCloudPolicy(); return p === "always" || (p === "ask" && settings.photoCloudApproved(dayOf(now))); };
  // Each folder's names, read once, so a suggestion never takes a name that is there.
  // The promise is kept, so images named at once share one read of their folder.
  const taken = new Map<string, Promise<Set<string>>>();
  const namesIn = (dir: string) => {
    let s = taken.get(dir);
    if (!s) { s = files.list(dir).then((l) => new Set(l.entries.map((e) => e.name.toLowerCase()))); taken.set(dir, s); }
    return s;
  };
  const one = async (path: string): Promise<AutoName> => {
    const name = posix.basename(path);
    try {
      const video = VIDEO.test(name);
      if (!IMAGE.test(name) && !video) throw new Error("only images and clips can be named this way");
      // Only the thread's own folder, as the Images and Videos tabs list it: never photos-of-me/ or a grant.
      if (!path.startsWith(`${WORKDIR}/`) || posix.normalize(path) !== path) throw new Error("only files in the thread's folder can be named this way");
      // A name a person chose stays, and costs no call.
      if (!o.all && !machineName(name)) return { path, name, kept: true };
      // The whole image, for the portrait rule; a GIF or a clip's poster can't be read as one, so it counts as a
      // portrait (local only).
      let portrait = true, whole: { bytes: Uint8Array; type: string } | undefined;
      if (!video) try {
        const read = await images.read(path);
        portrait = read.portrait;
        whole = read.input;
      } catch { /* the thumbnail below */ }
      // The small copy where there is one: fewer bytes to the model, and it is all a name needs.
      const thumb = await files.thumb(path).catch(() => undefined);
      const sent = thumb ? { data: thumb.bytes.toString("base64"), mimeType: thumb.type }
        : whole ? { data: Buffer.from(whole.bytes).toString("base64"), mimeType: whole.type } : undefined;
      if (!sent) throw new Error(video ? "it has no poster to look at" : "it couldn't be read as an image");
      const ctx: CallContext = portrait && !cloudPhotos() ? { ...base, localOnly: true } : base;
      const stem = stemOf(await ask(models, ctx, t, sent));
      if (!stem) throw new Error("the model gave no name");
      const ext = (posix.extname(name) || "").toLowerCase();
      const taken = await namesIn(posix.dirname(path));
      // Already called that: kept as it is.
      if (name.toLowerCase() === `${stem}${ext}`) return { path, name };
      return { path, name: freeName(stem, ext, taken) };
    } catch (err) {
      return { path, error: (err as Error).message };
    }
  };
  // A few at a time, answered in the order asked.
  const out: AutoName[] = new Array(paths.length);
  let next = 0;
  const worker = async () => { while (next < paths.length) { const i = next++; out[i] = await one(paths[i]!); } };
  await Promise.all(Array.from({ length: Math.min(AUTO_NAME_AT_ONCE, paths.length) }, worker));
  return out;
}

/**
 * One call to the thread's `vision` model with one image; the next in the list answers when one's machine is away.
 * No thinking is asked for (no `reasoning`), so a model that can turn it off answers at once; one whose provider
 * requires it is asked again at medium, or the nearest level it has (extension/src/models.ts).
 */
async function ask(models: Models, ctx: CallContext, t: { userId: string; pool: Pool; threadId: string }, image: { data: string; mimeType: string }): Promise<string> {
  const runtime = await modelRuntimeFor(models, ctx);
  const reply = await models.callWithFallback("vision", ctx, {}, async (resolution) => {
    const { model } = piModelFor(runtime, models, "vision", ctx, resolution);
    models.recordCall(t.userId, { pool: t.pool, threadId: t.threadId, task: "vision", resolution });
    const { reply: r, pace } = await timedReply(runtime.streamSimple(model, {
      systemPrompt: SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: "Name this image." }, { type: "image", ...image }], timestamp: Date.now() }],
    }), model.contextWindow);
    if (r.stopReason === "error") throw new Error(r.errorMessage ?? "the vision model failed");
    if (pace) models.recordPace(t.userId, t.threadId, pace, "vision", t.pool);
    return r;
  });
  return reply.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
}
