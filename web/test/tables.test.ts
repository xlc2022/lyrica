// A table in a message: GitHub's tables render, and one written on a single line is put back on its rows (web/src/tables.ts).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { unfoldTables } from "../src/markdown.ts";
import { Prose } from "../src/ui.tsx";

const render = (text: string) => renderToStaticMarkup(createElement(Prose, { text }));

describe("a table in a message", () => {
  it("renders a table written on its own lines", () => {
    const html = render("| Option | Gets |\n|---|---|\n| On | Fallback |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Option</th>");
    expect(html).toContain("<td>Fallback</td>");
  });

  it("renders a table a model wrote on one line", () => {
    const html = render("Almost.\n\n| Option | What a new thread gets | |---|---| | **Same** | Copies the switch. | | **On** | Enables it. | | **Off** | Disables it. |\n\nSo On is a copy.");
    expect(html).toContain("<table>");
    expect(html.match(/<tr>/g)).toHaveLength(4);
    expect(html).toContain("<td><strong>Off</strong></td>");
    expect(html).toContain("<p>So On is a copy.</p>");
  });

  it("unfolds a one-line table with no space between rows", () => {
    expect(unfoldTables("|a|b||:--|--:||1|2|")).toBe("|a|b|\n|:--|--:|\n|1|2|");
  });

  it("keeps an escaped pipe inside its cell", () => {
    expect(unfoldTables("| a | b | |---|---| | x \\| y | z |")).toBe("| a | b |\n|---|---|\n| x \\| y | z |");
  });

  it("leaves a row with an empty cell, a lone pipe and a code block as written", () => {
    const text = "| a | | c |\nuse a | b\n```\n| a | b | |---|---| | 1 | 2 |\n```";
    expect(unfoldTables(text)).toBe(text);
  });

  it("keeps a footnote's mark and its ↩ in the page", () => {
    const html = render("A claim.[^1]\n\n[^1]: The source.");
    expect(html).toMatch(/<a href="#user-content-fn-1"[^>]*>1<\/a>/);
    expect(html).toContain('href="#user-content-fnref-1"');
    expect(html).not.toContain("_blank");
  });

  it("renders the other GitHub marks: task lists, strikethrough and bare links", () => {
    const html = render("- [x] done\n- [ ] not yet\n\n~~gone~~ see https://example.com");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain('href="https://example.com"');
  });
});
