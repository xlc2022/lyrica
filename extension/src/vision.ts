import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A model without vision gets a tool's image as a placeholder. Pi's `read`
// even returns it as a success, and a model reported a screenshot it never saw
// (principle 1). So she is told plainly, and a read of an image fails.

/** Pi's note on a `read` of an image for a model without vision (pi-coding-agent core/tools/read.js). */
const PI_NOTE = "[Current model does not support images. The image will be omitted from this request.]";

/** Added to a tool result holding an image her model can't see. */
export const NO_VISION = "You can't see this image: your model has no vision. Don't describe it or say you checked it. Say you couldn't look, or delegate the look to a local model with vision (delegate action models marks them; a cloud one only if the person agrees).";

export function registerVisionGuard(pi: ExtensionAPI): void {
  pi.on("tool_result", (event, ctx) => {
    if (!ctx.model || ctx.model.input.includes("image")) return;
    // Pi's note counts only on a read of an image, never in a file or output that quotes it.
    const noted = event.toolName === "read" && event.content.some((c) => c.type === "text" && c.text.startsWith("Read image file") && c.text.split("\n").includes(PI_NOTE));
    if (!noted && !event.content.some((c) => c.type === "image")) return;
    return { content: [...event.content, { type: "text", text: NO_VISION }], isError: event.isError || event.toolName === "read" };
  });
}
