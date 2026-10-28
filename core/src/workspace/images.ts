// Principles 2 and 4: image bytes live in the user's mounted encrypted home.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { cleanPng, type GeneratedImage, type ImageInput } from "../models/images.ts";
import { isMp4, type GeneratedVideo } from "../models/videos.ts";
import { sniffImage } from "./ops.ts";
import { WORKDIR } from "./sandbox.ts";
import type { WorkspaceSettings } from "./settings.ts";

export const PHOTOS_DIR = "/photos-of-me";
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Where a thread's rejected attempts go, inside its images folder. */
export const REJECTED_DIR = "rejected";
/** A name the image tool gave (`save`): only these can be rejected or picked. */
const MADE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;
export interface WorkspaceImage { input: ImageInput; portrait: boolean }
export interface HomeFile { stream: Readable; size: number; type: string }
/** Bytes `start` to `end`, both included, as a Range request asks; past the end is cut to it. */
export interface ByteRange { start: number; end?: number }
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
function readHomeFile(home: string, parts: string[], range?: ByteRange): HomeFile {
  return fileIn(home, parts, (dir, name) => {
    const fd = openSync(`/proc/self/fd/${dir}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new HomeFileMissing("file not found");
      const head = Buffer.alloc(Math.min(512, stat.size)); readSync(fd, head, 0, head.length, 0);
      const type = sniffImage(head) ?? (isMp4(head) ? "video/mp4" : head.subarray(0, 5).toString() === "%PDF-" ? "application/pdf" :
        !head.includes(0) && !head.toString("utf8").includes("\uFFFD") ? "text/plain; charset=utf-8" : "application/octet-stream");
      if (range && (range.start >= stat.size || (range.end !== undefined && range.end < range.start))) throw new RangeError("the range is outside the file");
      const end = range ? { start: range.start, end: Math.min(range.end ?? stat.size - 1, stat.size - 1) } : { start: 0 };
      return { stream: createReadStream("", { fd, autoClose: true, ...end }), size: stat.size, type };
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
    private readonly made: (paths: string[]) => void = () => {},
    /** Whether images go to the thread's shared/ (a project chat's, read by its threads at /shared) instead of images/. */
    private readonly shared: () => boolean = () => false,
    /** Hears of an image moved by reject or pick, as she sees both paths, so its record of who made it moves along. */
    private readonly moved: (from: string, to: string) => void = () => {},
    /** Hears of the rejects clearRejected deleted, as she saw their paths, so their records go too. */
    private readonly removed: (paths: string[]) => void = () => {}) {}

  private folder(kind: "images" | "videos" = "images"): string[] { return this.shared() ? ["shared", kind] : [kind]; }

  /**
   * One of her made images by the path she names, in the images folder or its rejected/: the file's name and
   * whether it is rejected now. A path given in the images folder that has since been rejected is found there.
   */
  private attempt(path: string): { name: string; rejected: boolean } {
    const relative = path.startsWith(`${WORKDIR}/`) ? path.slice(WORKDIR.length + 1) : path.replace(/^\.\//, "");
    const folder = this.folder().join("/");
    const name = posix.basename(relative);
    const dir = posix.dirname(relative);
    if (!MADE_NAME.test(name) || (dir !== folder && dir !== `${folder}/${REJECTED_DIR}`)) {
      throw new Error(`only images the image tool made in ${folder}/ can be rejected or picked`);
    }
    const base = [...this.thread(), ...this.folder()];
    const there = (parts: string[]) => {
      try { return inDir(this.home(), parts, false, fd => lstatSync(`/proc/self/fd/${fd}/${name}`).isFile()); }
      catch (err) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes((err as NodeJS.ErrnoException).code ?? "")) return false; throw err; }
    };
    const inRejected = there([...base, REJECTED_DIR]);
    if (dir === folder && there(base)) return { name, rejected: false };
    if (inRejected) return { name, rejected: true };
    if (dir !== folder && there(base)) return { name, rejected: false };
    throw new Error(`${path} isn't there`);
  }

  /** Moves a made image between the images folder and its rejected/, taking its thumbnail and record along. */
  private move(name: string, reject: boolean): string {
    const base = [...this.thread(), ...this.folder()];
    const [fromDir, toDir] = reject ? [base, [...base, REJECTED_DIR]] : [[...base, REJECTED_DIR], base];
    inDir(this.home(), fromDir, false, from => inDir(this.home(), toDir, true, to => {
      const target = `/proc/self/fd/${to}/${name}`;
      try { lstatSync(target); throw new Error(`${name} is already in ${reject ? REJECTED_DIR : "the images folder"}`); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      renameSync(`/proc/self/fd/${from}/${name}`, target);
    }));
    const seen = (dir: string[]) => posix.join(WORKDIR, ...dir.slice(this.thread().length), name);
    // The panel keeps a thumbnail per path (ThreadFiles.thumb); the old path's goes now rather than at its next prune.
    const thumbs = [...this.thread(), ".lyrica", "thumbs", ...fromDir.slice(this.thread().length)];
    for (const file of [name, `${name}.png`, `${name}.jpg`]) {
      try { inDir(this.home(), thumbs, false, fd => unlinkSync(`/proc/self/fd/${fd}/${file}`)); } catch { /* none kept */ }
    }
    this.moved(seen(fromDir), seen(toDir));
    return seen(toDir);
  }

  /**
   * Sets her attempts aside in the images folder's rejected/, all or none: each must carry the tool's own uuid name
   * in this thread's images folder. One already rejected stays where it is. Returns where each is now.
   */
  reject(paths: string[]): string[] {
    const found = paths.map(p => this.attempt(p));
    const done: string[] = [];
    try {
      return found.map(f => {
        if (f.rejected) return posix.join(WORKDIR, ...this.folder(), REJECTED_DIR, f.name);
        const to = this.move(f.name, true); done.push(f.name); return to;
      });
    } catch (err) {
      for (const name of done) { try { this.move(name, false); } catch { /* left rejected */ } }
      throw err;
    }
  }

  /**
   * Deletes, for good, every attempt in the images folder's rejected/ that the tool made, with its thumbnail, and the
   * folder once empty. Anything else she put there stays. Returns the paths deleted.
   */
  clearRejected(): string[] {
    const base = [...this.thread(), ...this.folder()];
    const thumbs = [...this.thread(), ".lyrica", "thumbs", ...this.folder(), REJECTED_DIR];
    let names: string[];
    try {
      names = inDir(this.home(), [...base, REJECTED_DIR], false, fd => readdirSync(`/proc/self/fd/${fd}`).filter(n => MADE_NAME.test(n) && lstatSync(`/proc/self/fd/${fd}/${n}`).isFile()).map(n => {
        unlinkSync(`/proc/self/fd/${fd}/${n}`); return n;
      }));
    } catch (err) { if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return []; throw err; }
    for (const n of names) for (const file of [n, `${n}.png`, `${n}.jpg`]) {
      try { inDir(this.home(), thumbs, false, fd => unlinkSync(`/proc/self/fd/${fd}/${file}`)); } catch { /* none kept */ }
    }
    try { inDir(this.home(), base, false, fd => rmdirSync(`/proc/self/fd/${fd}/${REJECTED_DIR}`)); } catch { /* not empty */ }
    const paths = names.map(n => posix.join(WORKDIR, ...this.folder(), REJECTED_DIR, n));
    if (paths.length) this.removed(paths);
    return paths;
  }

  /** Her pick among her attempts: a rejected one comes back to the images folder. Returns its path there. */
  pick(path: string): string {
    const f = this.attempt(path);
    return f.rejected ? this.move(f.name, false) : posix.join(WORKDIR, ...this.folder(), f.name);
  }

  content(path: string, range?: ByteRange): HomeFile {
    const home = this.home();
    const relative = path.startsWith(`${WORKDIR}/`) ? path.slice(WORKDIR.length + 1) : path;
    return readHomeFile(home, [...this.thread(), ...partsOf(relative)], range);
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
    const folder = this.folder();
    const paths = inDir(this.home(), [...this.thread(), ...folder], true, dir => images.map(image => {
      const png = cleanPng(image.bytes);
      // Record before publishing the bytes so concurrent readers cannot miss the policy.
      if (portrait) this.portraits.recordPortraitImage(createHash("sha256").update(png.bytes).digest("hex"));
      const name = `${randomUUID()}.png`;
      const fd = openSync(`/proc/self/fd/${dir}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, png.bytes); } finally { closeSync(fd); }
      return posix.join(WORKDIR, ...folder, name);
    }));
    this.made(paths);
    return paths;
  }

  /**
   * A clip under an exclusive MP4 name in videos/ (shared/videos/ in a project chat), with its poster as the clip's
   * thumbnail (`.lyrica/thumbs/<its path>.png`, as ThreadFiles.thumb keeps one), so deleting the clip deletes it.
   */
  saveVideo(video: GeneratedVideo): string {
    if (!isMp4(video.bytes)) throw new Error("a clip must be an MP4");
    const folder = this.folder("videos"), name = `${randomUUID()}.mp4`;
    const write = (dir: number, file: string, bytes: Uint8Array) => {
      const fd = openSync(`/proc/self/fd/${dir}/${file}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    };
    // The poster first: the panel then never sees a clip without its thumbnail.
    inDir(this.home(), [...this.thread(), ".lyrica", "thumbs", ...folder], true, dir => write(dir, `${name}.png`, cleanPng(video.poster.bytes).bytes));
    inDir(this.home(), [...this.thread(), ...folder], true, dir => write(dir, name, video.bytes));
    const path = posix.join(WORKDIR, ...folder, name);
    this.made([path]);
    return path;
  }
}
