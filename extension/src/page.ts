// Principles 1 and 8: one tool for what every page-building thread made for itself (docs/briefs/page-tools.md).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { bundlePage, checkPage, decodePng, describeCheck, maskSecrets, pixelStats, PREVIEW_SCRIPT, sandboxHas, sandboxTools, WORKDIR, type PreviewOutput } from "@lyrica/core";
import { posix } from "node:path";
import { Type, type Static } from "typebox";
import { recording, type ThreadTools } from "./workspace.ts";

export const pageParameters = Type.Object({
  action: StringEnum(["preview", "bundle", "check"] as const),
  path: Type.String({ description: "The page's HTML file." }),
  out: Type.Optional(Type.String({ description: "For bundle: the file to write; <name>.single.html beside the page if left out." })),
  width: Type.Optional(Type.Integer({ minimum: 200, maximum: 4096, description: "For preview: the window's width, 1280 if left out." })),
  height: Type.Optional(Type.Integer({ minimum: 200, maximum: 4096, description: "For preview: the window's height, 800 if left out." })),
  query: Type.Optional(Type.String({ description: "For preview: URL parameters, such as seed=3&debug=1." })),
  wait: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000, description: "For preview: milliseconds to wait after the page loads before the screenshot, 1000 if left out." })),
});
export type PageArgs = Static<typeof pageParameters>;

/** Where a bundle goes: `out`, or `<name>.single.html` beside the page. */
export function bundleOut(path: string, out?: string): string {
  if (out) return out;
  const dir = posix.dirname(path), name = posix.basename(path).replace(/\.html?$/i, "");
  return posix.join(dir, `${name}.single.html`);
}

/** How long a page may take to fire its load event before the screenshot is taken anyway. */
const LOAD_MS = 20_000;
const pct = (x: number) => `${x >= 0.1 || x === 0 ? Math.round(x * 100) : (x * 100).toFixed(1)}%`;
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * The page tool: its gate (asking, Plan mode, the same-file hold) is the workspace extension's; `check` throws if the
 * call isn't what was approved. `browser`: whether the sandbox has Chromium and node, which only preview needs.
 */
export function pageTool(tools: ThreadTools, check: (id: string, input: Record<string, unknown>) => void,
  browser = () => !!sandboxTools().browser && sandboxHas("node")): ToolDefinition {
  return {
    name: "page",
    label: "Page",
    description: "Work on an HTML page in your sandbox. preview: open it in headless Chromium (WebGL works, the network is blocked) and get a screenshot, "
      + "console messages, errors, blocked requests, its canvases and pixel stats. bundle: make one self-contained HTML file of it and its local scripts "
      + "(with their imports and the offline libraries), stylesheets and images, then check that. check: list what it would still load from the network or other files.",
    promptSnippet: "preview an HTML page (screenshot, errors, pixel stats), bundle it into one file, or check it loads nothing from elsewhere",
    promptGuidelines: ["Check a page with page preview, not a screenshot script of your own; read its errors before its pixels.",
      "When the person wants one file, page bundle it, then preview the bundle."],
    parameters: pageParameters,
    async execute(id, p: PageArgs, signal) {
      check(id, p);
      const target = tools.target();
      const cwd = await target.cwd();
      const file = posix.resolve(cwd, p.path);
      const text = (t: string) => ({ type: "text" as const, text: t });
      if (p.action === "check") {
        const html = (await target.ops().read.readFile(file)).toString("utf8");
        return { content: [text(`${file}: ${describeCheck(checkPage(html))}`)], details: undefined };
      }
      if (p.action === "bundle") {
        const out = posix.resolve(cwd, bundleOut(p.path, p.out));
        if (out === file) throw new Error("bundle would write over the page itself: give another out.");
        const read = (path: string) => target.ops().read.readFile(path);
        const { html, inlined } = await bundlePage(file, read);
        const write = recording(target, target.ops().write, id, tools.recordChange);
        await write.mkdir(posix.dirname(out));
        await write.writeFile(out, html);
        tools.madeFiles?.([out]);
        const names = inlined.map((f) => (f.startsWith(`${posix.dirname(file)}/`) ? f.slice(posix.dirname(file).length + 1) : f));
        const listed = names.length > 10 ? `${names.slice(0, 10).join(", ")} and ${names.length - 10} more` : names.join(", ");
        return { content: [text(`Bundled ${file} into ${out} (${kb(Buffer.byteLength(html))})${names.length ? `, inlining ${listed}` : ""}.\n${describeCheck(checkPage(html))}`)], details: undefined };
      }
      if (!target.run || !browser()) throw new Error("page preview needs Chromium and Node in the sandbox, and this host's sandbox lacks them.");
      await target.ops().read.access(file);
      const [w, h, wait] = [p.width ?? 1280, p.height ?? 800, p.wait ?? 1000];
      const query = p.query?.replace(/^\?/, "");
      const url = `file://${encodeURI(file)}${query ? `?${query}` : ""}`;
      const r = await target.run(["node", "-e", PREVIEW_SCRIPT, url, String(w), String(h), String(wait), String(LOAD_MS)], { signal, timeoutMs: LOAD_MS + wait + 30_000 });
      const line = maskSecrets(r.stdout, target.secrets?.() ?? []).toString("utf8").trim().split("\n").pop() ?? "";
      let o: PreviewOutput;
      try { o = JSON.parse(line) as PreviewOutput; } catch { throw new Error(`Preview failed: ${r.stderr.toString("utf8").trim().slice(-500) || `exit ${r.code}`}`); }
      const lines = [`Previewed ${file}${query ? `?${query}` : ""} at ${w}×${h}: ${o.loaded ? "loaded" : `still loading after ${LOAD_MS / 1000} s`}${o.title ? `, titled "${o.title}"` : ""}.`];
      if (o.errors.length) lines.push(`Errors (${o.errors.length}):`, ...o.errors.slice(0, 10).map((e) => `- ${e}`));
      if (o.console.length) lines.push(`Console (${o.console.length}):`, ...o.console.slice(0, 20).map((c) => `- [${c.level}] ${c.text}`));
      if (o.blocked.length) lines.push(`Blocked network requests: ${o.blocked.join(", ")}.`);
      if ([...o.errors, ...o.console.map((c) => c.text)].some((t) => t.includes("Failed to resolve module specifier"))) {
        lines.push("A module imports a library by name: page bundle resolves the offline libraries, so preview the bundle.");
      }
      if (!o.png) throw new Error([...lines, `Preview failed: ${o.fail ?? "no screenshot"}`].join("\n"));
      if (o.canvases) lines.push(o.canvases.length ? `Canvases: ${o.canvases.map(([cw, ch]) => `${cw}×${ch}`).join(", ")}.` : "No canvas.");
      const png = Buffer.from(o.png, "base64");
      const stats = pixelStats(decodePng(png));
      lines.push(`${pct(stats.drawn)} of pixels differ from the background ${stats.background}. Commonest colours: ${stats.colours.map((c) => `${c.colour} ${pct(c.share)}`).join(", ")}.`);
      if (stats.drawn < 0.005) lines.push("The page looks blank: almost every pixel is the background colour.");
      // The screenshot is kept for the person to see; a project chat's folder is read-only, so there it is only shown to her.
      const shot = posix.join(WORKDIR, "previews", `${posix.basename(file).replace(/\.html?$/i, "")}-${w}x${h}.png`);
      try {
        await target.ops().write.mkdir(posix.dirname(shot));
        await target.ops().write.writeFile(shot, png);
        tools.madeFiles?.([shot]);
        lines.push(`Screenshot saved as ${shot}.`);
      } catch { /* not saved */ }
      return { content: [text(lines.join("\n")), { type: "image" as const, data: o.png, mimeType: "image/png" }], details: undefined };
    },
  } as ToolDefinition;
}
