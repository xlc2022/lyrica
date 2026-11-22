// The thread's Files panel (DESIGN, "Files and images"): listing, searching,
// serving, uploading, renaming, deleting and zipping, every one of them run
// inside the thread's sandbox, so paths and symlinks resolve there and can't
// leave the thread's folder and its grants. Nothing is written outside them
// and no temp file is made on the host: the zip is built as it streams.
import { posix } from "node:path";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { readSearch, searchTest } from "../store/outputs.ts";
import type { ByteRange } from "./images.ts";
import { looksLikeText, sniffImage } from "./ops.ts";
import { SHARED, Sandbox, SandboxDenied, WORKDIR } from "./sandbox.ts";
import type { Grant } from "./settings.ts";

/** One row of a listing: `path` is the file's path as she sees it. */
export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "folder" | "link" | "other";
  size: number;
  /** ISO time of the last change. */
  modified: string;
}

/**
 * A top of the panel's tree: the thread's folder, the family's /shared, each granted folder, and in a project chat
 * each of its threads' folders (`member`, read-only, at /thread-workspaces/<id>, with that thread's id).
 */
export interface FileRoot { path: string; writable: boolean; kind: "thread" | "shared" | "grant" | "member"; threadId?: string }

export interface FileListing { entries: FileEntry[]; /** The listing stopped at the cap. */ more: boolean }

/**
 * An image or a clip in the thread's folder: uploaded by the person, or made by her. A clip's `seconds` is its length,
 * absent while unknown (no ffprobe, a file it can't read, or one not probed yet).
 */
export interface ImageEntry extends FileEntry { source: "uploaded" | "made"; seconds?: number }

/** The panel's own folder in the thread's: its thumbnails live under `.lyrica/thumbs`; never listed or searched. */
export const PANEL_DIR = ".lyrica";
export const THUMB_BOX = 320;
const THUMB_TIMEOUT_MS = 20_000;
/** The most stills the look tool takes from one clip, the longer side of each, and how long reading one may take. */
export const MAX_FRAMES = 16;
export const FRAME_SIDE = 768;
const FRAME_TIMEOUT_MS = 20_000;
/** Cutting a clip's end, or joining two clips: re-encoding a long 1080p clip on the server's CPU can take minutes. */
const CLIP_TIMEOUT_MS = 30 * 60_000;
/** The start of a script that needs ffmpeg: without it, exit 3. */
const NEEDS_FFMPEG = "command -v ffprobe >/dev/null && command -v ffmpeg >/dev/null || exit 3;";
export const LIST_LIMIT = 2000;
export const SEARCH_LIMIT = 200;
/** A regular expression search reads at most this many names under a root. */
export const REGEX_SCAN_LIMIT = 100_000;
/** At most this many clips are probed for their length in one listing; the rest are probed on the next. */
export const PROBE_LIMIT = 100;
export const ZIP_FILES_LIMIT = 10_000;
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
/** The clips the web's viewer plays. */
const VIDEO_EXTENSIONS = ["mp4", "webm"];
// Entries end in NUL, not newline: a name may hold a newline or a tab, so the
// path is everything after the fixed fields.
const PRINTF = String.raw`%y\t%s\t%T@\t%p\0`;
const ZIP_PRINTF = String.raw`%s\t%p\0`;

/** What the panel did to files, for the record of which thread wrote each (paths as she sees them). */
export interface OriginEvents { added?(paths: string[]): void; moved?(from: string, to: string): void; removed?(paths: string[]): void }

/** Thrown for a path the panel may not touch: a root itself, or one outside the thread's folders. */
export class FilesRefused extends Error {}

/** A zip being built: its stream, its exact length in bytes and how many files it holds. */
export interface ZipStream { stream: Readable; bytes: number; files: number }

interface ZipFile { path: string; name: Buffer; size: number }

/**
 * Reads a GNU tar stream one entry at a time: a regular file's name (a long one comes in an `L` entry before it) and
 * its data. Anything else in the stream (there should be nothing else) ends it.
 */
class TarReader {
  private readonly it: AsyncIterator<Buffer>;
  private held: Buffer = Buffer.alloc(0);
  constructor(stream: AsyncIterable<Buffer>) { this.it = stream[Symbol.asyncIterator](); }

  /** Up to `n` bytes as they come; throws if the stream ends first. */
  private async *bytes(n: number): AsyncGenerator<Buffer> {
    while (n > 0) {
      if (!this.held.length) {
        const r = await this.it.next();
        if (r.done) throw new Error("the read ended early");
        this.held = r.value;
      }
      const piece = this.held.subarray(0, n);
      this.held = this.held.subarray(piece.length);
      n -= piece.length;
      yield piece;
    }
  }

  private async block(n: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const p of this.bytes(n)) parts.push(p);
    return Buffer.concat(parts);
  }

  /** The next regular file's name and size, or undefined at the end of the archive. */
  async next(): Promise<{ name: string; size: number } | undefined> {
    let long: string | undefined;
    for (;;) {
      let header: Buffer;
      try { header = await this.block(512); } catch { return undefined; }
      if (header.every((b) => b === 0)) return undefined;
      const size = tarNumber(header.subarray(124, 136));
      const type = String.fromCharCode(header[156]!);
      if (type === "L") {
        const body = await this.block(Math.ceil(size / 512) * 512);
        long = body.subarray(0, size).toString("utf8").replace(/\0+$/, "");
        continue;
      }
      if (type !== "0" && type !== "\0") return undefined;
      const name = long ?? header.subarray(0, 100).toString("utf8").replace(/\0[\s\S]*$/, "");
      return { name, size };
    }
  }

  /** The entry's data, `size` bytes, then the padding to its block skipped. */
  async *data(size: number): AsyncGenerator<Buffer> {
    yield* this.bytes(size);
    const pad = (512 - (size % 512)) % 512;
    for await (const _ of this.bytes(pad)) { /* padding */ }
  }

  /** Reads the rest of the stream (the end blocks). */
  async drain(): Promise<void> {
    this.held = Buffer.alloc(0);
    for (;;) if ((await this.it.next()).done) return;
  }
}

/** A tar header's number: octal, or base-256 when its first byte's top bit is set. */
function tarNumber(field: Buffer): number {
  if (field[0]! & 0x80) return field.subarray(1).reduce((n, b) => n * 256 + b, field[0]! & 0x7f);
  return parseInt(field.toString("ascii").replace(/\0.*$/s, "").trim() || "0", 8);
}

/** The panel's operations for one thread, each a fresh sandbox run. */
export class ThreadFiles {
  /**
   * `note` records what the panel added or removed, for her next turn; `origins` hears of each upload, rename and
   * delete, so the record of which thread wrote a file follows it. `workdir` is the thread's folder (a test's
   * stand-in may put it elsewhere). `shared`: the box mounts the family's /shared, a root of its own. `members`: the
   * family members' folders shown as roots of their own (a project chat's threads), each where the box mounts it.
   */
  constructor(private readonly box: Sandbox, private readonly grants: Grant[], private readonly note: (kind: "added" | "removed" | "renamed", names: string[]) => void = () => {},
    private readonly workdir = WORKDIR, private readonly origins: OriginEvents = {}, private readonly shared = false,
    private readonly members: { threadId: string; dest: string }[] = []) {}

  roots(): FileRoot[] {
    return [{ path: WORKDIR, writable: true, kind: "thread" }, ...this.shared ? [{ path: SHARED, writable: true, kind: "shared" as const }] : [],
      ...this.grants.map((g) => ({ path: g.path, writable: g.writable, kind: "grant" as const })),
      ...this.members.map((m) => ({ path: m.dest, writable: false, kind: "member" as const, threadId: m.threadId }))];
  }

  private allow(path: string, write: boolean): string {
    try {
      return this.box.allow(path, write);
    } catch (err) {
      throw err instanceof SandboxDenied ? new FilesRefused(err.message) : err;
    }
  }

  /** A path that is one of the roots can't be renamed or deleted. */
  private inside(path: string): string {
    const p = this.allow(path, true);
    if (this.roots().some((r) => r.path === p)) throw new FilesRefused(`${p} is one of this thread's folders itself`);
    if (posix.basename(p) === PANEL_DIR) throw new FilesRefused(`${PANEL_DIR} is the panel's own folder`);
    return p;
  }

  /** One folder's entries, folders first, stopping at the cap. */
  async list(dir: string): Promise<FileListing> {
    const d = this.allow(dir, false);
    // The panel lists the thread's folder again after each of her tool calls: the moment to drop what she deleted.
    if (d === WORKDIR) void this.pruneThumbs().catch(() => {});
    const out = await this.find(["find", d, "-mindepth", "1", "-maxdepth", "1", "!", "-name", PANEL_DIR, "-printf", PRINTF], LIST_LIMIT);
    out.entries.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Files and folders under `root` by name, case ignored, stopping at the cap, the query read as a search box reads it
   * (`readSearch`): text the name contains, a wildcard pattern the whole name fits (`*.txt`, through find's own
   * `-iname`), or `/…/` a regular expression (RE2) matched in lyricad against each of the first REGEX_SCAN_LIMIT names
   * under the root; `more` then also says names went unread.
   */
  async search(root: string, query: string): Promise<FileListing> {
    const r = this.allow(root, false);
    const q = query.trim();
    if (!q) return { entries: [], more: false };
    const read = readSearch(q);
    if (read.kind === "glob") {
      return this.find(["find", r, "-mindepth", "1", "-name", PANEL_DIR, "-prune", "-o", "-iname", read.glob.replace(/[\\[\]]/g, "\\$&"), "-printf", PRINTF], SEARCH_LIMIT);
    }
    if (read.kind === "regex") {
      const test = searchTest(read, true);
      const all = await this.find(["find", r, "-mindepth", "1", "-name", PANEL_DIR, "-prune", "-o", "-printf", PRINTF], REGEX_SCAN_LIMIT);
      const hits = all.entries.filter((e) => test(e.name));
      return { entries: hits.slice(0, SEARCH_LIMIT), more: all.more || hits.length > SEARCH_LIMIT };
    }
    const pattern = `*${q.replace(/[\\*?[\]]/g, "\\$&")}*`;
    return this.find(["find", r, "-mindepth", "1", "-name", PANEL_DIR, "-prune", "-o", "-iname", pattern, "-printf", PRINTF], SEARCH_LIMIT);
  }

  /** Every image in the thread's folder, uploaded ones told from hers. */
  images(): Promise<ImageEntry[]> { return this.media(IMAGE_EXTENSIONS); }

  /** Every clip in the thread's folder, uploaded ones told from hers. */
  async videos(): Promise<ImageEntry[]> {
    const entries = await this.media(VIDEO_EXTENSIONS);
    const seconds = await this.lengths(entries.map((e) => e.path)).catch(() => []);
    return entries.map((e, i) => (seconds[i] === undefined ? e : { ...e, seconds: seconds[i] }));
  }

  private async media(extensions: string[]): Promise<ImageEntry[]> {
    const names = extensions.flatMap((e, i) => [...(i ? ["-o"] : []), "-iname", `*.${e}`]);
    void this.pruneThumbs().catch(() => {});
    const { entries } = await this.find(["find", this.workdir, "-name", PANEL_DIR, "-prune", "-o", "-type", "f", "(", ...names, ")", "-printf", PRINTF], LIST_LIMIT);
    return entries.map((e) => ({ ...e, source: e.path.startsWith(`${this.workdir}/uploads/`) ? "uploaded" : "made" }));
  }

  /**
   * Each clip's length in seconds, in order, from ffprobe inside the sandbox. A length is kept beside the clip's poster
   * (`.lyrica/thumbs/<its path>.seconds`) until the clip is newer, so a clip is probed once, and at most PROBE_LIMIT
   * new ones in a call; one it can't read is kept as unknown. Without ffprobe, none is known.
   */
  private async lengths(paths: string[]): Promise<(number | undefined)[]> {
    if (!paths.length) return [];
    const script = 'command -v ffprobe >/dev/null && command -v timeout >/dev/null || exit 0; w=$1; n=$2; p=$3; shift 3; for f; do c=$w/$p/thumbs/${f#"$w"/}.seconds; ' +
      'if [ -f "$c" ] && [ ! "$f" -nt "$c" ]; then d=$(cat -- "$c"); elif [ "$n" -gt 0 ]; then n=$((n-1)); ' +
      'd=$(timeout 10 ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 -- "$f" 2>/dev/null) || d=; ' +
      'mkdir -p -- "$(dirname -- "$c")" && printf %s "$d" > "$c"; else d=; fi; printf "%s\\0" "$d"; done';
    const out = await this.file(["sh", "-c", script, "sh", this.workdir, String(PROBE_LIMIT), PANEL_DIR, ...paths]);
    return out.toString().split("\0").slice(0, paths.length).map((d) => { const n = Number.parseFloat(d); return Number.isFinite(n) && n > 0 ? n : undefined; });
  }

  /**
   * A file's bytes as a stream, with its whole size and type. The caller
   * sends it as is. With a range only those bytes come (a clip seeks with
   * one); a range past the end or backwards is a RangeError.
   */
  async read(path: string, range?: ByteRange): Promise<{ stream: Readable; size: number; type: string }> {
    const p = this.allow(path, false);
    const head = await this.file(["sh", "-c", 'test -f "$1" || { echo "$1 is not a file" >&2; exit 1; }; stat -c %s -- "$1"; head -c 512 -- "$1"', "sh", p]);
    const nl = head.indexOf(10);
    const size = Number(head.subarray(0, nl).toString());
    const type = sniffImage(head.subarray(nl + 1)) ?? typeByName(p, head.subarray(nl + 1));
    if (range && (range.start >= size || (range.end !== undefined && range.end < range.start))) throw new RangeError("the range is outside the file");
    const length = range ? Math.min(range.end ?? size - 1, size - 1) - range.start + 1 : 0;
    const child = await this.box.start(range
      ? ["sh", "-c", 'tail -c +"$2" -- "$1" | head -c "$3"', "sh", p, String(range.start + 1), String(length)]
      : ["cat", "--", p]);
    const err: Buffer[] = [];
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("close", (code) => { if (code !== 0) child.stdout.destroy(new Error(Buffer.concat(err).toString().trim() || "could not read the file")); });
    child.stdin.end();
    return { stream: child.stdout, size, type };
  }

  /**
   * A small copy of an image in the thread's folder, at most THUMB_BOX on a
   * side, made by ImageMagick inside the sandbox and kept under
   * `.lyrica/thumbs/<its path>.png` (or `.jpg` for a JPEG) until the image
   * is newer; a renamed image takes its copy along, and a deleted one
   * deletes it, at once from the panel, otherwise when its copy is next
   * asked for or the panel next lists the thread's folder (pruneThumbs). A
   * clip (`.mp4`) has the poster it was made with, or none. Only a
   * file named like an image, decoded as what its name says (a `.png`
   * holding something else fails rather than runs), within memory, size
   * and time limits. Without ImageMagick, for a file outside the thread's
   * folder, or for a name that is not an image's, `undefined`: the panel
   * shows the file itself.
   */
  async thumb(path: string): Promise<{ bytes: Buffer; type: string } | undefined> {
    const p = this.allow(path, false);
    const cache = this.thumbPath(p);
    const ext = posix.extname(p).slice(1).toLowerCase();
    // A clip's thumbnail is its poster, kept when it was made (ThreadImages.saveVideo); none is made here.
    if (cache && ext === "mp4") {
      const r = await this.box.run(["sh", "-c", 'test -f "$1" && test -f "$2" && cat -- "$2"', "sh", p, `${cache}.png`], { timeoutMs: THUMB_TIMEOUT_MS });
      return r.code === 0 && r.stdout.length ? { bytes: r.stdout, type: "image/png" } : undefined;
    }
    if (!cache || !IMAGE_EXTENSIONS.includes(ext)) return undefined;
    const jpeg = ext === "jpg" || ext === "jpeg";
    const coder = jpeg ? "jpeg" : ext;
    // ImageMagick 7 answers to `magick`; 6, Debian's, to `convert`. The limits bound a decompression bomb.
    const script = 'src=$1; c=$2; test -f "$src" || { rm -f -- "$c"; echo "$src is not a file" >&2; exit 1; }; ' +
      'if command -v magick >/dev/null; then im=magick; elif command -v convert >/dev/null; then im=convert; else exit 3; fi; ' +
      'if [ ! "$c" -nt "$src" ]; then mkdir -p -- "$(dirname -- "$c")" && ' +
      '"$im" -limit memory 256MiB -limit map 512MiB -limit area 64MP -limit disk 1GiB -limit width 16KP -limit height 16KP ' +
      '"$3:$src[0]" -auto-orient -thumbnail "$4" -strip "$c" || { rm -f -- "$c"; exit 1; }; fi; cat -- "$c"';
    const r = await this.box.run(["sh", "-c", script, "sh", p, `${cache}${jpeg ? ".jpg" : ".png"}`, coder, `${THUMB_BOX}x${THUMB_BOX}>`], { timeoutMs: THUMB_TIMEOUT_MS });
    if (r.code === 3) return undefined;
    if (r.code !== 0) throw new Error(r.stderr.toString().trim() || (r.signal ? "the thumbnail took too long" : "could not make the thumbnail"));
    return { bytes: r.stdout, type: jpeg ? "image/jpeg" : "image/png" };
  }

  /**
   * `count` stills from a clip, evenly spread over it (each from the middle of its share), at most FRAME_SIDE on a
   * side, as JPEGs with the second each comes from: what the look tool shows a vision model of a video. ffprobe and
   * ffmpeg run inside the sandbox, one still at a time within FRAME_TIMEOUT_MS, ended with `signal`; nothing is
   * written. Without them, an error saying so.
   */
  async frames(path: string, count: number, signal?: AbortSignal): Promise<{ at: number; bytes: Buffer; type: "image/jpeg" }[]> {
    const p = this.allow(path, false);
    const n = Math.max(1, Math.min(MAX_FRAMES, Math.floor(count)));
    const probe = await this.box.run(["sh", "-c", 'command -v ffprobe >/dev/null && command -v ffmpeg >/dev/null || exit 3; test -f "$1" || { echo "$1 is not a file" >&2; exit 1; }; ' +
      'ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "file:$1"', "sh", p], { timeoutMs: FRAME_TIMEOUT_MS, signal });
    if (probe.code === 3) throw new Error("ffmpeg isn't installed, so a video's frames can't be read");
    const seconds = Number.parseFloat(probe.stdout.toString());
    if (probe.code !== 0 || !Number.isFinite(seconds) || seconds <= 0) throw new Error(probe.stderr.toString().trim() || `${path} couldn't be read as a video`);
    // The longer side at most FRAME_SIDE, never enlarged; -2 keeps the other even, as the encoder needs.
    const scale = `scale='if(gte(iw,ih),min(${FRAME_SIDE},iw),-2)':'if(gte(iw,ih),-2,min(${FRAME_SIDE},ih))'`;
    const out: { at: number; bytes: Buffer; type: "image/jpeg" }[] = [];
    for (let i = 0; i < n; i++) {
      signal?.throwIfAborted();
      const at = Math.round(seconds * (i + 0.5) / n * 10) / 10;
      const r = await this.box.run(["ffmpeg", "-v", "error", "-ss", String(at), "-i", `file:${p}`, "-frames:v", "1", "-vf", scale, "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "-"], { timeoutMs: FRAME_TIMEOUT_MS, signal });
      if (r.code !== 0 || !r.stdout.length) throw new Error(r.stderr.toString().trim() || (r.signal ? "reading a frame took too long" : `${path} couldn't be read as a video`));
      out.push({ at, bytes: r.stdout, type: "image/jpeg" });
    }
    return out;
  }

  /**
   * The end of a clip, for a host to continue: its last `seconds` or more, from the keyframe before them, copied
   * without re-encoding (so it keeps the clip's encoder settings). ffmpeg runs in the sandbox; its file is in the
   * sandbox's own /tmp (memory, or a project chat's encrypted tmp/), removed when it ends.
   */
  async clipTail(path: string, seconds: number, signal?: AbortSignal): Promise<Buffer> {
    const p = this.allow(path, false);
    const r = await this.box.run(["sh", "-c", `${NEEDS_FFMPEG} test -f "$1" || { echo "$1 is not a file" >&2; exit 1; }; d=$(mktemp -d) && trap 'rm -rf -- "$d"' EXIT && ` +
      'ffmpeg -v error -nostdin -sseof "-$2" -i "file:$1" -map 0:v:0 -map "0:a:0?" -c copy -f mp4 "$d/t.mp4" && cat -- "$d/t.mp4"', "sh", p, String(seconds)],
    { timeoutMs: CLIP_TIMEOUT_MS, signal });
    if (r.code === 3) throw new Error("ffmpeg isn't installed, so a clip can't be extended");
    if (r.code !== 0 || !r.stdout.length) throw new Error(r.stderr.toString().trim() || (r.signal ? "cutting the clip took too long" : `${path} couldn't be read as a video`));
    return r.stdout;
  }

  /**
   * `path` with `added` (an MP4) joined on its end, and its first frame as a PNG. Two clips from the same encoder
   * settings (a host's) are joined without re-encoding; others are re-encoded as the host encodes (H.264 at CRF 18,
   * AAC), sound kept only when both have it. ffmpeg runs in the sandbox, its files in the sandbox's own /tmp.
   */
  async joinClips(path: string, added: Buffer, signal?: AbortSignal): Promise<{ bytes: Buffer; poster: Buffer; width: number; height: number; frames: number; fps: number; audio: boolean }> {
    const p = this.allow(path, false);
    // The streams' codecs, shapes and encoder settings (extradata): equal, the packets go together as they are.
    const script = `${NEEDS_FFMPEG} test -f "$1" || { echo "$1 is not a file" >&2; exit 1; }; d=$(mktemp -d) && trap 'rm -rf -- "$d"' EXIT || exit 1; ` +
      'cat > "$d/b.mp4" && ln -s -- "$1" "$d/a.mp4" || exit 1; ' +
      'h() { ffprobe -v error -show_data_hash sha256 -show_entries stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels,extradata_hash -of csv=p=0 "file:$1"; }; ' +
      'has() { ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 "file:$1" | grep -q .; }; ' +
      'if [ "$(h "$d/a.mp4")" = "$(h "$d/b.mp4")" ]; then printf "file a.mp4\\nfile b.mp4\\n" > "$d/l" && ffmpeg -v error -nostdin -f concat -safe 0 -i "$d/l" -c copy -movflags +faststart "$d/o.mp4" || exit 1; ' +
      'elif has "$d/a.mp4" && has "$d/b.mp4"; then ffmpeg -v error -nostdin -i "file:$d/a.mp4" -i "file:$d/b.mp4" -filter_complex "[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]" -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -movflags +faststart "$d/o.mp4" || exit 1; ' +
      'else ffmpeg -v error -nostdin -i "file:$d/a.mp4" -i "file:$d/b.mp4" -filter_complex "[0:v:0][1:v:0]concat=n=2:v=1:a=0[v]" -map "[v]" -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart "$d/o.mp4" || exit 1; fi; ' +
      // What the joined clip is, on stderr's last line after any warning.
      'v=$(ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=width,height,r_frame_rate,nb_read_packets -of csv=p=0 "file:$d/o.mp4") || exit 1; ' +
      'if has "$d/o.mp4"; then a=1; else a=0; fi; printf "\\n@%s,%s\\n" "$v" "$a" >&2; cat -- "$d/o.mp4"';
    const r = await this.box.run(["sh", "-c", script, "sh", p], { input: added, timeoutMs: CLIP_TIMEOUT_MS, signal });
    if (r.code === 3) throw new Error("ffmpeg isn't installed, so a clip can't be extended");
    const info = /\n@(\d+),(\d+),(\d+)\/(\d+),(\d+),([01])\n?$/.exec(r.stderr.toString());
    if (r.code !== 0 || !r.stdout.length || !info) throw new Error(r.stderr.toString().trim() || (r.signal ? "joining the clips took too long" : "the clips couldn't be joined"));
    const [width, height, num, den, frames, audio] = info.slice(1).map(Number) as [number, number, number, number, number, number];
    const still = await this.box.run(["ffmpeg", "-v", "error", "-nostdin", "-i", `file:${p}`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { timeoutMs: FRAME_TIMEOUT_MS, signal });
    if (still.code !== 0 || !still.stdout.length) throw new Error(still.stderr.toString().trim() || `${path} couldn't be read as a video`);
    return { bytes: r.stdout, poster: still.stdout, width, height, frames, fps: num / den, audio: audio === 1 };
  }

  /** Where a file's thumbnail is kept, without its extension; nothing for a path outside the thread's folder. */
  private thumbPath(p: string): string | undefined {
    const base = `${this.workdir}/`;
    return p.startsWith(base) && !p.startsWith(`${base}${PANEL_DIR}/`) ? posix.join(this.workdir, PANEL_DIR, "thumbs", p.slice(base.length)) : undefined;
  }

  /**
   * Deletes the thumbnails whose image is no longer in the thread's folder (she deleted or moved it with a command,
   * which the panel never sees), and folders left empty for over a minute (a newer one may be a thumbnail being made).
   */
  async pruneThumbs(): Promise<void> {
    const script = 't=$1/$2/thumbs; [ -d "$t" ] || exit 0; ' +
      'find "$t" -type f -exec sh -c \'w=$1; t=$2; shift 2; for c; do s=$w/${c#"$t"/}; s=${s%.*}; [ -f "$s" ] || rm -f -- "$c"; done\' sh "$1" "$t" {} + && ' +
      'find "$t" -mindepth 1 -type d -empty -mmin +1 -delete';
    await this.file(["sh", "-c", script, "sh", this.workdir, PANEL_DIR]);
  }

  /** The thumbnails of files under `paths` (a file's own, or everything under a folder), to go with them. */
  private thumbsOf(paths: string[]): string[] {
    return paths.flatMap((p) => { const t = this.thumbPath(p); return t ? [t, `${t}.png`, `${t}.jpg`, `${t}.seconds`] : []; });
  }

  /**
   * Saves `bytes` as `name` in `dir`, cleaned, under a free name (a taken one
   * gets a suffix, never overwritten). Returns the path she sees.
   */
  async upload(dir: string, name: string, bytes: Buffer): Promise<string> {
    const d = this.allow(dir, true);
    const clean = cleanUploadName(name);
    const dot = clean.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
    const script = 'cd "$1" && n="$2$3" && i=2 && until (set -C; cat > "$n") 2>/dev/null; do ' +
      '[ "$i" -gt 999 ] && exit 1; n="$2-$i$3"; i=$((i+1)); done && printf %s "$n"';
    const out = await this.file(["sh", "-c", script, "sh", d, stem, ext], bytes);
    const path = posix.join(d, out.toString());
    this.note("added", [path]);
    this.origins.added?.([path]);
    return path;
  }

  async mkdir(path: string): Promise<void> {
    const p = this.inside(path);
    await this.file(["mkdir", "--", p]);
    this.note("added", [p]);
  }

  /** Moves a file or folder to a new path; a path already taken is refused. Returns both paths as she sees them. */
  async rename(from: string, to: string): Promise<{ from: string; to: string }> {
    const f = this.inside(from);
    const t = this.inside(to);
    // Thumbnails move with it: a clip's poster can't be made again (ThreadImages.saveVideo). One with nowhere to go is deleted.
    const moved = this.thumbsOf([t]);
    const pairs = this.thumbsOf([f]).flatMap((c, i) => [c, moved[i] ?? ""]);
    await this.file(["sh", "-c", 'if [ -e "$2" ] || [ -L "$2" ]; then echo "$2 is already there" >&2; exit 1; fi; mv -T -- "$1" "$2" && shift 2 && ' +
      'while [ $# -gt 1 ]; do if [ -e "$1" ]; then rm -rf -- "$2"; { [ -n "$2" ] && mkdir -p -- "$(dirname -- "$2")" && mv -T -- "$1" "$2"; } || rm -rf -- "$1"; fi; shift 2; done', "sh", f, t, ...pairs]);
    this.note("renamed", [f, t]);
    this.origins.moved?.(f, t);
    return { from: f, to: t };
  }

  /**
   * Copies files and folders into `dir`, each under its own name or, where that is taken, a free one (`plan-2.md`, as
   * an upload gets). Symlinks are copied as links, never followed. A folder can't go into itself. Returns the new
   * paths as she sees them.
   */
  async copy(paths: string[], dir: string): Promise<string[]> {
    if (!paths.length) return [];
    const d = this.allow(dir, true);
    const out: string[] = [];
    for (const raw of paths) {
      const p = this.allow(raw, false);
      if (this.roots().some((r) => r.path === p)) throw new FilesRefused(`${p} is one of this thread's folders itself`);
      if (d === p || d.startsWith(`${p}/`)) throw new FilesRefused(`${posix.basename(p)} can't be copied into itself`);
      const name = posix.basename(p);
      const dot = name.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      // The first free name wins; mkdir or a no-clobber create claims it before the copy fills it.
      const script = 'src=$1; cd "$2" && n="$3$4" && i=2 && ' +
        'until if [ -d "$src" ] && [ ! -L "$src" ]; then mkdir -- "$n"; else (set -C; : > "$n"); fi 2>/dev/null; do ' +
        '[ "$i" -gt 999 ] && exit 1; n="$3-$i$4"; i=$((i+1)); done && ' +
        'if [ -d "$src" ] && [ ! -L "$src" ]; then cp -RP -- "$src/." "$n/"; else rm -f -- "$n" && cp -P -- "$src" "$n"; fi || { rm -rf -- "$n"; exit 1; }; printf %s "$n"';
      out.push(posix.join(d, (await this.file(["sh", "-c", script, "sh", p, d, stem, ext])).toString()));
    }
    this.note("added", out);
    this.origins.added?.(out);
    return out;
  }

  /** Deletes files and folders, for good. */
  async remove(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const ps = paths.map((p) => this.inside(p));
    await this.file(["rm", "-rf", "--", ...ps, ...this.thumbsOf(ps)]);
    this.note("removed", ps);
    this.origins.removed?.(ps);
  }

  /**
   * A zip of the files and folders, built as it streams (stored, not
   * compressed): nothing lands on disk. Each entry is named from its
   * parent folder down, so `a/b` and `a/b/c.txt` zip as `b/c.txt`. One
   * sandbox run reads every file (GNU tar, whose stream is unpacked here),
   * not one per file: starting a sandbox costs far more than reading a
   * small file. `bytes` is the zip's exact length, known before it starts,
   * so a download can show how far it has got: each file is kept to the
   * size the listing found, cut or padded with zeros if it changed since.
   */
  async zip(paths: string[]): Promise<ZipStream> {
    if (!paths.length) throw new FilesRefused("nothing to zip");
    const files: ZipFile[] = [];
    for (const raw of paths) {
      const p = this.allow(raw, false);
      const out = await this.capped(["find", p, "-name", PANEL_DIR, "-prune", "-o", "-type", "f", "-printf", ZIP_PRINTF], ZIP_FILES_LIMIT + 1 - files.length);
      for (const line of out) {
        const tab = line.indexOf("\t");
        const path = line.slice(tab + 1);
        files.push({ path, name: Buffer.from(posix.relative(posix.dirname(p), path), "utf8"), size: Number(line.slice(0, tab)) });
        if (files.length > ZIP_FILES_LIMIT) throw new FilesRefused(`more than ${ZIP_FILES_LIMIT} files; zip fewer at a time`);
      }
    }
    if (!files.length) throw new FilesRefused("no files to zip");
    const bytes = files.reduce((n, f) => n + 30 + f.name.length + f.size + 16 + 46 + f.name.length, 22);
    if (bytes >= 0xffffffff) throw new FilesRefused("more than 4 GB; zip fewer at a time");
    return { stream: Readable.from(this.zipChunks(files)), bytes, files: files.length };
  }

  private async *zipChunks(files: ZipFile[]): AsyncGenerator<Buffer> {
    const child = await this.box.start(["tar", "--format=gnu", "--create", "--file=-", "--absolute-names", "--no-recursion", "--hard-dereference", "--null", "--files-from=-"]);
    const err: Buffer[] = [];
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.concat(files.flatMap((f) => [Buffer.from(f.path, "utf8"), Buffer.alloc(1)])));
    const closed = new Promise<number | null>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(child.exitCode) : child.once("close", resolve)));
    const said = () => Buffer.concat(err).toString().trim();
    const tar = new TarReader(child.stdout as AsyncIterable<Buffer>);
    try {
      const central: Buffer[] = [];
      let offset = 0;
      const now = dosTime(new Date());
      for (const f of files) {
        const entry = await tar.next();
        if (!entry || entry.name !== f.path) {
          child.kill("SIGKILL");
          await closed;
          throw new Error(said() || `could not read ${f.path}`);
        }
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0808, 6); // bit 3: sizes follow the data; bit 11: UTF-8 names
        local.writeUInt16LE(0, 8); // stored
        local.writeUInt16LE(now.time, 10);
        local.writeUInt16LE(now.date, 12);
        local.writeUInt16LE(f.name.length, 26);
        const at = offset;
        yield Buffer.concat([local, f.name]);
        offset += local.length + f.name.length;
        let crc = 0;
        // The size the listing found: a file that grew since is cut there, one that shrank is padded with zeros.
        let left = f.size;
        for await (const chunk of tar.data(entry.size)) {
          const piece = chunk.subarray(0, left);
          if (!piece.length) continue;
          crc = crc32(piece, crc);
          left -= piece.length;
          yield piece;
        }
        if (left > 0) {
          const pad = Buffer.alloc(left);
          crc = crc32(pad, crc);
          yield pad;
        }
        offset += f.size;
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        descriptor.writeUInt32LE(f.size, 8);
        descriptor.writeUInt32LE(f.size, 12);
        yield descriptor;
        offset += descriptor.length;
        const head = Buffer.alloc(46);
        head.writeUInt32LE(0x02014b50, 0);
        head.writeUInt16LE(20, 4); // made by
        head.writeUInt16LE(20, 6); // needed
        head.writeUInt16LE(0x0808, 8);
        head.writeUInt16LE(0, 10);
        head.writeUInt16LE(now.time, 12);
        head.writeUInt16LE(now.date, 14);
        head.writeUInt32LE(crc >>> 0, 16);
        head.writeUInt32LE(f.size, 20);
        head.writeUInt32LE(f.size, 24);
        head.writeUInt16LE(f.name.length, 28);
        head.writeUInt32LE(at, 42);
        central.push(head, f.name);
      }
      // tar's end blocks; then its exit: 1 only says a file changed while it was read, which the sizes above allow for.
      await tar.drain();
      const code = await closed;
      if (code !== 0 && code !== 1) throw new Error(said() || `tar failed (${code})`);
      const dir = Buffer.concat(central);
      yield dir;
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(files.length, 8);
      end.writeUInt16LE(files.length, 10);
      end.writeUInt32LE(dir.length, 12);
      end.writeUInt32LE(offset, 16);
      yield end;
    } finally {
      // A download stopped part way (Cancel, a closed tab) stops the read too.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }

  private async find(argv: string[], limit: number): Promise<FileListing> {
    const lines = await this.capped(argv, limit + 1);
    const entries = lines.slice(0, limit).map(parseLine);
    return { entries, more: lines.length > limit };
  }

  /** Runs a find that prints NUL-ended lines, stopping it after `n` of them. */
  private async capped(argv: string[], n: number): Promise<string[]> {
    const out = await this.file(["sh", "-c", 'n=$1; shift; "$@" | head -z -n "$n"', "sh", String(n), ...argv]);
    return out.toString().split("\0").filter(Boolean);
  }

  /** Runs a command and throws its error output if it fails. */
  private async file(argv: string[], input?: Buffer): Promise<Buffer> {
    const r = await this.box.run(argv, { input });
    if (r.code !== 0) throw new Error(r.stderr.toString().trim() || `${argv[0]} failed`);
    return r.stdout;
  }
}

function parseLine(line: string): FileEntry {
  const [y, size, t, ...rest] = line.split("\t");
  const path = rest.join("\t");
  return {
    name: posix.basename(path), path, size: Number(size), modified: new Date(Number(t) * 1000).toISOString(),
    kind: y === "d" ? "folder" : y === "f" ? "file" : y === "l" ? "link" : "other",
  };
}

/** An uploaded file's name made safe: no path, no control characters, at most 120 characters. */
export function cleanUploadName(name: string): string {
  const base = name.normalize("NFC").split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[^\p{L}\p{N}._:@ ()+,'&-]/gu, "_").replace(/^[.\s]+/, "").trim().slice(0, 120);
  return clean || "upload";
}

/**
 * A served file's type by its extension, or, for a name it doesn't know, by its first bytes (`head`): text of any
 * kind (a C++ header, a Makefile, a .env) is plain text. Anything a browser could run (HTML, SVG, scripts) is sent as
 * plain text too.
 */
export function typeByName(path: string, head?: Buffer): string {
  const ext = posix.extname(path).slice(1).toLowerCase();
  const types: Record<string, string> = {
    txt: "text/plain", md: "text/plain", json: "application/json", csv: "text/csv", pdf: "application/pdf",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm",
  };
  const type = types[ext] ?? (TEXTY.has(ext) || (head && looksLikeText(head)) ? "text/plain" : "application/octet-stream");
  return type.startsWith("text/") ? `${type}; charset=utf-8` : type;
}
const TEXTY = new Set(["html", "htm", "svg", "xml", "js", "mjs", "ts", "tsx", "jsx", "css", "py", "sh", "yaml", "yml", "toml", "ini", "log", "rs", "go", "java", "c", "h", "cpp"]);

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
