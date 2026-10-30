// Downloads into the models folder's lyrica/ subfolder, the only place fetch
// can write. Each file arrives under a temporary name, is checked against
// the hub's checksum, and only then gets its real name and a line in the
// download record. Tokens are held in memory for one download, never written.
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmdirSync, statSync, statfsSync, truncateSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { VOICE_FILE, WHISPER_FILE, checkRepo, checkRepoPath, verdict, type Card, type Hub, type HubFile, type Source } from "./hubs.ts";
import { DownloadError, plainError, type Net } from "./net.ts";

export interface RecordEntry {
  path: string; // relative to the models folder: lyrica/...
  size: number;
  sha256: string;
  verified: boolean;
  downloadedAt: string;
  source: Source;
  repo: string | null;
  revision: string | null;
  url: string | null;
  card: Card | null;
}

export type DownloadState = "queued" | "downloading" | "verifying" | "done" | "failed" | "cancelled";

export interface Download {
  id: string;
  source: Source;
  repo: string | null;
  revision: string | null;
  url: string | null;
  path: string;
  size: number;
  received: number;
  state: DownloadState;
  verified: boolean | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  // Kept for the work itself, not shown:
  from: string;
  sha256: string | null;
  gitSha1: string | null;
  gated: boolean;
  card: Card | null;
  tokenHost: string | null;
}

export type DownloadRequest =
  | { source: "huggingface" | "modelscope"; repo: string; revision?: string; files: string[] }
  | { source: "url"; url: string; sha256?: string };

const MARGIN = 1024 ** 3;
/** The files a lookup may read without saving them, and how large. */
const READABLE = ["config.json", "generation_config.json", "README.md"];
const READ_LIMIT = 1024 * 1024;
const PUBLIC_FIELDS = ["id", "source", "repo", "revision", "url", "path", "size", "received", "state", "verified", "error", "startedAt", "finishedAt"] as const;

export function shown(d: Download, link?: string) {
  // While a link downloads, its full form (query included) is shown, so what it carries is visible.
  return { ...Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, d[k]])), ...(link ? { url: link } : {}) };
}

const partName = (path: string) => join(dirname(path), `.${basename(path)}.lyrica-part`);

export interface DownloaderOptions {
  /** The models folder; only its lyrica/ subfolder is written. */
  models: string;
  /** Where the record and the download list are kept. */
  data: string;
  net: Net;
  hubs: { huggingface: Hub; modelscope: Hub };
  log: (event: string, fields?: Record<string, string | number | boolean | null>) => void;
  free?: () => number;
}

export class Downloader {
  private readonly o: DownloaderOptions;
  private readonly root: string; // <models>/lyrica
  private downloads: Download[];
  private readonly tokens = new Map<string, string>();
  /** Full links with their query strings, in memory only. */
  private readonly links = new Map<string, string>();
  private current: { id: string; abort: AbortController } | null = null;
  private running = false;
  private lastSave = 0;

  constructor(o: DownloaderOptions) {
    this.o = o;
    this.root = join(o.models, "lyrica");
    mkdirSync(this.root, { recursive: true });
    mkdirSync(o.data, { recursive: true });
    this.downloads = this.readJson("downloads.json", []);
    // Interrupted downloads resume.
    for (const d of this.downloads) if (d.state === "downloading" || d.state === "verifying") d.state = "queued";
    this.save();
    this.removeStrayParts();
  }

  /** A partial file is kept while a download may still resume it: one queued, under way, or failed and still listed. */
  private ownsPart(path: string, except?: Download): boolean {
    return this.downloads.some((d) => d !== except && d.path === path && d.state !== "done" && d.state !== "cancelled");
  }

  /** Deletes partial files under lyrica/ that no listed download can resume, such as one whose failed download was cleared. */
  private removeStrayParts(): void {
    const kept = new Set(this.downloads.filter((d) => this.ownsPart(d.path)).map((d) => partName(join(this.o.models, d.path))));
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && e.name.startsWith(".") && e.name.endsWith(".lyrica-part") && !kept.has(full)) {
          try {
            unlinkSync(full);
          } catch {}
        }
      }
    };
    walk(this.root);
  }

  private readJson<T>(name: string, fallback: T): T {
    const path = join(this.o.data, name);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  }

  private writeJson(name: string, value: unknown): void {
    const path = join(this.o.data, name);
    writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  private save(): void {
    this.lastSave = Date.now();
    this.writeJson("downloads.json", this.downloads);
  }

  record(): RecordEntry[] {
    return this.readJson("record.json", []);
  }

  free(): number {
    if (this.o.free) return this.o.free();
    const s = statfsSync(this.root);
    return s.bavail * s.bsize;
  }

  list(): Download[] {
    return [...this.downloads].reverse();
  }

  /** A download as listed: a link in flight shows its full form. */
  shown(d: Download) {
    return shown(d, this.links.get(d.id));
  }

  get(id: string): Download | undefined {
    return this.downloads.find((d) => d.id === id);
  }

  start(): void {
    void this.work();
  }

  private hub(source: Source): Hub {
    if (source === "huggingface") return this.o.hubs.huggingface;
    if (source === "modelscope") return this.o.hubs.modelscope;
    throw new DownloadError("Unknown source.");
  }

  /** A repository's files, each marked allowed or not, present or not, fitting or not. */
  async listRepo(source: Source, repo: string, revision: string | undefined, token?: string) {
    const listing = await this.hub(source).list(checkRepo(repo), revision, token);
    const record = this.record();
    const free = this.free();
    return {
      source,
      repo,
      revision: listing.revision,
      gated: listing.gated,
      card: listing.card,
      free,
      files: listing.files.map((f) => {
        const dest = this.destination(source, repo, f.path);
        const v = verdict(f.path);
        return {
          path: f.path,
          size: f.size,
          sha256: f.sha256,
          allowed: v.allowed,
          reason: v.reason,
          present: record.some((r) => r.path === dest && (!f.sha256 || r.sha256 === f.sha256)),
          fits: f.size + MARGIN <= free,
        };
      }),
    };
  }

  /**
   * One small file of a repository, returned as text and never written:
   * config.json, generation_config.json or README.md, at most 1 MB, through
   * the same guard, redirects and token rule as a download. With the
   * revision it came from and the card's base model, for a lookup.
   */
  async readFile(source: Source, repo: string, revision: string | undefined, path: string, token?: string) {
    if (!READABLE.includes(path)) throw new DownloadError(`Only ${READABLE.join(", ")} can be read.`, 403);
    const hub = this.hub(source);
    const listing = await hub.list(checkRepo(repo), revision, token);
    const file = listing.files.find((f) => f.path === path);
    if (!file) throw new DownloadError(`${path} isn't in that repository.`, 404);
    if (file.size > READ_LIMIT) throw new DownloadError(`${path} is larger than 1 MB.`, 403);
    const res = await this.o.net.get({ url: hub.fileUrl(repo, listing.revision, path), token, tokenHost: hub.host });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of res) {
      size += (c as Buffer).length;
      if (size > READ_LIMIT) {
        res.destroy();
        throw new DownloadError(`${path} is larger than 1 MB.`, 403);
      }
      chunks.push(c as Buffer);
    }
    return { source, repo, revision: listing.revision, card: listing.card, path, text: Buffer.concat(chunks).toString("utf8") };
  }

  private destination(source: Source, repo: string, path: string): string {
    return posix.join("lyrica", source, repo, checkRepoPath(path));
  }

  /** Queues downloads. Everything is checked first; one refused file refuses the request. */
  async request(req: DownloadRequest, token?: string): Promise<Download[]> {
    const now = new Date().toISOString();
    const made: Download[] = [];
    const base = { received: 0, state: "queued" as const, verified: null, error: null, startedAt: now, finishedAt: null };
    if (req.source === "url") {
      // A link could carry data out of the host in its path or query, so links
      // are kept short, one at a time, and shown in full in the downloads list.
      if (typeof req.url !== "string" || req.url.length > 1024) throw new DownloadError("A link may be at most 1024 characters.", 403);
      if (this.downloads.some((d) => d.source === "url" && ["queued", "downloading", "verifying"].includes(d.state))) {
        throw new DownloadError("A link is already downloading; start this one when it's done.", 409);
      }
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        throw new DownloadError("That isn't a link.");
      }
      if (url.protocol !== "https:") throw new DownloadError("Only https links are allowed.");
      if (url.username || url.password) throw new DownloadError("A link may not carry a user name or password.", 403);
      let name: string;
      try {
        name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      } catch {
        throw new DownloadError("The link's file name isn't valid.");
      }
      const v = verdict(name);
      if (!v.allowed) throw new DownloadError(v.reason!, 403);
      if (req.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(req.sha256)) throw new DownloadError("sha256 must be 64 hex characters.");
      const path = posix.join("lyrica", "url", url.hostname, checkRepoPath(name));
      // A signed link's query (and any user and password in it) are credentials:
      // kept in memory for the transfer, never written down or shown.
      const shownUrl = `${url.protocol}//${url.host}${url.pathname}`;
      const id = randomUUID();
      if (url.search) this.links.set(id, url.href);
      made.push({
        ...base, id, source: "url", repo: null, revision: null, url: shownUrl, path, size: 0,
        from: shownUrl, sha256: req.sha256?.toLowerCase() ?? null, gitSha1: null, gated: !!url.search, card: null, tokenHost: null,
      });
    } else {
      const hub = this.hub(req.source);
      if (!Array.isArray(req.files) || !req.files.length) throw new DownloadError("Name at least one file.");
      for (const f of req.files) {
        const v = verdict(checkRepoPath(f));
        if (!v.allowed) throw new DownloadError(`${f}: ${v.reason}`, 403);
      }
      const listing = await hub.list(checkRepo(req.repo), req.revision, token);
      for (const want of req.files) {
        const f: HubFile | undefined = listing.files.find((x) => x.path === want);
        if (!f) throw new DownloadError(`${want} isn't in that repository.`);
        made.push({
          ...base, id: randomUUID(), source: req.source, repo: req.repo, revision: listing.revision, url: null,
          path: this.destination(req.source, req.repo, f.path), size: f.size,
          from: hub.fileUrl(req.repo, listing.revision, f.path), sha256: f.sha256, gitSha1: f.gitSha1,
          gated: listing.gated, card: listing.card, tokenHost: hub.host,
        });
      }
    }
    const record = this.record();
    for (const d of made) {
      const full = join(this.o.models, d.path);
      if (existsSync(full) && !record.some((r) => r.path === d.path)) throw new DownloadError(`${d.path} is already there, and the host didn't download it.`);
      if (this.downloads.some((x) => x.path === d.path && (x.state === "queued" || x.state === "downloading" || x.state === "verifying"))) {
        throw new DownloadError(`${d.path} is already downloading.`);
      }
    }
    const need = made.reduce((n, d) => n + d.size, 0) + MARGIN;
    if (need > this.free() - this.reserved()) throw new DownloadError("There isn't enough free space for this download.", 507);
    for (const d of made) {
      // A hub's token goes with that hub's downloads only, never with a link.
      if (token && d.tokenHost) this.tokens.set(d.id, token);
      this.downloads.push(d);
    }
    this.save();
    this.start();
    return made;
  }

  /** Bytes still to come for the downloads queued or under way. */
  private reserved(except?: Download): number {
    return this.downloads
      .filter((d) => d !== except && (d.state === "queued" || d.state === "downloading" || d.state === "verifying"))
      .reduce((n, d) => n + Math.max(d.size - d.received, 0), 0);
  }

  /** Cancels an unfinished download (deleting its partial file) or clears a finished one (deleting a failed one's). */
  cancel(id: string): void {
    const d = this.get(id);
    if (!d) throw new DownloadError("No such download.", 404);
    if (d.state === "queued" || d.state === "downloading" || d.state === "verifying") {
      if (this.current?.id === id) this.current.abort.abort();
      d.state = "cancelled";
      d.finishedAt = new Date().toISOString();
      this.tokens.delete(id);
      this.removePart(d);
    } else {
      this.downloads = this.downloads.filter((x) => x !== d);
      // A failed download kept its partial file to resume; once cleared, nothing will.
      if (d.state === "failed" && !this.ownsPart(d.path)) this.removePart(d);
    }
    this.save();
  }

  private removePart(d: Download): void {
    try {
      unlinkSync(partName(join(this.o.models, d.path)));
    } catch {}
  }

  private async work(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const d = this.downloads.find((x) => x.state === "queued");
        if (!d) break;
        await this.one(d);
      }
    } finally {
      this.running = false;
    }
  }

  private async one(d: Download): Promise<void> {
    const abort = new AbortController();
    this.current = { id: d.id, abort };
    const final = join(this.o.models, d.path);
    const part = partName(final);
    const token = this.tokens.get(d.id);
    try {
      const link = this.links.get(d.id);
      if (d.gated && !token && !link) throw new DownloadError("Start this download again to give the token.");
      this.makeDirs(dirname(final));
      d.state = "downloading";
      this.save();
      const sha256 = createHash("sha256");
      const sha1 = createHash("sha1");
      let have = existsSync(part) ? statSync(part).size : 0;
      if (have) for await (const c of createReadStream(part)) sha256.update(c as Buffer), sha1.update(c as Buffer);
      // The git blob hash starts with a header, so it can only be checked from the start.
      const gitHeader = () => sha1.update(`blob ${d.size}\0`);
      const res = await this.o.net.get({
        url: link ?? d.from, token, tokenHost: d.tokenHost ?? undefined, signal: abort.signal,
        headers: have ? { range: `bytes=${have}-` } : {},
      });
      if (have && res.statusCode !== 206) {
        // The server ignored the range: start again.
        res.destroy();
        truncateSync(part, 0);
        have = 0;
        return this.restartFresh(d);
      }
      if (!d.size) {
        // A link: its size is known only now. Refuse one that doesn't say, and check the space again.
        const length = Number(res.headers["content-length"]);
        if (!Number.isFinite(length) || length <= 0) {
          res.destroy();
          throw new DownloadError("The link doesn't say how big the file is, so it isn't downloaded.", 400);
        }
        d.size = length + have;
        if (length + MARGIN > this.free() - this.reserved(d)) {
          res.destroy();
          throw new DownloadError("There isn't enough free space for this download.", 507);
        }
      }
      if (d.gitSha1 && !have) gitHeader();
      d.received = have;
      const count = new Transform({
        transform: (chunk: Buffer, _enc, done) => {
          sha256.update(chunk);
          if (d.gitSha1) sha1.update(chunk);
          d.received += chunk.length;
          // Never more than the file's size: a server sending more is cut off.
          if (d.received > d.size) return done(new DownloadError("The server sent more than the file's size.", 400));
          if (Date.now() - this.lastSave > 2000) this.save();
          done(null, chunk);
        },
      });
      // O_NOFOLLOW: a symlink planted at the partial file's name isn't followed.
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW | (have ? fsConstants.O_APPEND : fsConstants.O_TRUNC);
      await pipeline(res, count, createWriteStream(part, { fd: openSync(part, flags, 0o644) }), { signal: abort.signal });
      d.state = "verifying";
      this.save();
      const got = sha256.digest("hex");
      if (d.size && d.received !== d.size) throw new DownloadError("The download ended early.");
      let verified: boolean;
      if (d.sha256) verified = got === d.sha256.toLowerCase() || fail();
      else if (d.gitSha1 && !have) verified = sha1.digest("hex") === d.gitSha1 || fail();
      else verified = false;
      checkFormat(part, d.path);
      renameSync(part, final);
      const entry: RecordEntry = {
        path: d.path, size: d.received, sha256: got, verified, downloadedAt: new Date().toISOString(),
        source: d.source, repo: d.repo, revision: d.revision, url: d.url, card: d.card,
      };
      this.writeJson("record.json", [...this.record().filter((r) => r.path !== d.path), entry]);
      d.state = "done";
      d.verified = verified;
      this.o.log("downloaded", { id: d.id, verified });
    } catch (e) {
      if (d.state === "cancelled") {
        this.removePart(d);
      } else {
        d.state = "failed";
        d.error = plainError(e).message;
        // A wrong or broken file leaves nothing behind; a broken connection, a
        // busy server or a timeout keeps the partial file to resume.
        const temporary = !(e instanceof DownloadError) || e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
        if (e instanceof ChecksumMismatch || !temporary) this.removePart(d);
        this.o.log("download failed", { id: d.id });
      }
    } finally {
      if (d.state !== "queued") {
        d.finishedAt = d.finishedAt ?? new Date().toISOString();
        this.tokens.delete(d.id);
        this.links.delete(d.id);
      }
      this.current = null;
      this.save();
    }
  }

  /** Creates the folders under lyrica/, refusing a symlink anywhere on the way. */
  private makeDirs(dir: string): void {
    let at = this.root;
    for (const p of relative(this.root, dir).split(sep).filter(Boolean)) {
      at = join(at, p);
      try {
        if (lstatSync(at).isSymbolicLink()) throw new DownloadError("A symlink is in the way of this download.", 400);
      } catch (e) {
        if (e instanceof DownloadError) throw e;
        mkdirSync(at);
      }
    }
  }

  private restartFresh(d: Download): void {
    d.state = "queued";
    d.received = 0;
  }

  /**
   * Deletes one downloaded file: only a path inside lyrica/ with no symlink
   * on the way, listed in the record, with the size and checksum it was
   * downloaded with.
   */
  async remove(path: unknown): Promise<string> {
    const refuse = (m: string) => new DownloadError(m, 403);
    if (typeof path !== "string" || !path.startsWith("lyrica/") || path.includes("\\") || path.includes("\0")) throw refuse("That path is outside the host's downloads.");
    const parts = path.split("/").slice(1);
    if (parts.some((p) => p === ".." || p === "." || p === "")) throw refuse("That path is outside the host's downloads.");
    const full = resolve(this.root, ...parts);
    if (!full.startsWith(this.root + sep)) throw refuse("That path is outside the host's downloads.");
    // No symlink anywhere between lyrica/ and the file.
    let at = this.root;
    for (const p of parts) {
      at = join(at, p);
      let st;
      try {
        st = lstatSync(at);
      } catch {
        throw new DownloadError("No such file.", 404);
      }
      if (st.isSymbolicLink()) throw refuse("That path is outside the host's downloads.");
    }
    const entry = this.record().find((r) => r.path === path);
    if (!entry) throw refuse("Only files the host downloaded can be deleted.");
    if (!statSync(full).isFile() || statSync(full).size !== entry.size) throw refuse("This file changed since it was downloaded.");
    const hash = createHash("sha256");
    await pipeline(createReadStream(full), hash);
    if (hash.digest("hex") !== entry.sha256) throw refuse("This file changed since it was downloaded.");
    unlinkSync(full);
    this.writeJson("record.json", this.record().filter((r) => r.path !== path));
    // Remove folders left empty, up to lyrica/.
    for (let dir = dirname(full); dir !== this.root && dir.startsWith(this.root); dir = dirname(dir)) {
      if (readdirSync(dir).length) break;
      rmdirSync(dir);
    }
    this.o.log("deleted", { path: relative(this.o.models, full) });
    return path;
  }
}

class ChecksumMismatch extends DownloadError {}

/** The file is what its name says: a GGUF header, a readable safetensors header, an ONNX file, a plain voice array or a whisper.cpp file. */
function checkFormat(path: string, name: string): void {
  const head = Buffer.alloc(8);
  const fd = openSync(path, "r");
  let header: Buffer | null = null;
  try {
    readSync(fd, head, 0, 8, 0);
    if (name.endsWith(".safetensors")) {
      const n = Number(head.readBigUInt64LE());
      if (n > 0 && n < 100 * 1024 * 1024) {
        header = Buffer.alloc(n);
        readSync(fd, header, 0, n, 8);
      }
    }
  } finally {
    closeSync(fd);
  }
  const bad = () => {
    throw new ChecksumMismatch("The file isn't a valid model file, so it was deleted.");
  };
  if (name.endsWith(".gguf") && head.toString("latin1", 0, 4) !== "GGUF") bad();
  // A voice is plain float32 numbers: not a pickle (opcode 0x80 and a
  // protocol), not a zip (PyTorch's format), and whole numbers of 4 bytes.
  if (VOICE_FILE.test(name.toLowerCase())) {
    const pickle = head[0] === 0x80 && head[1]! >= 2 && head[1]! <= 5;
    const zip = head.toString("latin1", 0, 4) === "PK\x03\x04";
    if (pickle || zip || statSync(path).size % 4 !== 0) {
      throw new ChecksumMismatch("The voice file isn't a plain array of numbers, so it was deleted.");
    }
  }
  // whisper.cpp's ggml format starts with its magic, 0x67676d6c little-endian.
  if (WHISPER_FILE.test(name.toLowerCase()) && head.toString("latin1", 0, 4) !== "lmgg") bad();
  // ONNX is a protocol buffer that starts with its IR version (field 1, a varint).
  if (name.endsWith(".onnx") && head[0] !== 0x08) bad();
  if (name.endsWith(".safetensors")) {
    try {
      if (!header || typeof JSON.parse(header.toString("utf8")) !== "object") bad();
    } catch {
      bad();
    }
  }
}

function fail(): never {
  throw new ChecksumMismatch("The file's checksum doesn't match the hub's, so it was deleted.");
}
