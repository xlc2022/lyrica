// A tool call's arguments laid out for reading (web/src/ToolArgs.tsx, web/src/highlight.tsx): what each value shows
// as, and a script's heredocs coloured as the program they feed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { heredocs, kindOf } from "../src/highlight.tsx";
import { lowlight } from "../src/grammars.ts";
import { ArgList, ToolArgs } from "../src/ToolArgs.tsx";

const SCRIPT = "#!/bin/bash\nset -uo pipefail\nprintf '=== Processes ===\\n'\npython3 - <<'PY'\nimport os\nprint(os.getpid())\nPY\necho done";
const render = (name: string, args: unknown, drafting = false) =>
  renderToStaticMarkup(createElement(ToolArgs, { name, args, drafting, fileHref: (p: string) => (p.startsWith("/workspace/") ? `#files${p}` : undefined) }));

describe("what a value shows as", () => {
  it("goes by the file's extension, then its #! line, then JSON or Markdown", () => {
    expect(kindOf("x", "/w/a.py")).toEqual({ kind: "code", lang: "python" });
    expect(kindOf("# Plan\n- one", "/w/plan.md")).toEqual({ kind: "markdown" });
    expect(kindOf(SCRIPT)).toEqual({ kind: "code", lang: "bash" });
    expect(kindOf("#!/usr/bin/env python3\nprint(1)")).toEqual({ kind: "code", lang: "python" });
    expect(kindOf('{\n  "a": 1\n}')).toEqual({ kind: "code", lang: "json" });
    expect(kindOf("Recording stops.\n\n- Firefox\n- Linux")).toEqual({ kind: "markdown" });
    expect(kindOf("line one\nline two")).toEqual({ kind: "text" });
  });

  it("colours a heredoc as the program it feeds, the script around it as Bash", () => {
    expect(heredocs(SCRIPT)).toEqual([
      { lang: "bash", text: "#!/bin/bash\nset -uo pipefail\nprintf '=== Processes ===\\n'\npython3 - <<'PY'", sub: false },
      { lang: "python", text: "import os\nprint(os.getpid())", sub: true },
      { lang: "bash", text: "PY\necho done", sub: false },
    ]);
    expect(heredocs("cat > /etc/x.json <<EOF\n{}\nEOF")[1]).toEqual({ lang: "json", text: "{}", sub: true });
    // A here-string and an unclosed heredoc stay Bash.
    expect(heredocs("cat <<< \"$x\"\necho")).toHaveLength(1);
    expect(heredocs("python3 <<PY\nprint(1)")).toHaveLength(1);
  });

  it("has a grammar for each language it names", () => {
    for (const lang of ["bash", "python", "json", "typescript", "yaml", "nix", "dockerfile"]) expect(lowlight.registered(lang)).toBe(true);
  });
});

describe("a tool call's arguments", () => {
  it("show a file she writes as its lines under its name, not as one escaped string", () => {
    const html = render("write", { path: "/workspace/audit.sh", content: SCRIPT });
    expect(html).toContain('href="#files/workspace/audit.sh"');
    expect(html).toContain(">audit.sh<");
    expect(html).toContain("set -uo pipefail\nprintf");
    expect(html).not.toContain("\\nset");
    expect(html).not.toContain("&quot;content&quot;");
  });

  it("render a Markdown file", () => {
    expect(render("write", { path: "/workspace/plan.md", content: "# Plan\n\n- **one**" })).toContain("<h1>Plan</h1>");
  });

  it("draw each edit as a diff", () => {
    const html = render("edit", { path: "/workspace/a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }, { oldText: "b", newText: "c" }] });
    expect(html).toContain("cline del");
    expect(html).toContain("cline ins");
    expect(html).toMatch(/Edit <span class="num">1<\/span> of <span class="num">2<\/span>/);
  });

  it("show the edit she is still writing as plain text", () => {
    const html = render("edit", { path: "/workspace/a.ts", edits: [{ oldText: "a = 1" }] }, true);
    expect(html).toContain('class="tool-draft"');
    expect(html).not.toContain("cline");
  });

  it("show a command as Bash, with its timeout as a fact", () => {
    const html = render("bash", { command: "ls -l", timeout: 120 });
    expect(html).toContain(">bash<");
    expect(html).toMatch(/Timeout <span class="num">120<\/span> s/);
  });

  it("list any other call's arguments by name, a long or nested value as a block", () => {
    const html = renderToStaticMarkup(createElement(ArgList, { args: { repo: "lyrica", draft: false, labels: ["bug", "web"], none: null, body: "Stops.\n\n- Firefox", options: { a: 1 } } }));
    expect(html).toContain("<dt>repo</dt><dd>lyrica</dd>");
    expect(html).toContain('<dd><span class="hljs-literal">false</span></dd>');
    expect(html).toContain("<dd>bug, web</dd>");
    expect(html).toContain("<dd>—</dd>");
    expect(html).toContain("<li>Firefox</li>");
    expect(html).toContain(">JSON<");
  });
});

describe("an approval card's arguments", () => {
  it("show Markdown as its source, so what is approved is its exact characters", () => {
    const html = renderToStaticMarkup(createElement(ArgList, { args: { body: "See [docs](https://evil.example)\n\n- one" }, source: true }));
    expect(html).toContain("See [docs](https://evil.example)");
    expect(html).not.toContain("<li>");
  });
});
