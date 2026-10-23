import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bundlePage, checkPage, decodePng, describeCheck, libraryDirs, librariesLine, LIBS, pixelStats } from "../src/index.ts";

/** A PNG of `rows` (each [r, g, b(, a)] per pixel), each row written with the filter in `filters` (0 to 4). */
function encodePng(rows: number[][][], channels: 3 | 4, filters: number[]): Buffer {
  const width = rows[0]!.length, height = rows.length, stride = width * channels;
  const flat = rows.map((r) => Buffer.from(r.flat()));
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length]!;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? flat[y]![x - channels]! : 0, b = y ? flat[y - 1]![x]! : 0, c = x >= channels && y ? flat[y - 1]![x - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predict = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]!;
      raw[y * (stride + 1) + 1 + x] = (flat[y]![x]! - predict) & 0xff;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const image = (w: number, h: number, at: (x: number, y: number) => number[]) => Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => at(x, y)));

describe("a preview's screenshot", () => {
  // A run read Chromium's 3-channel PNGs as 4-channel and argued for an afternoon over a bug that didn't exist.
  it("decodes RGB and RGBA PNGs with every row filter", () => {
    const rows = image(7, 5, (x, y) => [x * 30, y * 50, (x * y * 13) % 256]);
    for (const channels of [3, 4] as const) {
      const px = rows.map((r) => r.map((p) => (channels === 4 ? [...p, 255] : p)));
      const out = decodePng(encodePng(px, channels, [0, 1, 2, 3, 4]));
      expect(out).toMatchObject({ width: 7, height: 5, channels });
      expect([...out.data]).toEqual(px.flat(2));
    }
  });

  it("refuses what it can't read", () => {
    expect(() => decodePng(Buffer.from("not a png at all, just some text here"))).toThrow(/not a PNG/);
  });

  it("finds the background, how much is drawn on it and the commonest colours", () => {
    // A dark page with a red square over a quarter of it.
    const rows = image(20, 20, (x, y) => (x < 10 && y < 10 ? [255, 0, 0] : [16, 32, 48]));
    const stats = pixelStats(decodePng(encodePng(rows, 3, [1])));
    expect(stats.background).toBe("#102030");
    expect(stats.drawn).toBe(0.25);
    expect(stats.colours.map((c) => [c.colour, c.share])).toEqual([["#102030", 0.75], ["#ff0000", 0.25]]);
  });
});

describe("checking a page", () => {
  it("lists loads from the network, network calls and local files, but not links or data", () => {
    const html = `<link rel="stylesheet" href="https://cdn.example.com/a.css"><script src="//unpkg.example/three.js"></script>
      <img src="sprites/hero.png"><img src="data:image/png;base64,AAAA"><a href="https://example.com/about">about</a>
      <style>@import url("https://fonts.example/f.css"); body { background: url(https://example.com/bg.jpg) }</style>
      <script type="module">import x from "https://esm.example/x.js"; fetch("/api"); new WebSocket("wss://x");</script>`;
    const c = checkPage(html);
    expect([...c.loads].sort()).toEqual(["//unpkg.example/three.js", "https://cdn.example.com/a.css", "https://esm.example/x.js", "https://example.com/bg.jpg", "https://fonts.example/f.css"]);
    expect(c.calls).toEqual(["fetch", "new WebSocket"]);
    expect(c.local).toEqual(["sprites/hero.png"]);
    expect(describeCheck(checkPage("<p>Hi</p>"))).toBe("Nothing loads from the network or from other files.");
  });
});

describe("bundling a page", () => {
  const files: Record<string, string> = {
    "/workspace/site/index.html": `<!doctype html><html><head><link rel="stylesheet" href="css/main.css"><script type="importmap">{"imports":{"util":"./js/util.js"}}</script></head>
<body><img src="img/dot.png" alt="dot"><canvas></canvas>
<script src="js/classic.js"></script>
<script type="module" src="js/app.js"></script>
<script type="module">import { twice } from "util"; console.log(twice(2));</script></body></html>`,
    "/workspace/site/css/main.css": `@import "./base.css"; .hero { background: url(../img/dot.png) }`,
    "/workspace/site/css/base.css": "body { margin: 0 }",
    "/workspace/site/js/classic.js": `window.note = "</script> is safe here"; window.tpl = '<img src="never-read.png">';`,
    "/workspace/site/js/app.js": `import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js"; import { createNoise2D } from "simplex-noise";
import { twice } from "./util.js"; window.parts = [THREE.REVISION, typeof OrbitControls, typeof createNoise2D(), twice(1)];`,
    "/workspace/site/js/util.js": "export const twice = (n) => n * 2;",
  };
  const dot = encodePng([[[255, 0, 0]]], 3, [0]);
  const dirs = new Map(libraryDirs().map((l) => [`${LIBS}/${l.name}`, l.dir]));
  // The sandbox's read: the page's files, and the libraries as /opt/libs mounts them.
  const read = async (path: string) => {
    if (path === "/workspace/site/img/dot.png") return dot;
    if (path in files) return Buffer.from(files[path]!);
    for (const [mount, dir] of dirs) if (path.startsWith(`${mount}/`)) return readFileSync(join(dir, path.slice(mount.length)));
    throw new Error("no such file");
  };

  it("inlines scripts, modules with their imports and the offline libraries, stylesheets and images into one file", async () => {
    const { html, inlined } = await bundlePage("/workspace/site/index.html", read);
    // A tag in a script's string is code, not something to inline: never-read.png isn't read.
    expect(html.replace(/<script\b[^>]*>[^]*?<\/script>/g, "")).not.toMatch(/\ssrc="(?!data:)/);
    expect(html).not.toContain("<link");
    expect(html).not.toContain("importmap");
    expect(html).toContain("margin:0");
    expect(html).toContain(`url(data:image/png;base64,${dot.toString("base64")})`);
    expect(html).toContain(`<img src="data:image/png;base64,${dot.toString("base64")}" alt="dot">`);
    expect(html).toContain(`window.note = "<\\/script> is safe here"; window.tpl = '<img src="never-read.png">';`);
    expect(/<script type="module">([^]*?)<\/script>/.exec(html)![1]!.length).toBeGreaterThan(100_000);
    expect(inlined).toEqual(expect.arrayContaining(["/workspace/site/js/app.js", "/workspace/site/js/util.js", `${LIBS}/three/build/three.module.js`,
      `${LIBS}/three/examples/jsm/controls/OrbitControls.js`, "/workspace/site/css/base.css", "/workspace/site/img/dot.png"]));
    expect(checkPage(html)).toEqual({ loads: [], calls: [], local: [] });
  }, 30_000);

  it("leaves addresses for the check, and says when a name isn't a file or a library", async () => {
    const page = (body: string) => async (path: string) => (path === "/workspace/p.html" ? Buffer.from(body) : read(path));
    const { html } = await bundlePage("/workspace/p.html", page(`<script src="https://cdn.example/lib.js"></script><p>hi</p>`));
    expect(checkPage(html).loads).toEqual(["https://cdn.example/lib.js"]);
    await expect(bundlePage("/workspace/p.html", page(`<script type="module">import "left-pad";</script>`)))
      .rejects.toThrow(/"left-pad" isn't a file or one of the offline libraries/);
    await expect(bundlePage("/workspace/p.html", page(`<script src="missing.js"></script>`))).rejects.toThrow(/no such file/);
  });
});

describe("the libraries", () => {
  it("are found in Lyrica's node_modules and named with their versions", () => {
    const libs = libraryDirs();
    expect(libs.map((l) => l.name)).toEqual(["three", "simplex-noise", "@tweenjs/tween.js"]);
    const three = JSON.parse(readFileSync(posix.join(libs[0]!.dir, "package.json"), "utf8")).version;
    expect(librariesLine(libs)).toContain(`three.js ${three} ("three")`);
    expect(librariesLine([])).toBe("");
  });
});
