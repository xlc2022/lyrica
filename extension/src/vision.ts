import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A model without vision gets a tool's image as a placeholder. Pi's `read`
// even returns it as a success, and a model reported a screenshot it never saw
// (principle 1). So she is told plainly, and a read of an image fails.

/** Added to a tool result holding an image her model can't see. */
export const NO_VISION = "You can't see this image: your model has no vision. Don't describe it or say you checked it. Say you couldn't look, or delegate the look to a local model with vision (delegate action models marks them; a cloud one only if the person agrees).";

export function registerVisionGuard(pi: ExtensionAPI): void {
  pi.on("tool_result", (event, ctx) => {
    if (!ctx.model || ctx.model.input.includes("image")) return;
    if (!event.content.some((c) => c.type === "image" || (c.type === "text" && c.text.includes("does not support images")))) return;
    return { content: [...event.content, { type: "text", text: NO_VISION }], isError: event.isError || event.toolName === "read" };
  });
}
