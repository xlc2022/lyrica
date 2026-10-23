// Principles 1 and 8: what every project rebuilt for itself (a screenshot with WebGL, pixel checks, one offline file,
// a 3D library) is one tool's work, and the libraries are already on the machine (docs/briefs/page-tools.md).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { inflateSync } from "node:zlib";
import { build, type Loader, type Plugin } from "esbuild";

/** Where the offline libraries are in every sandbox, read-only. */
export const LIBS = "/opt/libs";

/** The libraries, by package: each is mounted whole at LIBS/<package>, and a bare import of its name resolves to `entry`. */
export const LIBRARIES = [
  { name: "three", entry: "build/three.module.js", label: "three.js", addons: { prefix: "three/addons/", dir: "examples/jsm/" } },
  { name: "simplex-noise", entry: "dist/esm/simplex-noise.js", label: "simplex-noise" },
  { name: "@tweenjs/tween.js", entry: "dist/tween.esm.js", label: "tween.js" },
] as const;

let libs: { name: string; label: string; dir: string; version: string }[] | undefined;
/** Each library's folder in Lyrica's own node_modules, and its version; one that isn't installed is left out. Found once. */
export function libraryDirs(): { name: string; label: string; dir: string; version: string }[] {
  if (libs) return libs;
  const found = [];
  for (const lib of LIBRARIES) {
    for (let at = dirname(new URL(import.meta.url).pathname); ; at = dirname(at)) {
      const dir = join(at, "node_modules", lib.name);
      if (existsSync(join(dir, "package.json"))) {
        found.push({ name: lib.name, label: lib.label, dir, version: String(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version) });
        break;
      }
      if (dirname(at) === at) break;
    }
  }
  return (libs = found);
}

/** The prompt's line on the libraries, or nothing if none is installed. */
export function librariesLine(libs = libraryDirs()): string {
  if (!libs.length) return "";
  const named = libs.map((l) => `${l.label} ${l.version} ("${l.name}")`).join(", ");
  return `Offline libraries, read-only in ${LIBS}: ${named}; three.js addons import as "three/addons/…". Import them by name in a module script and run page bundle to make one file the person can open. Use one rather than writing your own engine.`;
}

/** The preview script, run by the sandbox's node (page-preview.cjs). */
export const PREVIEW_SCRIPT = readFileSync(new URL("./page-preview.cjs", import.meta.url), "utf8");

/** What the preview script prints. */
export interface PreviewOutput {
  console: { level: string; text: string }[];
  errors: string[];
  blocked: string[];
  loaded: boolean;
  title?: string;
  canvases?: [number, number][];
  text?: number;
  png?: string;
  fail?: string;
}

/** An 8-bit, non-interlaced RGB or RGBA PNG (what Chromium writes), as rows of pixels. */
export function decodePng(png: Buffer): { width: number; height: number; channels: 3 | 4; data: Buffer } {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let at = 8, width = 0, height = 0, channels: 3 | 4 = 4;
  const idat: Buffer[] = [];
  while (at + 8 <= png.length) {
    const len = png.readUInt32BE(at), type = png.toString("latin1", at + 4, at + 8), body = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour type ${color}, interlace ${interlace})`);
      channels = color === 2 ? 3 : 4;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels, data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[y * stride + x - channels]! : 0, b = y ? data[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y ? data[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predict = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      if (predict === undefined) throw new Error(`bad PNG filter ${filter}`);
      data[y * stride + x] = (row[x]! + predict) & 0xff;
    }
  }
  return { width, height, channels, data };
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/**
 * The background (the commonest corner colour), how many pixels differ from it by more than a little, and the
 * commonest colours (each channel in 8 steps, shown as the bucket's mean colour, with its share).
 */
export function pixelStats(img: ReturnType<typeof decodePng>): { background: string; drawn: number; colours: { colour: string; share: number }[] } {
  const { width, height, channels, data } = img, n = width * height;
  const at = (i: number) => [data[i * channels]!, data[i * channels + 1]!, data[i * channels + 2]!] as const;
  const corners = [0, width - 1, (height - 1) * width, n - 1].map((i) => at(i));
  const key = (c: readonly number[]) => c.join(",");
  const bg = corners.map((c) => [c, corners.filter((d) => key(d) === key(c)).length] as const).sort((x, y) => y[1] - x[1])[0]![0];
  let drawn = 0;
  const buckets = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < n; i++) {
    const [r, g, b] = at(i);
    if (Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])) > 16) drawn++;
    const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const s = buckets.get(k) ?? [0, 0, 0, 0];
    s[0] += r; s[1] += g; s[2] += b; s[3]++;
    buckets.set(k, s);
  }
  const colours = [...buckets.values()].sort((x, y) => y[3] - x[3]).slice(0, 5)
    .map(([r, g, b, c]) => ({ colour: hex(Math.round(r / c), Math.round(g / c), Math.round(b / c)), share: c / n }));
  return { background: hex(...bg), drawn: n ? drawn / n : 0, colours };
}

/** What a page would still reach outside itself: loads from the network, network calls in its code, and local files. */
export interface PageCheck {
  /** http(s) or protocol-relative addresses it loads: src, href (not a link), url(), @import, import from. */
  loads: string[];
  /** Network calls in its code: fetch, XMLHttpRequest, WebSocket, EventSource, a dynamic import of an address, a worker. */
  calls: string[];
  /** Local files it still refers to, which one file can't carry. */
  local: string[];
}

const LOADS = [
  /<(?!a\b)[a-z][\w-]*\b[^>]*?\s(?:src|href|poster|data)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi,
  /url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi,
  /@import\s+(?:url\()?\s*["']((?:https?:)?\/\/[^"']+)/gi,
  /\b(?:import|from)\s*\(?\s*["']((?:https?:)?\/\/[^"']+)["']/g,
];
const CALLS = /\b(fetch\s*\(|new\s+XMLHttpRequest\b|new\s+WebSocket\b|new\s+EventSource\b|new\s+(?:Shared)?Worker\s*\(|importScripts\s*\(|navigator\.sendBeacon\s*\()/g;
const LOCAL = /<(?!a\b)[a-z][\w-]*\b[^>]*?\s(?:src|href)\s*=\s*["']?(?!data:|blob:|#|javascript:|mailto:|about:|(?:https?:)?\/\/)([^"'\s>]+)/gi;

/** Checks one page's HTML: each list at most 20, without repeats. */
export function checkPage(html: string): PageCheck {
  const found = (patterns: RegExp[]) => [...new Set(patterns.flatMap((p) => [...html.matchAll(p)].map((m) => m[1]!)))].slice(0, 20);
  // A link (<a href>) is somewhere to go, not something loaded; a script's own text is checked for calls, not for links in its strings.
  return {
    loads: found(LOADS),
    calls: [...new Set([...html.matchAll(CALLS)].map((m) => m[1]!.replace(/\s+/g, " ").replace(/\s*\($/, "")))].slice(0, 20),
    // A tag in a script's string is code (a template), so local files are looked for outside scripts' code only.
    local: [...new Set([...html.replace(/(<script\b[^>]*>)[^]*?(<\/script>)/gi, "$1$2").matchAll(LOCAL)].map((m) => m[1]!))]
      .filter((p) => !/^[a-z][\w+.-]*:/i.test(p) || p.startsWith("file:")).slice(0, 20),
  };
}

/** One line per finding, or that there is none. */
export function describeCheck(c: PageCheck): string {
  const lines = [
    ...(c.loads.length ? [`Loads from the network: ${c.loads.join(", ")}.`] : []),
    ...(c.calls.length ? [`Network calls in its code: ${c.calls.join(", ")}. Check they aren't needed offline.`] : []),
    ...(c.local.length ? [`Refers to local files one file can't carry: ${c.local.join(", ")}.`] : []),
  ];
  return lines.length ? lines.join("\n") : "Nothing loads from the network or from other files.";
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm",
};
const ext = (p: string) => posix.extname(p).slice(1).toLowerCase();
const LOADER: Record<string, Loader> = { js: "js", mjs: "js", cjs: "js", jsx: "jsx", ts: "ts", tsx: "tsx", css: "css", json: "json", glsl: "text", vert: "text", frag: "text", txt: "text" };
const remote = (s: string) => /^(?:[a-z][\w+.-]*:|\/\/)/i.test(s) && !s.startsWith("file:");

/** Reads a file as the thread may (its sandbox's read), by absolute path. */
export type ReadFile = (path: string) => Promise<Buffer>;

/** What bundling made: the page, what was inlined, and the import-map entries it used. */
export interface Bundled { html: string; inlined: string[] }

/**
 * One self-contained page from `entry` (an absolute path): its local scripts (module scripts bundled with their
 * imports, bare names resolved by the page's import map or the offline libraries), stylesheets (with their @imports
 * and url()s) and images, each read through `read`. An address is left as it is, for the check to report.
 */
export async function bundlePage(entry: string, read: ReadFile): Promise<Bundled> {
  const base = posix.dirname(entry);
  let html = (await read(entry)).toString("utf8");
  const inlined = new Set<string>();
  const importMap: Record<string, string> = {};
  html = html.replace(/<script\b[^>]*\btype\s*=\s*["']?importmap["']?[^>]*>([\s\S]*?)<\/script>/gi, (all, body: string) => {
    try { Object.assign(importMap, JSON.parse(body).imports ?? {}); return ""; } catch { return all; }
  });
  const local = (ref: string, from = base) => posix.resolve(from, decodeURI(ref.split(/[?#]/)[0]!));
  const libsPlugin: Plugin = {
    name: "lyrica-files",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: args.path, namespace: "file" };
        let spec = args.path;
        const mapped = importMap[spec] ?? Object.entries(importMap).find(([k]) => k.endsWith("/") && spec.startsWith(k));
        if (typeof mapped === "string") spec = mapped;
        else if (mapped) spec = mapped[1] + spec.slice(mapped[0].length);
        if (remote(spec)) return { path: spec, external: true };
        if (!spec.startsWith(".") && !spec.startsWith("/")) {
          const lib = LIBRARIES.find((l) => spec === l.name || ("addons" in l && spec.startsWith(l.addons.prefix)) || spec.startsWith(`${l.name}/`));
          if (!lib) return { errors: [{ text: `"${args.path}" isn't a file or one of the offline libraries (${LIBRARIES.map((l) => l.name).join(", ")})` }] };
          const rest = spec === lib.name ? lib.entry : "addons" in lib && spec.startsWith(lib.addons.prefix) ? lib.addons.dir + spec.slice(lib.addons.prefix.length) : spec.slice(lib.name.length + 1);
          return { path: posix.join(LIBS, lib.name, rest), namespace: "file" };
        }
        const from = args.importer && args.namespace === "file" ? posix.dirname(args.importer) : args.resolveDir || base;
        return { path: local(spec, from), namespace: "file" };
      });
      b.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        const contents = await read(args.path).catch((err: Error) => { throw new Error(`${args.path}: ${err.message}`); });
        inlined.add(args.path);
        const loader = LOADER[ext(args.path)] ?? (MIME[ext(args.path)] ? "dataurl" : undefined);
        if (!loader) return { errors: [{ text: `${args.path}: no way to inline a .${ext(args.path)} file` }] };
        return { contents, loader, resolveDir: posix.dirname(args.path) };
      });
    },
  };
  const bundle = async (input: { file: string } | { code: string; loader: Loader }, format: "esm" | undefined) => {
    const r = await build({
      ...("file" in input ? { entryPoints: [input.file] } : { stdin: { contents: input.code, loader: input.loader, resolveDir: base, sourcefile: entry } }),
      bundle: true, write: false, minify: true, legalComments: "none", format, target: "es2022", logLevel: "silent", plugins: [libsPlugin],
      loader: Object.fromEntries(Object.keys(MIME).map((e) => [`.${e}`, "dataurl" as const])),
    });
    return r.outputFiles[0]!.text.trim();
  };
  const script = (code: string) => code.replace(/<\/(script)/gi, "<\\/$1");
  const style = (code: string) => code.replace(/<\/(style)/gi, "<\\/$1");
  const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);
  /** Replaces each match, awaited; with `outside`, never one inside a script, whose strings may hold tags. */
  const replaceAsync = async (re: RegExp, fn: (m: RegExpExecArray) => Promise<string>, outside = true) => {
    const scripts = outside ? [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map((m) => [m.index!, m.index! + m[0].length]) : [];
    const found = [...html.matchAll(re)].filter((m) => !scripts.some(([a, b]) => m.index! > a! && m.index! < b!));
    const done = await Promise.all(found.map((m) => fn(m as RegExpExecArray)));
    let out = "", at = 0;
    found.forEach((m, i) => { out += html.slice(at, m.index) + done[i]; at = m.index! + m[0].length; });
    html = out + html.slice(at);
  };
  // Inline styles that import or point at files, then stylesheets.
  await replaceAsync(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, async (m) => (/@import|url\(/i.test(m[2]!)
    ? `<style${m[1]}>${style(await bundle({ code: m[2]!, loader: "css" }, undefined))}</style>` : m[0]));
  await replaceAsync(/<link\b[^>]*>/gi, async (m) => {
    const rel = attr(m[0], "rel")?.toLowerCase() ?? "", href = attr(m[0], "href");
    if (href === undefined || remote(href)) return m[0];
    if (rel.split(/\s+/).includes("stylesheet")) return `<style>${style(await bundle({ file: local(href) }, undefined))}</style>`;
    if (rel.split(/\s+/).some((r) => r === "icon" || r === "apple-touch-icon") && MIME[ext(href)]) {
      return m[0].replace(href, await dataUrl(local(href), read, inlined));
    }
    return m[0];
  });
  // Images and media by their src (and a video's poster).
  await replaceAsync(/<(?:img|source|audio|video|input)\b[^>]*>/gi, async (m) => {
    let tag = m[0];
    for (const name of ["src", "poster"]) {
      const v = attr(tag, name);
      if (v !== undefined && !remote(v) && MIME[ext(v.split(/[?#]/)[0]!)]) tag = tag.replace(v, await dataUrl(local(v), read, inlined));
    }
    return tag;
  });
  // Scripts last, so nothing above looks into their code: a local file inlined (a module bundled with its imports),
  // an inline module with imports bundled.
  await replaceAsync(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, async (m) => {
    const open = m[1]!, body = m[2]!;
    const module = /\btype\s*=\s*["']?module/i.test(open);
    const src = attr(`<script${open}>`, "src");
    if (src !== undefined) {
      if (remote(src)) return m[0];
      const file = local(src);
      if (module) return `<script type="module">${script(await bundle({ file }, "esm"))}</script>`;
      const code = (await read(file)).toString("utf8");
      inlined.add(file);
      return `<script${open.replace(/\s+src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")}>${script(code)}</script>`;
    }
    if (module && /\bimport\b/.test(body)) return `<script type="module">${script(await bundle({ code: body, loader: "js" }, "esm"))}</script>`;
    return m[0];
  }, false);
  return { html, inlined: [...inlined] };
}

async function dataUrl(file: string, read: ReadFile, inlined: Set<string>): Promise<string> {
  const bytes = await read(file);
  inlined.add(file);
  return `data:${MIME[ext(file)]};base64,${bytes.toString("base64")}`;
}
