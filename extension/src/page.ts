// Principles 1 and 8: one tool for what every page-building thread made for itself (docs/briefs/page-tools.md).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { ARTIFACT_LIMIT, artifactKind, buildReactPage, reactLibraries, bundlePage, checkPage, decodePng, describeCheck, maskSecrets, pixelStats, PREVIEW_SCRIPT, sandboxHas, sandboxTools, type PreviewOutput } from "@lyrica/core";
import { posix } from "node:path";
import { Type, type Static } from "typebox";
import { recording, type ThreadArtifact, type ThreadTools } from "./workspace.ts";

export const pageParameters = Type.Object({
  action: StringEnum(["preview", "bundle", "check", "publish", "artifacts"] as const),
  path: Type.Optional(Type.String({ description: "The page's HTML file. For publish: an .html, .svg, .md, .jsx or .tsx file. Not needed for artifacts." })),
  title: Type.Optional(Type.String({ description: "For publish: the artifact's title; the file's name if left out on its first publish." })),
  artifact: Type.Optional(Type.String({ description: "For publish: the id of the artifact to add a version to, when the file isn't the one it was published from." })),
  out: Type.Optional(Type.String({ description: "For bundle: the file to write; <name>.single.html beside the page if left out." })),
  width: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048, description: "For preview: the window's width, 1280 if left out." })),
  height: Type.Optional(Type.Integer({ minimum: 200, maximum: 2048, description: "For preview: the window's height, 800 if left out." })),
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

/** One line for an artifact in her results. */
const artifactLine = (a: ThreadArtifact) => `${a.id} "${a.title}" (${a.kind}, version ${a.version}${a.path ? `, from ${a.path}` : ""})`;

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
    description: "Work on an HTML page in your sandbox. preview: open it in headless Chromium, offline with WebGL, and get a screenshot, "
      + "console messages, errors, blocked requests, its canvases and pixel stats. bundle: make one self-contained HTML file of it and its local scripts "
      + "(with their imports and the offline libraries), stylesheets and images, then check that. check: list what it would still load from the network or other files. "
      + "publish: keep a self-contained .html, .svg or .md file, or a React component (.jsx or .tsx with a default export), as an artifact the person opens from a card in your reply; publishing the same file again adds a version, and every version is kept. "
      + `A React component may import only ${reactLibraries().map((l) => l.name).join(", ")}, and may use Tailwind classes. `
      + "artifacts: list this thread's artifacts (and its project's).",
    promptSnippet: "preview an HTML page (screenshot, errors, pixel stats), bundle it into one file, check it loads nothing from elsewhere, or publish it as an artifact",
    promptGuidelines: ["Check a page with page preview, not a screenshot script of your own; read its errors before its pixels.",
      "When the person wants one file, page bundle it, then preview the bundle.",
      "page publish a finished page, drawing or document the person will keep or come back to, not every scratch file; publish the same file again after changing it."],
    parameters: pageParameters,
    async execute(id, p: PageArgs, signal) {
      check(id, p);
      const target = tools.target();
      const cwd = await target.cwd();
      const text = (t: string) => ({ type: "text" as const, text: t });
      if (p.action === "artifacts") {
        if (!tools.artifacts) throw new Error("Artifacts aren't available here: publish from the thread itself.");
        const all = tools.artifacts.list();
        return { content: [text(all.length ? all.map(artifactLine).join("\n") : "No artifacts yet.")], details: undefined };
      }
      if (!p.path) throw new Error(`page ${p.action} needs a path.`);
      const file = posix.resolve(cwd, p.path);
      if (p.action === "publish") {
        if (!tools.artifacts) throw new Error("Artifacts aren't available here: publish from the thread itself.");
        const kind = artifactKind(file);
        if (!kind) throw new Error("An artifact is an .html, .svg, .md, .jsx or .tsx file.");
        const bytes = await target.ops().read.readFile(file);
        if (bytes.length > ARTIFACT_LIMIT) throw new Error("An artifact is at most 16 MiB.");
        // A React component is built into one page here, by esbuild alone: its source is compiled, never run, and may import only the listed packages.
        const built = kind === "react" ? Buffer.from((await buildReactPage(bytes.toString("utf8"), { loader: /\.tsx$/i.test(file) ? "tsx" : "jsx", ...(p.title ? { title: p.title } : {}) })).html) : undefined;
        // One file is all an artifact carries: a page that needs files beside it is bundled first.
        const found = kind === "html" ? checkPage(bytes.toString("utf8")) : undefined;
        if (found?.local.length) throw new Error(`${file} refers to local files an artifact can't carry: ${found.local.join(", ")}. Run page bundle and publish the bundle.`);
        const { artifact, created } = tools.artifacts.publish({ path: file, kind, bytes, ...(built ? { built } : {}), ...(p.title ? { title: p.title } : {}), ...(p.artifact ? { artifact: p.artifact } : {}) });
        const lines = [`${created ? "Published" : artifact.version === 1 ? "Already published, unchanged:" : `Published version ${artifact.version} of`} ${artifactLine(artifact)}. The person sees a card for it in this reply.`];
        if (found && (found.loads.length || found.calls.length)) lines.push(describeCheck(found), "With the thread's internet off the page runs no scripts and loads nothing from the network.");
        return { content: [text(lines.join("\n"))], details: { artifact: { id: artifact.id, title: artifact.title, kind: artifact.kind, version: artifact.version } } };
      }
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
      // The page's code runs in a sandbox of its own: no network, no credentials, nothing writable but /tmp.
      const box = tools.previewTarget?.();
      if (!box?.run || !browser()) throw new Error("page preview needs Chromium and Node in the sandbox, and this host's sandbox lacks them.");
      await box.ops().read.access(file);
      const [w, h, wait] = [p.width ?? 1280, p.height ?? 800, p.wait ?? 1000];
      const query = p.query?.replace(/^\?/, "");
      const url = `file://${encodeURI(file)}${query ? `?${query}` : ""}`;
      const r = await box.run(["node", "-e", PREVIEW_SCRIPT, url, String(w), String(h), String(wait), String(LOAD_MS)], { signal, timeoutMs: LOAD_MS + wait + 30_000 });
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
      return { content: [text(lines.join("\n")), { type: "image" as const, data: o.png, mimeType: "image/png" }], details: undefined };
    },
  } as ToolDefinition;
}
