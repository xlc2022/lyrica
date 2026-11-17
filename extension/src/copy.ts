// Principles 8 and 6: a file on one of her machines reaches the person through her thread's folder, never through her
// context. The bytes go machine → sandbox inside lyricad, piece by piece, so even a large clip only ever holds one
// piece in memory; she gets one line, and links the path, which the file viewer shows whatever it is (Markdown, code,
// an image, a clip, a PDF).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { WORKDIR } from "@lyrica/core";
import { posix } from "node:path";
import { Type, type Static } from "typebox";
import { recording, type ThreadTools } from "./workspace.ts";

/** The largest file copied (the user chose 2 GiB, 2026-11-17). */
export const COPY_LIMIT = 2 * 1024 * 1024 * 1024;
/** One piece of a copy: what is in memory at a time. A copy of one piece is undone with its turn. */
export const COPY_CHUNK = 8 * 1024 * 1024;
/** Where copies go in her folder, by machine (the user asked, 2026-11-17). */
export const COPIED = `${WORKDIR}/copied`;

export const copyParameters = Type.Object({
  machine: Type.String({ description: "The machine the file is on, by name." }),
  path: Type.String({ description: "The file on that machine." }),
  keep: Type.Optional(Type.Boolean({ description: "Keep the copy already there and add this one beside it, its name ending in the time. Without it, a copy replaces the last one." })),
});
export type CopyArgs = Static<typeof copyParameters>;

/** A name with the time before its extension: report-20261117-0438.md. */
function stamped(path: string, now: Date): string {
  const ext = posix.extname(path), stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `${path.slice(0, path.length - ext.length)}-${stamp}${ext}`;
}

/** Where a copy lands: copied/<machine>/ then the file's path on the machine. */
export const copyDestination = (machine: string, source: string, keep = false, now = new Date()) => {
  const dest = posix.join(COPIED, machine, posix.resolve("/", source));
  return keep ? stamped(dest, now) : dest;
};

const size = (n: number) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB` : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`);
/** A private key's armour; a copy that holds one is refused rather than handed to the sandbox. */
const KEY = /PRIVATE KEY(?: BLOCK)?-----/;

/**
 * The copy tool. Its gate (the machine's limit, asking where write asks, the same-file hold on the destination) is the
 * workspace extension's; `check` throws if the call isn't what was approved.
 */
export function copyTool(tools: ThreadTools, check: (id: string, input: Record<string, unknown>, machine: string, cwd?: string) => void): ToolDefinition {
  return {
    name: "copy",
    label: "Copy",
    description: `Copy a file from one of your machines into ${COPIED}/<machine>/, under the path it has there, without reading it: you get one line back, so it costs no context. `
      + `Any file up to ${COPY_LIMIT / 1024 / 1024 / 1024} GiB: a report, code, an image, a clip, a PDF. Copying again replaces the copy; keep: true adds one beside it instead.`,
    promptSnippet: "copy a file from one of your machines into your folder, to show the person",
    promptGuidelines: [
      "Write a report, notes or anything else meant for the person in your own folder, not on a machine you're working on.",
      "To show the person a file on a machine, copy it and give the copy's path in your reply; when they ask for it again after it changed, copy it again.",
    ],
    parameters: copyParameters,
    async execute(id, p: CopyArgs, signal) {
      const from = tools.target(p.machine);
      const box = tools.target();
      const home = await from.cwd();
      check(id, { path: p.path, ...(p.keep ? { keep: true } : {}) }, p.machine, home);
      if (!from.readChunks || !box.ops().write.appendFile) throw new Error("copy needs an SSH machine and the sandbox.");
      const source = posix.resolve(home, p.path);
      const dest = copyDestination(p.machine, source, p.keep);
      const write = box.ops().write;
      await write.mkdir(posix.dirname(dest));
      let total = 0, written = 0, tail = "";
      try {
        await from.readChunks(source, COPY_CHUNK, {
          signal,
          onSize: (n) => {
            total = n;
            if (n > COPY_LIMIT) throw new Error(`${p.machine}:${source} is ${size(n)}; copy takes at most ${COPY_LIMIT / 1024 / 1024 / 1024} GiB.`);
          },
          onChunk: async (piece) => {
            // A key split across two pieces is still seen: the end of the last piece goes in front of this one.
            const seen = tail + piece.toString("latin1");
            if (KEY.test(seen)) throw new Error(`${p.machine}:${source} holds a private key, so it isn't copied.`);
            tail = seen.slice(-64);
            // One piece is the whole file: written as write writes, so it is undone with its turn.
            if (written === 0 && piece.length === total) await recording(box, write, id, tools.recordChange).writeFile(dest, piece);
            else if (written === 0) await write.writeFile(dest, piece);
            else await write.appendFile!(dest, piece);
            written += piece.length;
          },
        });
        // An empty file has no pieces.
        if (total === 0) await recording(box, write, id, tools.recordChange).writeFile(dest, Buffer.alloc(0));
      } catch (err) {
        // A copy cut short is not left looking whole.
        if (written > 0) await write.writeFile(dest, Buffer.alloc(0)).catch(() => undefined);
        throw err;
      }
      tools.madeFiles?.([dest]);
      return { content: [{ type: "text", text: `Copied ${p.machine}:${source} to ${dest} (${size(total)}). Give ${dest} in your reply to show it.` }], details: undefined };
    },
  } as ToolDefinition;
}
