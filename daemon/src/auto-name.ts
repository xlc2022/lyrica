// Auto-name in the Files panel's Images tab (docs/ux.md §6): a name for each image from what the `vision` task's model
// sees. Principles 1 and 2: the call goes through core/models with the thread's own CallContext, so a private or
// local-only thread gets local models only, and a photo of the user reaches a cloud model only under the user's own
// photo setting. The image and the names are never logged; the call is recorded like any other (task, model).
import { posix } from "node:path";
import { WORKDIR, type CallContext, type Models, type Pool, type Workspace } from "@lyrica/core";
import { modelRuntimeFor, piModelFor, timedReply } from "@lyrica/extension";
import type { AutoName } from "./api.ts";

/** At most this many images in one ask: each is one model call, one after another. */
export const AUTO_NAME_LIMIT = 50;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
/** A name's stem at most this long, before its extension. */
const STEM = 60;

const SYSTEM = [
  "Name the image file from what the picture shows: two to six plain words that would let someone find it again, such as \"red-bicycle-by-a-canal\".",
  "Lowercase, words joined by hyphens, no extension, no quotes, no other text. Reply with the name only.",
].join(" ");

/** The model's reply as a file name's stem: lowercase letters, digits and hyphens, or empty when nothing usable came back. */
export function stemOf(reply: string): string {
  const line = reply.trim().split("\n")[0] ?? "";
  const s = line.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\.(png|jpe?g|gif|webp)$/, "")
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
 * A suggested name for each image, nothing renamed: the panel shows them and the user applies them with Rename.
 * An image that couldn't be named carries `error` in place of `name`. Every call is the thread's own, so its
 * models are the thread's; a portrait counts as local-only unless the user's photo setting is Always, or Ask
 * with today's approval given.
 */
export async function autoNames(models: Models, workspace: Workspace, t: { userId: string; pool: Pool; threadId: string; coordinates?: boolean }, paths: string[], now = new Date()): Promise<AutoName[]> {
  const files = workspace.files(t);
  const images = workspace.imageFiles(t);
  const settings = workspace.settings(t.userId);
  const base = models.callContext(t.userId, t.pool, t.threadId);
  const cloudPhotos = () => { const p = settings.photoCloudPolicy(); return p === "always" || (p === "ask" && settings.photoCloudApproved(dayOf(now))); };
  // Each folder's names, read once, so a suggestion never takes a name that is there.
  const taken = new Map<string, Set<string>>();
  const namesIn = async (dir: string) => {
    let s = taken.get(dir);
    if (!s) { s = new Set((await files.list(dir)).entries.map((e) => e.name.toLowerCase())); taken.set(dir, s); }
    return s;
  };
  const out: AutoName[] = [];
  for (const path of paths) {
    const name = posix.basename(path);
    try {
      if (!IMAGE.test(name)) throw new Error("only images can be named this way");
      // Only the thread's own folder, as the Images tab lists it: never photos-of-me/ or a grant.
      if (!path.startsWith(`${WORKDIR}/`) || posix.normalize(path) !== path) throw new Error("only images in the thread's folder can be named this way");
      // The whole image, for the portrait rule; a GIF can't be read as one, so it counts as a portrait (local only).
      let portrait = true, sent: { data: string; mimeType: string } | undefined;
      try {
        const read = await images.read(path);
        portrait = read.portrait;
        sent = { data: Buffer.from(read.input.bytes).toString("base64"), mimeType: read.input.type };
      } catch { /* the thumbnail below */ }
      // The small copy where there is one: fewer bytes to the model, and it is all a name needs.
      const thumb = await files.thumb(path).catch(() => undefined);
      if (thumb) sent = { data: thumb.bytes.toString("base64"), mimeType: thumb.type };
      if (!sent) throw new Error("it couldn't be read as an image");
      const ctx: CallContext = portrait && !cloudPhotos() ? { ...base, localOnly: true } : base;
      const stem = stemOf(await ask(models, ctx, t, sent));
      if (!stem) throw new Error("the model gave no name");
      const ext = (posix.extname(name) || "").toLowerCase();
      const taken = await namesIn(posix.dirname(path));
      // Already called that: kept as it is.
      if (name.toLowerCase() === `${stem}${ext}`) { out.push({ path, name }); continue; }
      out.push({ path, name: freeName(stem, ext, taken) });
    } catch (err) {
      out.push({ path, error: (err as Error).message });
    }
  }
  return out;
}

/** One call to the thread's `vision` model with one image; the next in the list answers when one's machine is away. */
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
