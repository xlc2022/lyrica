// Principles 2 and 4: image bytes live in the user's mounted encrypted home.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { cleanPng, type GeneratedImage, type ImageInput } from "../models/images.ts";
import { sniffImage } from "./ops.ts";
import { WORKDIR } from "./sandbox.ts";
import type { WorkspaceSettings } from "./settings.ts";

export const PHOTOS_DIR = "/photos-of-me";
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export interface WorkspaceImage { input: ImageInput; portrait: boolean }
export interface HomeFile { stream: Readable; size: number; type: string }
export interface PortraitPhoto { path: string; size: number; type: string }
export class HomeFileMissing extends Error {}

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

function partsOf(path: string): string[] {
  const parts = path.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p.includes("\\") || p.includes("\0"))) throw new HomeFileMissing("file not found");
  return parts;
}

function fileIn<T>(home: string, parts: string[], run: (fd: number, name: string) => T): T {
  if (!parts.length || parts.some(p => partsOf(p).length !== 1)) throw new HomeFileMissing("file not found");
  try { return inDir(home, parts.slice(0, -1), false, fd => run(fd, parts.at(-1)!)); }
  catch (err) {
    if (["ENOENT", "ELOOP", "ENOTDIR", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) throw new HomeFileMissing("file not found");
    throw err;
  }
}

/** Principle 2: serve an anchored regular file, never a grant or a symlink. */
function readHomeFile(home: string, parts: string[]): HomeFile {
  return fileIn(home, parts, (dir, name) => {
    const fd = openSync(`/proc/self/fd/${dir}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new HomeFileMissing("file not found");
      const head = Buffer.alloc(Math.min(512, stat.size)); readSync(fd, head, 0, head.length, 0);
      const type = sniffImage(head) ?? (head.subarray(0, 5).toString() === "%PDF-" ? "application/pdf" :
        !head.includes(0) && !head.toString("utf8").includes("\uFFFD") ? "text/plain; charset=utf-8" : "application/octet-stream");
      return { stream: createReadStream("", { fd, autoClose: true, start: 0 }), size: stat.size, type };
    } catch (err) { closeSync(fd); throw err; }
  });
}

/** Strip source metadata before portraits are written into the encrypted home. */
function cleanPortrait(bytes: Buffer, type: string): Buffer {
  if (type === "image/png") return Buffer.from(cleanPng(bytes).bytes);
  if (type === "image/jpeg") {
    const chunks = [bytes.subarray(0, 2)]; let i = 2, scan = false;
    while (i < bytes.length) {
      if (scan) {
        const start = i;
        // Entropy bytes, stuffed FF00 and restart markers belong to the image.
        while (i < bytes.length) {
          if (bytes[i] !== 0xff) { i++; continue; }
          let next = i + 1; while (bytes[next] === 0xff) next++;
          const marker = bytes[next];
          if (marker === 0 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) { i = next + 1; continue; }
          break;
        }
        chunks.push(bytes.subarray(start, i)); scan = false;
      }
      if (bytes[i] !== 0xff) throw new Error("invalid JPEG");
      const start = i; while (bytes[i] === 0xff) i++;
      const marker = bytes[i++]!;
      if (marker === 0xd9) { chunks.push(bytes.subarray(start, i)); return Buffer.concat(chunks); }
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) { chunks.push(bytes.subarray(start, i)); continue; }
      if (i + 2 > bytes.length) throw new Error("invalid JPEG");
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) throw new Error("invalid JPEG");
      if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) chunks.push(bytes.subarray(start, i + length));
      i += length;
      scan = marker === 0xda;
    }
    throw new Error("invalid JPEG");
  }
  const chunks = [Buffer.from(bytes.subarray(0, 12))]; let i = 12;
  while (i < bytes.length) {
    if (i + 8 > bytes.length) throw new Error("invalid WebP");
    const name = bytes.subarray(i, i + 4).toString(); const size = bytes.readUInt32LE(i + 4); const end = i + 8 + size + (size % 2);
    if (end > bytes.length) throw new Error("invalid WebP");
    if (["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"].includes(name)) {
      const chunk = Buffer.from(bytes.subarray(i, end));
      if (name === "VP8X") { if (size < 10) throw new Error("invalid WebP"); chunk[8] = chunk[8]! & ~0x2c; }
      chunks.push(chunk);
    }
    i = end;
  }
  const result = Buffer.concat(chunks); result.writeUInt32LE(result.length - 8, 4); return result;
}

export class PortraitPhotos {
  constructor(private readonly home: () => string) {}
  /** A single portrait for the owner's thumbnails and downloads. */
  content(name: string): HomeFile {
    const parts = partsOf(name); if (parts.length !== 1) throw new HomeFileMissing("file not found");
    const file = readHomeFile(this.home(), ["photos-of-me", ...parts]);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      file.stream.destroy(); throw new HomeFileMissing("file not found");
    }
    return file;
  }
  list(): PortraitPhoto[] {
    const home = this.home();
    return inDir(home, ["photos-of-me"], false, dir => readdirSync(`/proc/self/fd/${dir}`).flatMap(name => {
      try {
        const file = readHomeFile(home, ["photos-of-me", ...partsOf(name)]); file.stream.destroy();
        return ["image/png", "image/jpeg", "image/webp"].includes(file.type) ? [{ path: `${PHOTOS_DIR}/${name}`, size: file.size, type: file.type }] : [];
      } catch (err) { if (err instanceof HomeFileMissing) return []; throw err; }
    }).sort((a, b) => a.path.localeCompare(b.path)));
  }
  upload(bytes: Buffer): string {
    const home = this.home(); const { type } = imageInput(bytes); const clean = cleanPortrait(bytes, type);
    const name = `${randomUUID()}.${type === "image/jpeg" ? "jpg" : type.slice(6)}`;
    return inDir(home, ["photos-of-me"], false, dir => {
      const fd = openSync(`/proc/self/fd/${dir}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, clean); } finally { closeSync(fd); }
      return `${PHOTOS_DIR}/${name}`;
    });
  }
  remove(name: string): void {
    const parts = partsOf(name); if (parts.length !== 1) throw new HomeFileMissing("file not found");
    const home = this.home(); const file = readHomeFile(home, ["photos-of-me", ...parts]); file.stream.destroy();
    fileIn(home, ["photos-of-me", ...parts], (dir, base) => unlinkSync(`/proc/self/fd/${dir}/${base}`));
  }
}

export class ThreadImages {
  /** home must check the key and mount on every access; thread names its relative folder in that home. */
  constructor(private readonly home: () => string, private readonly thread: () => string[],
    private readonly readWorkspace: (path: string) => Promise<{ stream: Readable; size: number }>,
    private readonly portraits: Pick<WorkspaceSettings, "isPortraitImage" | "recordPortraitImage">,
    /** Hears of the images saved, as she sees their paths. */
    private readonly made: (paths: string[]) => void = () => {}) {}

  content(path: string): HomeFile {
    const home = this.home();
    const relative = path.startsWith(`${WORKDIR}/`) ? path.slice(WORKDIR.length + 1) : path;
    return readHomeFile(home, [...this.thread(), ...partsOf(relative)]);
  }

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
    const bytes = Buffer.concat(chunks);
    return { input: imageInput(bytes), portrait: this.portraits.isPortraitImage(createHash("sha256").update(bytes).digest("hex")) };
  }

  /** Exclusive PNG names, no sidecars or prompt metadata, and no writes through a symlink. */
  save(images: GeneratedImage[], portrait = false): string[] {
    const paths = inDir(this.home(), [...this.thread(), "images"], true, dir => images.map(image => {
      const png = cleanPng(image.bytes);
      // Record before publishing the bytes so concurrent readers cannot miss the policy.
      if (portrait) this.portraits.recordPortraitImage(createHash("sha256").update(png.bytes).digest("hex"));
      const name = `${randomUUID()}.png`;
      const fd = openSync(`/proc/self/fd/${dir}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, png.bytes); } finally { closeSync(fd); }
      return posix.join(WORKDIR, "images", name);
    }));
    this.made(paths);
    return paths;
  }
}
