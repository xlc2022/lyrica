import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReactPage, reactLibraries } from "../src/workspace/react-page.ts";
import { checkPage } from "../src/workspace/page.ts";

const source = `import { useState } from "react";
import { Smile } from "lucide-react";
import { LineChart, Line } from "recharts";
export default function Artifact() {
  const [count, setCount] = useState(0);
  return <main className="p-4"><button onClick={() => setCount(count + 1)}>Count {count}</button><Smile />
    <LineChart width={300} height={150} data={[{ value: 2 }, { value: 4 }]}><Line dataKey="value" /></LineChart></main>;
}`;
const chromium = ["chromium", "chromium-headless-shell", "chromium-browser"].find((name) => {
  try { execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }); return true; } catch { return false; }
});

describe("React artifact pages (principles 1 and 2)", () => {
  it("bundles state, icons and charts into one offline page", async () => {
    const { html, imports } = await buildReactPage(source, { loader: "jsx" });
    expect(checkPage(html)).toEqual({ loads: [], calls: [], local: [] });
    expect(imports).toEqual(["lucide-react", "react", "recharts"]);
    expect(html).toContain("<title>Artifact</title>");
    expect(html.match(/<script type="module">/g)).toHaveLength(1);
    console.info(`React test component page: ${Buffer.byteLength(html)} bytes`);
    expect(reactLibraries()).toEqual(expect.arrayContaining([
      { name: "react", version: "19.3.1" }, { name: "recharts", version: expect.any(String) },
    ]));
  });

  it.each(["./sibling.jsx", "/etc/passwd", "node:fs", "unknown-package", "react/../../package.json"])("refuses import %s", async (name) => {
    await expect(buildReactPage(`import value from ${JSON.stringify(name)}; export default () => <div>{value}</div>;`, { loader: "jsx" }))
      .rejects.toThrow(`Import "${name}" is not allowed. Allowed packages:`);
  });

  it.each(["export const Component = () => <div />;", "const Component = () => <div />;"])("requires a default export", async (code) => {
    await expect(buildReactPage(code, { loader: "jsx" })).rejects.toThrow("The React component must have a default export.");
  });

  it("escapes the title and embedded closing script tags", async () => {
    const { html } = await buildReactPage('export default () => <div>{"</script><script>bad()</script>"}</div>;', { loader: "jsx", title: '<test> & "title"' });
    expect(html).toContain("<title>&lt;test&gt; &amp; &quot;title&quot;</title>");
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });

  it("compiles TSX with types", async () => {
    const { html, imports } = await buildReactPage('type Props = { text?: string }; export default function Component({ text = "Typed" }: Props) { return <div>{text}</div>; }', { loader: "tsx" });
    expect(html).toContain("Typed");
    expect(imports).toEqual([]);
  });

  it.skipIf(!chromium)("renders the component in headless Chromium", async () => {
    const dir = mkdtempSync(join(tmpdir(), "react-page-test-"));
    try {
      const { html } = await buildReactPage(source, { loader: "jsx" });
      const path = join(dir, "page.html");
      writeFileSync(path, html); // Synthetic component only; never thread text.
      const dom = execFileSync(chromium!, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        `--user-data-dir=${join(dir, "profile")}`, "--virtual-time-budget=3000", "--dump-dom", `file://${path}`], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }).toString();
      expect(dom).toMatch(/<button[^>]*>Count 0<\/button>/);
      expect(dom).toContain("recharts-surface");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);
});
