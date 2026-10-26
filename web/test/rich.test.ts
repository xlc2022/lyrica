// Diagrams, charts and math in a message: what reaches the renderer, and what shows before a library has drawn
// (web/src/markdown.ts, web/src/RichBlock.tsx). The drawing itself runs in a browser.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mathMarks } from "../src/markdown.ts";
import { namesUrl } from "../src/RichBlock.tsx";
import { Prose } from "../src/ui.tsx";

const render = (text: string) => renderToStaticMarkup(createElement(Prose, { text, copyCode: true }));

describe("math in a message", () => {
  it("reads \\( \\) and \\[ \\] as math, and leaves code alone", () => {
    expect(mathMarks("so \\(x^2\\) holds")).toBe("so $$x^2$$ holds");
    expect(mathMarks("the sum\n\\[ \\sum k \\]\ndone")).toBe("the sum\n\n\n$$\n\\sum k\n$$\n\n\ndone");
    expect(mathMarks("`\\(x\\)` and\n```\n\\(y\\)\n```")).toBe("`\\(x\\)` and\n```\n\\(y\\)\n```");
  });

  it("draws $$ math, never a single $", () => {
    const html = render("Euler: $$e^{i\\pi}+1=0$$. Costs $10 and $20.");
    expect(html).toContain("<code>e^{i\\pi}+1=0</code>");
    expect(html).toContain("Costs $10 and $20.");
  });
});

describe("a diagram or chart in a message", () => {
  it("shows its source with Copy until it is drawn", () => {
    const html = render("```mermaid\nflowchart LR\n  A --> B\n```");
    expect(html).toContain('<figure class="code-block rich-block">');
    expect(html).toContain('<span class="code-lang">mermaid</span>');
    expect(html).toContain('aria-label="Copy diagram source"');
    expect(html).toContain("A --&gt; B");
  });

  it("treats other fences as code blocks", () => {
    expect(render("```json\n{}\n```")).not.toContain("rich-block");
  });

  it("refuses a chart that names a URL anywhere", () => {
    expect(namesUrl({ data: { values: [{ a: 1 }] }, mark: "bar" })).toBe(false);
    expect(namesUrl({ data: { url: "https://example.com/x.csv" } })).toBe(true);
    expect(namesUrl({ layer: [{ mark: "image", encoding: { url: { field: "u" } } }] })).toBe(true);
  });
});
