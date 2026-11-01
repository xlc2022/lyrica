import { spawn } from "node:child_process";
import { DOMParser, parseHTML } from "linkedom";
import type { Db } from "./db.ts";
import { adoptLocalAddress, checkAddress, htmlMarkdown, type FetchedPage } from "./web.ts";

// An offline copy of Wikipedia (DESIGN.md, "Switches in the message box"):
// ZIM files served by a kiwix-serve an administrator sets for the server,
// asked by lyricad as SearXNG is. web_search adds its hits to a search, or
// asks it alone when the search names Wikipedia, and web_fetch reads a
// wikipedia.org page from it before going online.

const KEY = "web.kiwix";
const OFFERED = "web.kiwix.offered";

/** The server's kiwix-serve address (self.db `settings`), or null. */
export function kiwixAddress(self: Db): string | null {
  const row = self.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  return row?.value || null;
}

/** Sets or clears it; an http(s) URL, kept without a trailing slash. */
export function setKiwixAddress(self: Db, address: string | null): string | null {
  const a = checkAddress(address, "Kiwix");
  if (a) self.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(KEY, a);
  else self.prepare("DELETE FROM settings WHERE key = ?").run(KEY);
  return a;
}

/** The address of a kiwix-serve the install leaves in `kiwix-address`: stored while none is set, once per address. */
export function adoptLocalKiwix(self: Db, address: string): boolean {
  return adoptLocalAddress(self, { key: KEY, offered: OFFERED, address: checkAddress(address, "Kiwix") });
}

const CATALOG_MS = 10_000, SEARCH_MS = 15_000, PAGE_MS = 15_000;

/** One ZIM kiwix-serve has: its id in URLs (the file's name), and what its catalog entry says. */
export interface KiwixBook {
  id: string;
  /** The ZIM's Name, like wikipedia_en_all_nopic. */
  name: string;
  title: string;
  /** ISO 639-3, as the ZIM says it. */
  language: string;
  /** The dump's date, YYYY-MM-DD. */
  date: string;
  /** The wikipedia.org subdomain this is a copy of (from a name wikipedia_<lang>_…), or "". */
  wiki: string;
}

const parser = new DOMParser();
const xml = (s: string) => parser.parseFromString(s, "text/xml");
const textOf = (el: { querySelector(s: string): { textContent: string | null } | null } | null, s: string) => (el?.querySelector(s)?.textContent ?? "").trim();

/** A request to kiwix-serve, as an error that says plainly what failed. */
async function get(address: string, path: string, ms: number, signal?: AbortSignal, f: typeof fetch = fetch): Promise<Response> {
  const timeout = AbortSignal.timeout(ms);
  try {
    return await f(address + path, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    if (timeout.aborted) throw new Error(`kiwix-serve didn't answer within ${ms / 1000} seconds.`);
    throw new Error(`kiwix-serve can't be reached: ${(err as Error & { cause?: Error }).cause?.message ?? (err as Error).message}.`);
  }
}

/** The books kiwix-serve has, from its OPDS catalog (`/catalog/v2/entries`). */
export async function kiwixBooks(address: string, signal?: AbortSignal, f: typeof fetch = fetch): Promise<KiwixBook[]> {
  const res = await get(address, "/catalog/v2/entries", CATALOG_MS, signal, f);
  if (!res.ok) throw new Error(`kiwix-serve answered ${res.status} to its catalog: is the address its base URL?`);
  const doc = xml(await res.text());
  const books: KiwixBook[] = [];
  for (const entry of doc.querySelectorAll("entry")) {
    const links = Array.from(entry.querySelectorAll("link")) as { getAttribute(name: string): string | null }[];
    const href = links.find((l) => l.getAttribute("type") === "text/html")?.getAttribute("href") ?? "";
    const id = decodeURIComponent(href.replace(/^\/content\//, "")).replace(/\/+$/, "");
    if (!id || id.includes("/")) continue;
    const name = textOf(entry, "name");
    books.push({
      id, name, title: textOf(entry, "title"), language: textOf(entry, "language"), date: textOf(entry, "updated").slice(0, 10),
      wiki: /^wikipedia_([a-z-]+)_/.exec(name)?.[1] ?? "",
    });
  }
  if (!books.length) throw new Error("kiwix-serve has no books: is a ZIM file in its folder?");
  return books;
}

/** How long one lyricad reuses a catalog before asking again. */
const BOOKS_MS = 5 * 60_000;
const known = new Map<string, { at: number; books: Promise<KiwixBook[]> }>();

/** The books, read once per address and reused for five minutes. */
function books(address: string, signal?: AbortSignal, f: typeof fetch = fetch): Promise<KiwixBook[]> {
  const had = known.get(address);
  if (had && had.at + BOOKS_MS > Date.now()) return had.books;
  const p = kiwixBooks(address, signal, f);
  known.set(address, { at: Date.now(), books: p });
  p.catch(() => known.delete(address));
  return p;
}

/** Forgets the books read, so the next call asks again (a changed address, or a test). */
export function forgetKiwixBooks(): void {
  known.clear();
}

/** What the API shows: whether kiwix-serve answers with a catalog, and which books it has. */
export async function kiwixStatus(address: string | null, f: typeof fetch = fetch): Promise<{ kiwixState: "reachable" | "unreachable" | "unset"; kiwixReason?: string; books: Pick<KiwixBook, "name" | "title" | "language" | "date">[] }> {
  if (!address) return { kiwixState: "unset", books: [] };
  try {
    const all = await kiwixBooks(address, undefined, f);
    return { kiwixState: "reachable", books: all.map(({ name, title, language, date }) => ({ name, title, language, date })) };
  } catch (err) {
    return { kiwixState: "unreachable", kiwixReason: (err as Error).message, books: [] };
  }
}

/** The wikipedia.org page an article path is a copy of, or its own address on kiwix-serve. */
function hitUrl(address: string, book: KiwixBook, path: string): string {
  const article = path.replace(/^A\//, "").replace(/\.html$/, "");
  return book.wiki ? `https://${book.wiki}.wikipedia.org/wiki/${article}` : `${address}/content/${encodeURIComponent(book.id)}/${path}`;
}

export interface KiwixHit { title: string; url: string; snippet: string; book: KiwixBook }

/** How a result names the copy it came from: "the offline copy of Wikipedia (2026-08)", as the web UI reads it. */
export function copyName(book: KiwixBook): string {
  return `the offline copy of ${book.title}${book.date ? ` (${book.date.slice(0, 7)})` : ""}`;
}

/** "wikipedia", "wikipedia's", or a site: filter on wikipedia.org, as she writes them into a search. */
const NAMES_WIKIPEDIA = /(?:^|\s)(?:site:(?:[a-z-]+\.)*wikipedia\.org\S*|wikipedia(?:'s|’s)?)(?=\s|$)/giu;

/**
 * A search's words for kiwix-serve, which matches only articles holding every word: without the ones naming
 * Wikipedia, which a copy of Wikipedia never needs and few articles hold. `wikipedia` says whether the
 * search named it; a search that is nothing but the name is left as it is.
 */
export function offlineQuery(query: string): { query: string; wikipedia: boolean } {
  const rest = query.replace(NAMES_WIKIPEDIA, " ").replace(/\s+/g, " ").trim();
  const plain = query.replace(/\s+/g, " ").trim();
  return rest && rest !== plain ? { query: rest, wikipedia: true } : { query: plain, wikipedia: false };
}

/** The first words of a hit's text, without the title it begins with and without the trailing dots. */
function snippetOf(title: string, description: string): string {
  let s = description.replace(/\s+/g, " ").trim();
  if (s.toLowerCase().startsWith(title.toLowerCase())) s = s.slice(title.length).trim();
  s = s.replace(/\.{3,}$/, "").trim();
  return s.length > 300 ? `${s.slice(0, 297).trimEnd()}...` : s;
}

/**
 * Up to `count` hits for `query` across the books, each asked on its own
 * (kiwix-serve refuses one search over books in different languages) and
 * merged in turn, the same URL once (a maxi and a nopic copy of one
 * language hold the same articles); a book that fails is left out.
 */
export async function kiwixSearch(address: string, query: string, count: number, signal?: AbortSignal, f: typeof fetch = fetch): Promise<KiwixHit[]> {
  const all = await books(address, signal, f);
  const pattern = offlineQuery(query).query;
  const per = await Promise.all(all.map(async (book) => {
    try {
      const path = `/search?pattern=${encodeURIComponent(pattern)}&books.name=${encodeURIComponent(book.id)}&format=xml&pageLength=${count}`;
      const res = await get(address, path, SEARCH_MS, signal, f);
      if (!res.ok) return [];
      const doc = xml(await res.text());
      const hits: KiwixHit[] = [];
      for (const item of doc.querySelectorAll("item")) {
        const title = textOf(item, "title");
        const link = textOf(item, "link");
        const path = decodeURIComponent(link.replace(/^\/content\/[^/]+\//, ""));
        if (!title || !path || link === path) continue;
        hits.push({ title, url: hitUrl(address, book, path), snippet: snippetOf(title, textOf(item, "description")), book });
      }
      return hits;
    } catch {
      return [];
    }
  }));
  const merged: KiwixHit[] = [];
  for (let i = 0; merged.length < count; i++) {
    const round = per.map((h) => h[i]).filter((h): h is KiwixHit => !!h);
    if (!round.length) break;
    for (const h of round) if (!merged.some((m) => m.url === h.url)) merged.push(h);
  }
  return merged.slice(0, count);
}

/** A search's hits as lines under a heading naming the copy, for web_search; "" without hits. */
export function kiwixLines(hits: KiwixHit[]): string {
  if (!hits.length) return "";
  const copies = [...new Map(hits.map((h) => [h.book.id, h.book])).values()].map((b) => `${b.title}${b.date ? ` ${b.date.slice(0, 7)}` : ""}`);
  const lines = [`Offline copy of ${copies.join(", ")}:`];
  for (const h of hits) {
    lines.push(`- ${h.title}`, `  ${h.url}`);
    if (h.snippet) lines.push(`  ${h.snippet}`);
  }
  return lines.join("\n");
}

/** The article `url` asks for, as [book, path] when it is a wikipedia.org page a book copies, or a page on kiwix-serve itself. */
function locate(address: string, url: URL, all: KiwixBook[]): { book: KiwixBook; title: string }[] | { book: KiwixBook; path: string } | undefined {
  const wiki = /^([a-z-]+)(?:\.m)?\.wikipedia\.org$/.exec(url.hostname.toLowerCase());
  if (wiki && url.pathname.startsWith("/wiki/")) {
    let title: string;
    try { title = decodeURIComponent(url.pathname.slice("/wiki/".length)); } catch { return undefined; }
    const books = all.filter((b) => b.wiki === wiki[1]);
    return books.length && title ? books.map((book) => ({ book, title })) : undefined;
  }
  if (url.href.startsWith(`${address}/content/`)) {
    const [id, ...rest] = url.pathname.slice(new URL(address).pathname.replace(/\/$/, "").length + "/content/".length).split("/");
    const book = all.find((b) => b.id === decodeURIComponent(id ?? ""));
    if (book && rest.length) return { book, path: decodeURIComponent(rest.join("/")) };
  }
  return undefined;
}

/** The path in `book` of the article titled `title`: under A/ as Wikipedia's dumps keep it, bare, or what kiwix-serve suggests for it. */
async function pathOf(address: string, book: KiwixBook, title: string, signal?: AbortSignal, f: typeof fetch = fetch): Promise<string | undefined> {
  const want = title.replace(/_/g, " ").toLowerCase();
  const id = encodeURIComponent(book.id);
  for (const path of [`A/${title}`, title, `A/${title}.html`, `${title}.html`]) {
    const res = await get(address, `/raw/${id}/content/${encodeURI(path)}`, PAGE_MS, signal, f).catch(() => undefined);
    if (res?.ok) { await res.body?.cancel(); return path; }
  }
  const res = await get(address, `/suggest?content=${id}&term=${encodeURIComponent(title.replace(/_/g, " "))}&count=10`, PAGE_MS, signal, f).catch(() => undefined);
  if (!res?.ok) return undefined;
  let list: { value?: string; kind?: string; path?: string }[];
  try { list = await res.json() as typeof list; } catch { return undefined; }
  return list.find((s) => s.kind === "path" && s.path && (s.value ?? "").replace(/_/g, " ").toLowerCase() === want)?.path;
}

/** What the offline copy gives web_fetch: a page as Markdown, or a picture's bytes, and which copy it came from. */
export type KiwixRead = { copy: string } & ((FetchedPage & { pictures?: KiwixPicture[] }) | { image: Buffer; mimeType: string });

/** A picture an article shows: its address on kiwix-serve and its alt text. */
export interface KiwixPicture { src: string; alt: string }

/** How many of an article's pictures are listed under it, and how large a picture may be. */
const PICTURES = 12, PICTURE_MB = 5;

/**
 * The page's HTML as Markdown, headed as web_fetch's pages are, with links
 * made absolute against `url`, then its pictures (a maxi copy has them) as
 * their addresses on kiwix-serve, which web_fetch reads as images.
 */
function page(address: string, url: string, html: string, book: KiwixBook, here: string): KiwixRead {
  const copy = copyName(book);
  const md = htmlMarkdown(html, url);
  const pictures: KiwixPicture[] = [];
  try {
    const { document } = parseHTML(html);
    for (const img of document.querySelectorAll("img[src]")) {
      let src: string;
      try { src = new URL(img.getAttribute("src")!, here).href; } catch { continue; }
      if (!src.startsWith(`${address}/content/${encodeURIComponent(book.id)}/`) || pictures.some((p) => p.src === src)) continue;
      const alt = (img.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
      pictures.push({ src, alt });
      if (pictures.length >= PICTURES) break;
    }
  } catch { /* the text alone */ }
  const list = pictures.map((p, i) => `${i + 1}. ${p.src}${p.alt ? ` (${p.alt})` : ""}`).join("\n");
  return { text: pictures.length ? `${md.text}\n\nPictures, each readable with web_fetch:\n${list}` : md.text, copy, pictures };
}

/**
 * An article of the offline copy for the web UI to show, as Markdown: the
 * page web_fetch reads (`kiwixPage`), with its pictures as Markdown images
 * at the end instead of web_fetch's list. Undefined for a picture, a page no
 * book has, any other URL, or kiwix-serve not answering: never online.
 */
export async function kiwixArticle(address: string, url: string, signal?: AbortSignal, f: typeof fetch = fetch): Promise<{ copy: string; text: string } | undefined> {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return undefined;
  const read = await kiwixPage(address, u, signal, f, true).catch(() => undefined);
  if (!read || "image" in read || read.isError) return undefined;
  const pictures = read.pictures ?? [];
  const body = pictures.length ? read.text.slice(0, read.text.lastIndexOf("\n\nPictures, each readable with web_fetch:")) : read.text;
  const alt = (s: string) => s.replace(/[[\]\\]/g, "");
  return { copy: read.copy, text: pictures.length ? `${body}\n\n## Pictures\n\n${pictures.map((p) => `![${alt(p.alt)}](<${p.src}>)`).join("\n\n")}` : body };
}

/**
 * A picture of kiwix-serve's own, for the web UI to show in a message (docs/ux.md §6): only an image under the
 * address's /content/, at most PICTURE_MB, and nothing from any other host, so showing one tells nobody outside
 * the server. Undefined for anything else.
 */
export async function kiwixPicture(address: string, url: string, signal?: AbortSignal, f: typeof fetch = fetch): Promise<{ bytes: Buffer; mimeType: string } | undefined> {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  const base = `${address}/content/`;
  if (!u.href.startsWith(base) || u.search || u.username || u.password) return undefined;
  const [book, ...path] = u.href.slice(base.length).replace(/#.*$/, "").split("/");
  if (!book || !path.join("")) return undefined;
  let res: Response;
  try { res = await get(address, `/raw/${book}/content/${path.join("/")}`, PAGE_MS, signal, f); } catch { return undefined; }
  // A redirect kiwix-serve gives stays on kiwix-serve.
  if (!res.ok || (res.url && !res.url.startsWith(`${address}/`))) { await res.body?.cancel(); return undefined; }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) { await res.body?.cancel(); return undefined; }
  if (Number(res.headers.get("content-length") ?? 0) > PICTURE_MB * 1_000_000) { await res.body?.cancel(); return undefined; }
  const bytes = Buffer.from(await res.arrayBuffer());
  return bytes.length > PICTURE_MB * 1_000_000 ? undefined : { bytes, mimeType: type };
}

/** A WebP as PNG through ImageMagick on lyricad's PATH (the sandbox tools' on NixOS), for models whose reader has no WebP; as it is without ImageMagick. */
export async function pictureForModel(bytes: Buffer, mimeType: string): Promise<{ image: Buffer; mimeType: string }> {
  if (mimeType !== "image/webp") return { image: bytes, mimeType };
  const tried = await new Promise<Buffer | undefined>((resolve) => {
    const child = spawn("sh", ["-c", 'if command -v magick >/dev/null; then im=magick; elif command -v convert >/dev/null; then im=convert; else exit 3; fi; exec "$im" -limit memory 256MiB -limit map 512MiB -limit area 64MP webp:- png:-'], { stdio: ["pipe", "pipe", "ignore"] });
    const out: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 && out.length ? Buffer.concat(out) : undefined); });
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
  return tried ? { image: tried, mimeType: "image/png" } : { image: bytes, mimeType };
}

/**
 * The article at `url` from the offline copy: a wikipedia.org page whose
 * language a book copies (read by its title, then as kiwix-serve suggests
 * it), or a page of kiwix-serve's own. Undefined when no book has it, so
 * web_fetch goes online; an error only when kiwix-serve can't be asked.
 * `pagesOnly`: a picture is undefined, without reading its bytes.
 */
export async function kiwixPage(address: string, url: URL, signal?: AbortSignal, f: typeof fetch = fetch, pagesOnly = false): Promise<KiwixRead | undefined> {
  const where = locate(address, url, await books(address, signal, f));
  if (!where) return undefined;
  const read = async (book: KiwixBook, path: string): Promise<KiwixRead | undefined> => {
    const res = await get(address, `/raw/${encodeURIComponent(book.id)}/content/${encodeURI(path)}`, PAGE_MS, signal, f);
    if (!res.ok) return undefined;
    const here = `${address}/content/${encodeURIComponent(book.id)}/${encodeURI(path)}`;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const copy = copyName(book);
    if (/^image\/(png|jpeg|gif|webp)$/.test(type)) {
      // A page-only read (the web UI's article) never reads or converts a picture.
      if (pagesOnly) { await res.body?.cancel(); return undefined; }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > PICTURE_MB * 1_000_000) return { copy, text: `The picture at ${url.href} is larger than ${PICTURE_MB} MB.`, isError: true };
      return { copy, ...await pictureForModel(bytes, type) };
    }
    if (type && !/^(text\/html|application\/xhtml\+xml)$/.test(type)) return { copy, text: `${url.href} is ${type}, not a page: web_fetch reads only HTML, text and pictures from the offline copy.`, isError: true };
    return page(address, book.wiki ? url.href : here, await res.text(), book, here);
  };
  if (!Array.isArray(where)) return read(where.book, where.path);
  for (const { book, title } of where) {
    const path = await pathOf(address, book, title, signal, f);
    if (!path) continue;
    const got = await read(book, path);
    if (got) return got;
  }
  return undefined;
}
