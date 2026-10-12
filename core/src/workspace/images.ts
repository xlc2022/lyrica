// Principles 2 and 4: image bytes live in the user's mounted encrypted home.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { cleanPng, type GeneratedImage, type ImageInput } from "../models/images.ts";
import { sniffImage } from "./ops.ts";
import { WORKDIR } from "./sandbox.ts";

export const PHOTOS_DIR = "/photos-of-me";
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export interface WorkspaceImage { input: ImageInput; portrait: boolean }

/** Open each directory without following symlinks, anchored to the mounted home.
 * Directory descriptors remain valid if the sandbox renames a directory meanwhile. */
function inDir<T>(home: string, parts: string[], create: boolean, run: (fd: number) => T): T {
  let fd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts) {
      if (!part || part === "." || part === ".." || part.includes("/")) throw new Error("invalid image path");
      const path = `/proc/self/fd/${fd}/${part}`;
      if (create) {
        try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      }
      const next = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
    }
    return run(fd);
  } finally { closeSync(fd); }
}

function imageInput(bytes: Buffer): ImageInput {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("an input image is at most 20 MB");
  const type = sniffImage(bytes);
  if (type !== "image/png" && type !== "image/jpeg" && type !== "image/webp") throw new Error("an input image must be PNG, JPEG or WebP");
  return { bytes, type };
}

/** Created outside thread folders so a sandbox can't copy portraits without the tool's policy check. */
export function ensurePhotosDir(home: string): void { inDir(home, ["photos-of-me"], true, () => {}); }

export class ThreadImages {
  /** home must check the key and mount on every access; thread names its relative folder in that home. */
  constructor(private readonly home: () => string, private readonly thread: () => string[],
    private readonly readWorkspace: (path: string) => Promise<{ stream: Readable; size: number }>) {}

  async read(path: string): Promise<WorkspaceImage> {
    const home = this.home();
    // Photos have a reserved tool path, never a sandbox grant. Don't normalise away a traversal.
    const raw = path.startsWith("photos-of-me/") ? `/${path}` : path;
    if (raw === PHOTOS_DIR || raw.startsWith(`${PHOTOS_DIR}/`)) {
      const parts = raw.slice(1).split("/");
      const name = parts.pop()!;
      if (!name || name === "." || name === ".." || parts.some(p => !p || p === "." || p === "..")) throw new Error("invalid portrait path");
      const bytes = inDir(home, parts, false, fd => {
        const file = openSync(`/proc/self/fd/${fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(file);
          if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error("a portrait must be an image file of at most 20 MB");
          return readFileSync(file);
        } finally { closeSync(file); }
      });
      return { input: imageInput(bytes), portrait: true };
    }
    const file = await this.readWorkspace(path);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      if (file.size > MAX_IMAGE_BYTES) throw new Error("an input image is at most 20 MB");
      for await (const chunk of file.stream) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > MAX_IMAGE_BYTES) throw new Error("an input image is at most 20 MB");
        chunks.push(bytes);
      }
    } finally { file.stream.destroy(); }
    return { input: imageInput(Buffer.concat(chunks)), portrait: false };
  }

  /** Exclusive PNG names, no sidecars or prompt metadata, and no writes through a symlink. */
  save(images: GeneratedImage[]): string[] {
    return inDir(this.home(), [...this.thread(), "images"], true, dir => images.map(image => {
      const png = cleanPng(image.bytes);
      const name = `${randomUUID()}.png`;
      const fd = openSync(`/proc/self/fd/${dir}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, png.bytes); } finally { closeSync(fd); }
      return posix.join(WORKDIR, "images", name);
    }));
  }
}
