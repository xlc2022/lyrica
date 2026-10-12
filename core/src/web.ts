import { convert } from "html-to-text";
import type { Db } from "./db.ts";

// Her web_search and web_fetch (DESIGN.md, "Switches in the message box").
// Search goes to one SearXNG an administrator sets for the server, from
// lyricad. A fetch runs in the thread's sandbox, so its network switches
// govern it; lyricad only turns the page into text.

const KEY = "web.searxng";

/** The server's SearXNG address (self.db `settings`), or null. */
export function searxngAddress(self: Db): string | null {
  const row = self.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  return row?.value || null;
}

/** What the API shows of an address: never its password, only whether there is one. */
export function searxngView(address: string | null): { searxng: string | null; auth: boolean } {
  if (!address) return { searxng: null, auth: false };
  const url = new URL(address);
  const auth = !!url.password;
  url.password = "";
  return { searxng: url.href.replace(/\/+$/, ""), auth };
}

/**
 * Sets or clears it; an http(s) URL, kept without a trailing slash. An
 * address with the stored one's user@host and no password keeps the stored
 * password, since the API never shows it; a new password replaces it.
 */
export function setSearxngAddress(self: Db, address: string | null): string | null {
  let a = checkSearxng(address);
  const stored = searxngAddress(self);
  if (a && stored) {
    const url = new URL(a);
    const was = new URL(stored);
    if (url.username && !url.password && was.password && url.username === was.username && url.host === was.host) {
      url.password = was.password;
      a = url.href.replace(/\/+$/, "");
    }
  }
  if (a) self.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(KEY, a);
  else self.prepare("DELETE FROM settings WHERE key = ?").run(KEY);
  return a;
}

function checkSearxng(address: string | null): string | null {
  const a = String(address ?? "").trim();
  if (!a) return null;
  let url: URL;
  try { url = new URL(a); } catch { throw new Error("the SearXNG address is a URL, like https://search.example.org"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the SearXNG address starts with http:// or https://");
  if (url.search || url.hash) throw new Error("the SearXNG address has no query or fragment");
  return url.href.replace(/\/+$/, "");
}

/** A request to SearXNG: fetch refuses credentials in a URL, so user:password@ becomes basic auth. */
function request(address: string, path: string): { url: string; headers: Record<string, string> } {
  const url = new URL(address + path);
  const headers: Record<string, string> = { accept: "application/json" };
  if (url.username || url.password) {
    headers.authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
    url.username = url.password = "";
  }
  return { url: url.href, headers };
}

const SEARCH_MS = 15_000;

/** One search, as JSON; an error says plainly what failed. */
async function searchJson(address: string, query: string, signal?: AbortSignal, f: typeof fetch = fetch): Promise<SearxngReply> {
  const { url, headers } = request(address, `/search?q=${encodeURIComponent(query)}&format=json`);
  const timeout = AbortSignal.timeout(SEARCH_MS);
  let res: Response;
  try {
    res = await f(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    if (timeout.aborted) throw new Error(`SearXNG didn't answer within ${SEARCH_MS / 1000} seconds.`);
    throw new Error(`SearXNG can't be reached: ${(err as Error & { cause?: Error }).cause?.message ?? (err as Error).message}.`);
  }
  if (res.status === 403) throw new Error("SearXNG answered 403: is the json format enabled in its settings.yml (search.formats)?");
  if (res.status === 429) throw new Error("SearXNG answered 429: its limiter refused the search. Turn server.limiter off for a private instance.");
  if (res.status === 401) throw new Error("SearXNG answered 401: the address needs its user and password.");
  if (!res.ok) throw new Error(`SearXNG answered ${res.status}.`);
  try {
    return await res.json() as SearxngReply;
  } catch {
    throw new Error("SearXNG didn't answer with JSON: is the address its base URL?");
  }
}

interface SearxngReply {
  results?: { title?: string; url?: string; content?: string }[];
  answers?: (string | { answer?: string })[];
  infoboxes?: { infobox?: string; content?: string }[];
}

/** Whether SearXNG answers a search in JSON, and if not, why. */
export async function searxngStatus(address: string | null, f: typeof fetch = fetch): Promise<{ state: "reachable" | "unreachable" | "unset"; reason?: string }> {
  if (!address) return { state: "unset" };
  try {
    await searchJson(address, "searxng", undefined, f);
    return { state: "reachable" };
  } catch (err) {
    return { state: "unreachable", reason: (err as Error).message };
  }
}

/** `web_search`: up to `count` results as title, URL and snippet, after an answer or infobox if SearXNG has one. */
export async function searxngSearch(address: string, query: string, count: number, signal?: AbortSignal, f: typeof fetch = fetch): Promise<string> {
  const reply = await searchJson(address, query, signal, f);
  const oneLine = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  const answer = reply.answers?.map((a) => oneLine(typeof a === "string" ? a : a.answer)).find(Boolean);
  if (answer) lines.push(`Answer: ${answer}`);
  const box = reply.infoboxes?.[0];
  const boxLine = box && oneLine(box.content).split(/(?<=\.)\s/)[0];
  if (boxLine) lines.push(`${oneLine(box.infobox) || "Infobox"}: ${boxLine}`);
  if (lines.length) lines.push("");
  const results = (reply.results ?? []).filter((r) => r.url).slice(0, count);
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${oneLine(r.title) || r.url}`, `   ${r.url}`);
    const snippet = oneLine(r.content);
    if (snippet) lines.push(`   ${snippet}`);
  });
  if (!results.length) lines.push(`No results for "${query}".`);
  return lines.join("\n");
}

/** Bounds a tool's number argument: a default, then 1 to max. */
export const clamp = (n: number | undefined, fallback: number, max: number): number =>
  Math.min(max, Math.max(1, Math.floor(Number.isFinite(n) ? n! : fallback)));

/**
 * The command `web_fetch` runs in the thread's sandbox: the URL is one argv
 * entry, never part of a shell string. The status and content type go to
 * stderr after the body.
 */
export function fetchArgv(url: string): string[] {
  return [
    "curl", "-sS", "-L", "--proto", "=http,https", "--proto-redir", "=http,https", "--max-redirs", "5",
    "--max-time", "20", "--max-filesize", "2000000", "--compressed",
    "-H", "Accept: text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.5",
    "-w", "%{stderr}\nLYRICA-FETCH %{http_code} %{content_type}\n",
    "--url", url,
  ];
}

/** What a curl exit code means, in words. */
const CURL: Record<number, string> = {
  6: "the name doesn't resolve from this thread's sandbox", 7: "the connection was refused or isn't allowed from this thread's sandbox",
  28: "it took longer than 20 seconds", 47: "it redirected more than 5 times", 63: "the page is larger than 2 MB",
  1: "only http and https can be fetched", 35: "the TLS handshake failed", 60: "its certificate isn't trusted",
};

/** The page from curl's output: readable text, cut to maxChars, or an error saying what failed. */
export function fetchedPage(url: string, r: { code: number | null; stdout: Buffer; stderr: Buffer }, maxChars: number): { text: string; isError?: boolean } {
  const err = r.stderr.toString("utf8");
  const meta = /LYRICA-FETCH (\d{3}) ?(.*)$/m.exec(err);
  if (r.code !== 0) {
    const said = err.split("\n").find((l) => l.startsWith("curl:"))?.replace(/^curl: \(\d+\) /, "");
    return { text: `Couldn't fetch ${url}: ${CURL[r.code ?? -1] ?? said ?? `curl exited with ${r.code}`}.`, isError: true };
  }
  const status = Number(meta?.[1] ?? 0);
  if (status >= 400) return { text: `${url} answered ${status}.`, isError: true };
  const type = (meta?.[2] ?? "").split(";")[0]!.trim().toLowerCase();
  const body = r.stdout.toString("utf8");
  const html = type === "text/html" || type === "application/xhtml+xml" || (!type && /^\s*<(!doctype html|html)/i.test(body));
  const plain = !html && (!type || type.startsWith("text/") || /^application\/([\w.+-]*\+)?(json|xml)$/.test(type) || type === "application/javascript");
  if (!html && !plain) return { text: `${url} is ${type}, not a page: web_fetch reads only HTML and text.`, isError: true };
  const text = html ? htmlText(body, url) : body.trim();
  if (text.length <= maxChars) return { text };
  return { text: `${text.slice(0, maxChars)}\n\n[Cut at ${maxChars} of ${text.length} characters.]` };
}

/** A page's readable text: headings, paragraphs, list items, and links with their URL; no scripts, styles or navigation. */
export function htmlText(html: string, baseUrl?: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      ...["script", "style", "noscript", "nav", "template", "svg", "iframe", "form", "img", "head"].map((selector) => ({ selector, format: "skip" })),
      { selector: "a", options: { hideLinkHrefIfSameAsText: true, ignoreHref: false, noAnchorUrl: true, ...(baseUrl ? { pathRewrite: (path: string) => { try { return new URL(path, baseUrl).href; } catch { return path; } } } : {}) } },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })),
      { selector: "table", format: "dataTable" },
    ],
  }).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
