// The thread's Files panel (DESIGN, "Files and images"): listing, searching,
// serving, uploading, renaming, deleting and zipping, every one of them run
// inside the thread's sandbox, so paths and symlinks resolve there and can't
// leave the thread's folder and its grants. Nothing is written outside them
// and no temp file is made on the host: the zip is built as it streams.
import { posix } from "node:path";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { sniffImage } from "./ops.ts";
import { Sandbox, SandboxDenied, WORKDIR } from "./sandbox.ts";
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

/** A top of the panel's tree: the thread's folder, then each granted folder. */
export interface FileRoot { path: string; writable: boolean; kind: "thread" | "grant" }

export interface FileListing { entries: FileEntry[]; /** The listing stopped at the cap. */ more: boolean }

/** An image in the thread's folder: uploaded by the person, or made by her. */
export interface ImageEntry extends FileEntry { source: "uploaded" | "made" }

/** What the panel's thumbnail cache would live under; never listed or searched. */
export const PANEL_DIR = ".lyrica";
export const LIST_LIMIT = 2000;
export const SEARCH_LIMIT = 200;
export const ZIP_FILES_LIMIT = 10_000;
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
// Entries end in NUL, not newline: a name may hold a newline or a tab, so the
// path is everything after the fixed fields.
const PRINTF = String.raw`%y\t%s\t%T@\t%p\0`;
const ZIP_PRINTF = String.raw`%s\t%p\0`;

/** Thrown for a path the panel may not touch: a root itself, or one outside the thread's folders. */
export class FilesRefused extends Error {}

/** The panel's operations for one thread, each a fresh sandbox run. */
export class ThreadFiles {
  /** `note` records what the panel added or removed, for her next turn. */
  constructor(private readonly box: Sandbox, private readonly grants: Grant[], private readonly note: (kind: "added" | "removed", names: string[]) => void = () => {}) {}

  roots(): FileRoot[] {
    return [{ path: WORKDIR, writable: true, kind: "thread" }, ...this.grants.map((g) => ({ path: g.path, writable: g.writable, kind: "grant" as const }))];
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
    const out = await this.find(["find", d, "-mindepth", "1", "-maxdepth", "1", "!", "-name", PANEL_DIR, "-printf", PRINTF], LIST_LIMIT);
    out.entries.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name));
    return out;
  }

  /** Files and folders under `root` whose name contains `query` (case ignored), stopping at the cap. */
  async search(root: string, query: string): Promise<FileListing> {
    const r = this.allow(root, false);
    const q = query.trim();
    if (!q) return { entries: [], more: false };
    const pattern = `*${q.replace(/[\\*?[\]]/g, "\\$&")}*`;
    return this.find(["find", r, "-mindepth", "1", "-name", PANEL_DIR, "-prune", "-o", "-iname", pattern, "-printf", PRINTF], SEARCH_LIMIT);
  }

  /** Every image in the thread's folder, uploaded ones told from hers. */
  async images(): Promise<ImageEntry[]> {
    const names = IMAGE_EXTENSIONS.flatMap((e, i) => [...(i ? ["-o"] : []), "-iname", `*.${e}`]);
    const { entries } = await this.find(["find", WORKDIR, "-name", PANEL_DIR, "-prune", "-o", "-type", "f", "(", ...names, ")", "-printf", PRINTF], LIST_LIMIT);
    return entries.map((e) => ({ ...e, source: e.path.startsWith(`${WORKDIR}/uploads/`) ? "uploaded" : "made" }));
  }

  /** A file's bytes as a stream, with its size and type. The caller sends it as is. */
  async read(path: string): Promise<{ stream: Readable; size: number; type: string }> {
    const p = this.allow(path, false);
    const head = await this.file(["sh", "-c", 'test -f "$1" || { echo "$1 is not a file" >&2; exit 1; }; stat -c %s -- "$1"; head -c 16 -- "$1"', "sh", p]);
    const nl = head.indexOf(10);
    const size = Number(head.subarray(0, nl).toString());
    const type = sniffImage(head.subarray(nl + 1)) ?? typeByName(p);
    const child = await this.box.start(["cat", "--", p]);
    const err: Buffer[] = [];
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("close", (code) => { if (code !== 0) child.stdout.destroy(new Error(Buffer.concat(err).toString().trim() || "could not read the file")); });
    child.stdin.end();
    return { stream: child.stdout, size, type };
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
    return path;
  }

  async mkdir(path: string): Promise<void> {
    const p = this.inside(path);
    await this.file(["mkdir", "--", p]);
    this.note("added", [p]);
  }

  /** Moves a file or folder to a new path; a path already taken is refused. */
  async rename(from: string, to: string): Promise<void> {
    const f = this.inside(from);
    const t = this.inside(to);
    await this.file(["sh", "-c", 'if [ -e "$2" ] || [ -L "$2" ]; then echo "$2 is already there" >&2; exit 1; fi; mv -T -- "$1" "$2"', "sh", f, t]);
    this.note("removed", [f]);
    this.note("added", [t]);
  }

  /** Deletes files and folders, for good. */
  async remove(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const ps = paths.map((p) => this.inside(p));
    await this.file(["rm", "-rf", "--", ...ps]);
    this.note("removed", ps);
  }

  /**
   * A zip of the files and folders, built as it streams (stored, not
   * compressed): nothing lands on disk. Each entry is named from its
   * parent folder down, so `a/b` and `a/b/c.txt` zip as `b/c.txt`.
   */
  async zip(paths: string[]): Promise<Readable> {
    if (!paths.length) throw new FilesRefused("nothing to zip");
    const files: { path: string; name: string; size: number }[] = [];
    for (const raw of paths) {
      const p = this.allow(raw, false);
      const out = await this.capped(["find", p, "-name", PANEL_DIR, "-prune", "-o", "-type", "f", "-printf", ZIP_PRINTF], ZIP_FILES_LIMIT + 1 - files.length);
      for (const line of out) {
        const tab = line.indexOf("\t");
        const path = line.slice(tab + 1);
        files.push({ path, name: posix.relative(posix.dirname(p), path), size: Number(line.slice(0, tab)) });
        if (files.length > ZIP_FILES_LIMIT) throw new FilesRefused(`more than ${ZIP_FILES_LIMIT} files; zip fewer at a time`);
      }
    }
    if (!files.length) throw new FilesRefused("no files to zip");
    if (files.reduce((n, f) => n + f.size, 0) >= 0xffffffff) throw new FilesRefused("more than 4 GB; zip fewer at a time");
    return Readable.from(this.zipChunks(files));
  }

  private async *zipChunks(files: { path: string; name: string }[]): AsyncGenerator<Buffer> {
    const central: Buffer[] = [];
    let offset = 0;
    const now = dosTime(new Date());
    for (const f of files) {
      const name = Buffer.from(f.name, "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0808, 6); // bit 3: sizes follow the data; bit 11: UTF-8 names
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(now.time, 10);
      local.writeUInt16LE(now.date, 12);
      local.writeUInt16LE(name.length, 26);
      const at = offset;
      yield Buffer.concat([local, name]);
      offset += local.length + name.length;
      let crc = 0;
      let size = 0;
      const child = await this.box.start(["cat", "--", f.path]);
      child.stdin.end();
      const err: Buffer[] = [];
      child.stderr.on("data", (d: Buffer) => err.push(d));
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        yield chunk;
      }
      const code = await new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("close", resolve)));
      if (code !== 0) throw new Error(Buffer.concat(err).toString().trim() || `could not read ${f.path}`);
      offset += size;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc >>> 0, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      yield descriptor;
      offset += descriptor.length;
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4); // made by
      entry.writeUInt16LE(20, 6); // needed
      entry.writeUInt16LE(0x0808, 8);
      entry.writeUInt16LE(0, 10);
      entry.writeUInt16LE(now.time, 12);
      entry.writeUInt16LE(now.date, 14);
      entry.writeUInt32LE(crc >>> 0, 16);
      entry.writeUInt32LE(size, 20);
      entry.writeUInt32LE(size, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE(at, 42);
      central.push(entry, name);
    }
    const dir = Buffer.concat(central);
    yield dir;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    yield end;
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

/** A served file's type by its extension; anything a browser could run (HTML, SVG, scripts) is sent as plain text. */
export function typeByName(path: string): string {
  const ext = posix.extname(path).slice(1).toLowerCase();
  const types: Record<string, string> = {
    txt: "text/plain", md: "text/plain", json: "application/json", csv: "text/csv", pdf: "application/pdf",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm",
  };
  return `${types[ext] ?? (TEXTY.has(ext) ? "text/plain" : "application/octet-stream")}${(types[ext] ?? "").startsWith("text/") || TEXTY.has(ext) ? "; charset=utf-8" : ""}`;
}
const TEXTY = new Set(["html", "htm", "svg", "xml", "js", "mjs", "ts", "tsx", "jsx", "css", "py", "sh", "yaml", "yml", "toml", "ini", "log", "rs", "go", "java", "c", "h", "cpp"]);

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
