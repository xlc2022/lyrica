import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A model without vision gets a tool's image as a placeholder. Pi's `read`
// even returns it as a success, and a model reported a screenshot it never saw
// (principle 1). So she is told plainly, and a read of an image fails.

/** Pi's note on a `read` of an image for a model without vision (pi-coding-agent core/tools/read.js). */
const PI_NOTE = "[Current model does not support images. The image will be omitted from this request.]";

/** Added to a tool result holding an image her model can't see. */
export const NO_VISION = "You can't see this image: your model has no vision. Don't describe it or say you checked it. Say you couldn't look, or delegate the look without naming a model: a subagent that meets the image switches to one that can see it, from the person's Look at images list.";

/** A model with vision to switch to, and its label: a subagent's fallback (the person's Look at images list, else a local model with vision). */
export type VisionFallback = () => Promise<{ model: Model<Api>; label: string } | undefined>;

/** Told when the subagent was switched to a model that can see the image. */
export const SWITCHED = (label: string) => `Your model has no vision, so you now run on ${label}, which can see this image.`;

export function registerVisionGuard(pi: ExtensionAPI, fallback?: VisionFallback): void {
  pi.on("context_with_system", (event) => {
    const messages = leaveOutOldImages(event.messages);
    return messages !== event.messages ? { messages } : undefined;
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!ctx.model || ctx.model.input.includes("image")) return;
    // Pi's note counts only on a read of an image, never in a file or output that quotes it.
    const noted = event.toolName === "read" && event.content.some((c) => c.type === "text" && c.text.startsWith("Read image file") && c.text.split("\n").includes(PI_NOTE));
    if (!noted && !event.content.some((c) => c.type === "image")) return;
    // Pi keeps the image in the result and leaves it out only of a request to a model without vision: on the new model, the next request carries it.
    const to = await fallback?.().catch(() => undefined);
    if (to && await pi.setModel(to.model)) {
      const content = event.content.map((c) => (c.type === "text" ? { ...c, text: c.text.split("\n").filter((l) => l !== PI_NOTE).join("\n") } : c));
      return { content: [...content, { type: "text", text: SWITCHED(to.label) }], isError: event.isError };
    }
    return { content: [...event.content, { type: "text", text: NO_VISION }], isError: event.isError || event.toolName === "read" };
  });
}

/**
 * Most image bytes (base64) one request carries. Every earlier image rides along in every request, so a thread that
 * made or looked at many images grows its requests past what a server takes (the model host's 64 MiB, Anthropic's 32 MB)
 * long before its context fills, and then every turn fails the same way.
 */
export const IMAGE_BYTES = 24 << 20;
/** Images leave in pages of this many bytes, oldest first, so a request's start, and its cache, changes only now and then. */
const IMAGE_PAGE = 8 << 20;
/** In place of an image left out. */
export const IMAGE_LEFT_OUT = "[An earlier image, left out of this request to keep it small. Read its file again if you need to see it.]";

type Block = { type: string; data?: string };

/**
 * The messages with their older images left out (principle 2: a request a server refuses never goes out), in the
 * request only: the stored thread keeps them. This turn's images (the last user message and everything after it) are
 * never left out: a turn too big on its own is the server's 413, which Pi compacts for. Older images are paged from
 * the oldest, each page filling to `IMAGE_PAGE`; the newest pages that fit in `budget` keep theirs, and the newest
 * page always does.
 */
export function leaveOutOldImages<T extends object>(messages: T[], budget = IMAGE_BYTES): T[] {
  const blocks = (m: T) => ((m as { content?: unknown }).content);
  const turn = messages.findLastIndex((m) => (m as { role?: string }).role === "user");
  const older = turn < 0 ? messages.length : turn;
  const sizes: number[] = [];
  for (const m of messages.slice(0, older)) { const c = blocks(m); if (Array.isArray(c)) for (const b of c as Block[]) if (b.type === "image") sizes.push(b.data?.length ?? 0); }
  const pages: number[] = [];
  const pageOf: number[] = [];
  for (const s of sizes) {
    if (!pages.length || pages.at(-1)! + s > IMAGE_PAGE) pages.push(0);
    pages[pages.length - 1]! += s;
    pageOf.push(pages.length - 1);
  }
  let kept = pages.length - 1, total = pages[kept] ?? 0;
  while (kept > 0 && total + pages[kept - 1]! <= budget) total += pages[--kept]!;
  const cut = pageOf.indexOf(kept);
  if (cut <= 0) return messages;
  let i = 0;
  return messages.map((m, n) => {
    const c = blocks(m);
    if (n >= older || !Array.isArray(c) || !(c as Block[]).some((b) => b.type === "image")) return m;
    const content = (c as Block[]).map((b) => (b.type !== "image" ? b : i++ < cut ? { type: "text", text: IMAGE_LEFT_OUT } : b));
    return { ...m, content };
  });
}
