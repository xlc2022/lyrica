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
