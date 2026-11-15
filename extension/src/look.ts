// Principles 1 and 2: eyes for a model that can't see. A thread's model with vision of its own looks at images itself;
// one without gets the look tool, which shows the images (or a clip's stills) to the thread's Look at images model
// (task `vision`) with her question and hands back its words. The vision model sees only the images and the question,
// never the conversation, and the thread's own model keeps the work. The call goes through core/models with the
// thread's own CallContext, so a private or local-only thread's look stays local, and a photo of the user reaches a
// cloud model only under the user's photo setting, asked as the image tool asks.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CloudModelForbidden, isRestricted, MAX_FRAMES, type CallContext, type Models, type ThreadImages, type WorkspaceSettings } from "@lyrica/core";
import { Type } from "typebox";
import { timedReply } from "./context.ts";
import { setToolsOff } from "./gate.ts";
import { allowPortrait } from "./images.ts";
import { modelRuntimeFor, piModelFor } from "./models.ts";
import type { Approval, ApprovalRequest } from "./workspace.ts";

export interface LookTools {
  models: Models;
  /** The thread's CallContext as it is now; a subagent's says local-only when its parent's does. */
  call(): CallContext;
  threadId: string;
  files: Pick<ThreadImages, "read">;
  /** A clip's stills (ThreadFiles.frames). Without it, a clip can't be looked at. */
  frames?(path: string, count: number): Promise<{ at: number; bytes: Buffer; type: string }[]>;
  settings(): WorkspaceSettings;
  /** As ImageTools.approve, for a photo of the user going to a cloud vision model. */
  approve?(request: ApprovalRequest): Promise<Approval>;
  now?: () => Date;
}

/** At most this many images, or clips, in one look. */
export const MAX_LOOK_FILES = 8;
/** A clip's stills when she gives no number. */
export const DEFAULT_FRAMES = 8;
const VIDEO = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;

const SYSTEM = [
  "You are the eyes of an assistant who can't see images. You get images, or stills from a video in order with the second each comes from, and the assistant's question.",
  "Answer only from what is visible: describe what matters for the question, read any text exactly as written, and give counts, colours, positions and changes between stills where they help.",
  "Say plainly when something can't be made out. Never guess at what isn't shown. Reply in plain text.",
].join(" ");

/** Whether a model takes images itself: then it looks with its own eyes and isn't offered the look tool. */
export const sees = (model: Model<Api> | undefined) => !!model?.input.includes("image");

/** Told to her when an image comes back from a tool and the look tool is there for her. */
export const USE_LOOK = "You can't see this image: your model has no vision. Don't describe it from this result. Call look with recent set (or its path) and what you need to know.";

export function createLookExtension(o: LookTools): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    // Offered only while the thread's model can't see: one that can uses its own vision.
    const gate = (ctx: ExtensionContext) => setToolsOff(pi, ctx, "look", sees(ctx.model) ? ["look"] : []);
    pi.on("session_start", (_e, ctx) => { gate(ctx); });
    pi.on("model_select", (_e, ctx) => { gate(ctx); });
    pi.on("before_agent_start", (_e, ctx) => { gate(ctx); });
    // The images of the latest tool result that held any (a browse screenshot, an image she made), for `recent`: a
    // screenshot has no path. In memory only, for this session; one from anywhere but the browser counts as a portrait.
    let recent: { images: { data: string; mimeType: string }[]; portrait: boolean } | undefined;
    pi.on("tool_result", (event) => {
      if (event.toolName === "look") return;
      const images = event.content.filter((c) => c.type === "image") as { data: string; mimeType: string }[];
      if (images.length) recent = { images: images.map((c) => ({ data: c.data, mimeType: c.mimeType })), portrait: event.toolName !== "browse" };
    });
    pi.registerTool({
      name: "look", label: "Look",
      description: `Look at images or videos your model can't see: the thread's vision model answers your question about them in words. Paths are workspace images (PNG, JPEG or WebP), /photos-of-me/<file>, or clips (MP4, WebM, MOV), at most ${MAX_LOOK_FILES} at once; a clip is shown as stills spread over its length. recent adds the images of the latest tool result that held any, such as a browse screenshot.`,
      promptSnippet: "see images and videos through the thread's vision model",
      promptGuidelines: [
        "Use look whenever you need to know what an image or video shows (one the user sent, a screenshot, a result you made): ask exactly what you need, such as \"describe this photo\", \"read all the text\" or \"what changes between these two\".",
        "Say what look reported as what you were told it shows; ask again with a sharper question rather than guessing at detail it didn't give.",
      ],
      annotations: { readOnlyHint: true },
      parameters: Type.Object({
        paths: Type.Optional(Type.Array(Type.String(), { description: `The images or clips, at most ${MAX_LOOK_FILES}.`, maxItems: MAX_LOOK_FILES })),
        recent: Type.Optional(Type.Boolean({ description: "Also the images in the latest tool result that held any, such as a browse screenshot." })),
        question: Type.String({ description: "What you need to know about them." }),
        frames: Type.Optional(Type.Integer({ description: `Stills per clip, 1 to ${MAX_FRAMES}; ${DEFAULT_FRAMES} if left out.` })),
      }),
      async execute(id, p, signal, _update, ctx) {
        const paths = [...new Set(p.paths ?? [])];
        if (paths.length > MAX_LOOK_FILES) throw new Error(`Give at most ${MAX_LOOK_FILES} paths.`);
        if (p.recent && !recent) throw new Error("No tool result has held an image yet: give paths.");
        if (!paths.length && !p.recent) throw new Error("Give paths, or set recent.");
        if (!p.question.trim()) throw new Error("Say what you need to know about them.");
        const frames = Math.max(1, Math.min(MAX_FRAMES, p.frames ?? DEFAULT_FRAMES));
        // Each file's images, with a line naming it; a clip's stills say the second each comes from.
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: p.question.trim() }];
        let portrait = false, images = 0;
        if (p.recent && recent) {
          portrait = recent.portrait;
          content.push({ type: "text", text: "From the latest tool result:" });
          for (const image of recent.images) { content.push({ type: "image", ...image }); images++; }
        }
        for (const path of paths) {
          if (VIDEO.test(path)) {
            if (!o.frames) throw new Error("Videos can't be looked at here.");
            const stills = await o.frames(path, frames);
            // A clip's stills can't be traced to a portrait as an image can: they count as one, as Auto-name's posters do.
            portrait = true;
            content.push({ type: "text", text: `Video ${path}, ${stills.length} still${stills.length > 1 ? "s" : ""}:` });
            for (const s of stills) {
              content.push({ type: "text", text: `At ${s.at} s:` }, { type: "image", data: s.bytes.toString("base64"), mimeType: s.type });
              images++;
            }
          } else {
            const read = await o.files.read(path);
            portrait ||= read.portrait;
            content.push({ type: "text", text: `Image ${path}:` }, { type: "image", data: Buffer.from(read.input.bytes).toString("base64"), mimeType: read.input.type });
            images++;
          }
        }
        const call = o.call();
        const runtime = await modelRuntimeFor(o.models, call);
        let label = "";
        const reply = await o.models.callWithFallback("vision", call, {}, async (resolution) => {
          signal?.throwIfAborted();
          if (resolution.endpoint.kind === "cloud") {
            if (isRestricted(o.call())) throw new CloudModelForbidden("This thread uses local models only.");
            if (portrait) await allowPortrait(o, resolution, id, ctx, signal, "look");
          }
          const { model } = piModelFor(runtime, o.models, "vision", call, resolution);
          o.models.recordCall(call.userId, { pool: call.pool, threadId: o.threadId, task: "vision", resolution, images });
          const { reply: r, pace } = await timedReply(runtime.streamSimple(model, {
            systemPrompt: SYSTEM,
            messages: [{ role: "user", content, timestamp: Date.now() }],
          }, { signal }), model.contextWindow);
          if (r.stopReason === "error") throw new Error(r.errorMessage ?? "the vision model failed");
          if (r.stopReason === "aborted") throw new Error("The look was stopped.");
          if (pace) o.models.recordPace(call.userId, o.threadId, pace, "vision", call.pool);
          label = resolution.label;
          return r;
        });
        const text = reply.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("").trim();
        if (!text) throw new Error(`${label} gave no answer. Ask again, or tell them you couldn't look.`);
        return { content: [{ type: "text" as const, text: `${label} sees:\n\n${text}` }], details: { model: label, images } };
      },
    });
  };
}
