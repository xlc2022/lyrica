// Principles 8 and 6: a file on one of her machines reaches the person through her thread's folder, never through her
// context. The bytes go machine → sandbox inside lyricad; she gets one line, and links the path, which the file viewer
// shows whatever it is (Markdown, code, an image, a clip, a PDF).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import { Type, type Static } from "typebox";
import { recording, type ThreadTools } from "./workspace.ts";

/** The largest file copied: anything bigger stays on the machine. */
export const COPY_LIMIT = 512 * 1024 * 1024;

export const copyParameters = Type.Object({
  machine: Type.String({ description: "The machine the file is on, by name." }),
  path: Type.String({ description: "The file on that machine." }),
  to: Type.Optional(Type.String({ description: "Where in your folders to put it; the file's name in your current folder if left out. An existing file there is replaced." })),
});
export type CopyArgs = Static<typeof copyParameters>;

/** Where a copy lands: `to` against the sandbox's folder, or the file's name there. */
export const copyDestination = (cwd: string, p: Pick<CopyArgs, "path" | "to">) => posix.resolve(cwd, p.to || posix.basename(p.path));

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`);

/** The copy tool. Its gate (the machine's limit, asking where write asks, the same-file hold) is the workspace extension's; `check` throws if the call isn't what was approved. */
export function copyTool(tools: ThreadTools, check: (id: string, input: Record<string, unknown>, machine: string, cwd?: string) => void): ToolDefinition {
  return {
    name: "copy",
    label: "Copy",
    description: "Copy a file from one of your machines into your folders, without reading it: you get one line back, so it costs no context. "
      + `Any file up to ${COPY_LIMIT / 1024 / 1024} MiB: a report, code, an image, a clip, a PDF. Copying again replaces the copy; give another to to keep both.`,
    promptSnippet: "copy a file from one of your machines into your folders, to show the person",
    promptGuidelines: [
      "Write a report, notes or anything else meant for the person in your own folder, not on a machine you're working on.",
      "To show the person a file on a machine, copy it into your folder and give its path in your reply; when they ask for it again after it changed, copy it again.",
    ],
    parameters: copyParameters,
    async execute(id, p: CopyArgs) {
      const from = tools.target(p.machine);
      const box = tools.target();
      const cwd = await box.cwd();
      check(id, { path: p.path, ...(p.to ? { to: p.to } : {}) }, p.machine, await from.cwd());
      const source = posix.resolve(await from.cwd(), p.path);
      const dest = copyDestination(cwd, p);
      const bytes = await from.ops().read.readFile(source);
      if (bytes.length > COPY_LIMIT) throw new Error(`${p.machine}:${source} is ${size(bytes.length)}; copy takes at most ${COPY_LIMIT / 1024 / 1024} MiB.`);
      // Written as write writes: held by the same-file check before this, undone with its turn, and recorded as this thread's.
      const write = recording(box, box.ops().write, id, tools.recordChange);
      await write.mkdir(posix.dirname(dest));
      await write.writeFile(dest, bytes);
      tools.madeFiles?.([dest]);
      return { content: [{ type: "text", text: `Copied ${p.machine}:${source} to ${dest} (${size(bytes.length)}). Give ${dest} in your reply to show it.` }], details: undefined };
    },
  } as ToolDefinition;
}
