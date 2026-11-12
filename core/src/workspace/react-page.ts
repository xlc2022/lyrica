// Principles 1 and 2: React artifacts render offline; source imports have a structural boundary.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { LIBRARIES, script } from "./page.ts";

const base = dirname(fileURLToPath(import.meta.url));
const names = ["react", "react-dom", "lucide-react", "recharts", ...LIBRARIES.map((l) => l.name)];

function packageDir(name: string, from = base): string {
  for (let at = from; ; at = dirname(at)) {
    const dir = join(at, "node_modules", name);
    if (existsSync(join(dir, "package.json"))) return realpathSync(dir);
    if (dirname(at) === at) throw new Error(`React page library "${name}" is not installed.`);
  }
}
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
  version: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
};

/** The packages a React artifact may import, with their installed versions. */
export function reactLibraries(): { name: string; version: string }[] {
  return names.map((name) => ({ name, version: manifest(packageDir(name)).version }));
}

/** One self-contained HTML page that renders the component `source` exports by default. */
export async function buildReactPage(source: string, opts: { loader: "jsx" | "tsx"; title?: string }): Promise<{ html: string; imports: string[] }> {
  // Inspect exports without resolving imports or running the component.
  const parsed = await build({ stdin: { contents: source, loader: opts.loader }, write: false,
    format: "esm", metafile: true, jsx: "preserve", logLevel: "silent", tsconfigRaw: {} });
  if (!Object.values(parsed.metafile!.outputs).some((o) => o.exports.includes("default"))) {
    throw new Error("The React component must have a default export.");
  }
  // What the component imports must resolve inside an installed library folder or one of its declared dependencies.
  const roots = new Set<string>();
  const add = (dir: string) => {
    if (roots.has(dir)) return;
    roots.add(dir);
    const pkg = manifest(dir);
    for (const name of Object.keys(pkg.dependencies ?? {})) add(packageDir(name, dir));
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
      if (name.startsWith("@types/")) continue;
      let peer: string;
      try { peer = packageDir(name, dir); } catch { continue; } // Optional peers need not be installed.
      add(peer);
    }
  };
  names.forEach((name) => add(packageDir(name)));
  const explicitImports = new Set(Object.values(parsed.metafile!.outputs).flatMap((o) => o.imports.map((i) => i.path)));
  const imports = new Set<string>();
  const plugin: Plugin = { name: "react-page-libraries", setup(b) {
    b.onResolve({ filter: /^entry$/ }, (args) => (args.kind === "entry-point" ? { path: "entry", namespace: "react-page" } : undefined));
    // Only what the entry and the component import comes through here: the closed list is checked, and the package
    // must be one of the installed libraries. What a library imports inside itself esbuild resolves on its own; a
    // callback for each of a chart library's thousands of modules made one build take most of a minute.
    b.onResolve({ filter: /.*/, namespace: "react-page" }, async (args) => {
      if (args.pluginData === "resolving") return;
      if (args.path === "component" && args.importer === "entry") return { path: "component", namespace: "react-page" };
      const name = names.find((n) => args.path === n || ((n === "react" || n === "react-dom" || n === "three") && args.path.startsWith(`${n}/`)));
      if (!name || args.path.split("/").some((p) => p === "." || p === "..") || args.path.includes("\\")) {
        throw new Error(`Import "${args.path}" is not allowed. Allowed packages: ${names.join(", ")}.`);
      }
      if (args.importer === "component" && explicitImports.has(args.path)) imports.add(name);
      const resolved = await b.resolve(args.path, { resolveDir: base, kind: args.kind, pluginData: "resolving" });
      if (resolved.errors.length) return { errors: resolved.errors };
      const path = realpathSync(resolved.path);
      if (![...roots].some((dir) => path.startsWith(dir + sep))) throw new Error(`Import "${args.path}" resolves outside the React page libraries.`);
      return { path, sideEffects: resolved.sideEffects };
    });
    b.onLoad({ filter: /.*/, namespace: "react-page" }, (args) => args.path === "entry"
      ? { contents: 'import Component from "component"; import { createRoot } from "react-dom/client"; import { createElement } from "react"; createRoot(document.getElementById("root")).render(createElement(Component));', loader: "js" }
      : { contents: source, loader: opts.loader });
  } };
  const result = await build({ entryPoints: ["entry"], bundle: true, write: false, format: "esm", platform: "browser",
    minify: true, target: "es2022", jsx: "automatic", legalComments: "none", logLevel: "silent", tsconfigRaw: {},
    define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin] });
  const tailwind = readFileSync(join(packageDir("@tailwindcss/browser"), "dist/index.global.js"), "utf8");
  const title = (opts.title ?? "Artifact").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return { html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><script>${script(tailwind)}</script></head><body><div id="root"></div><script type="module">${script(result.outputFiles[0]!.text)}</script></body></html>`, imports: [...imports].sort() };
}
