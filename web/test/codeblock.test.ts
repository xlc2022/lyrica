// A fenced code block in a message: the fence's language, Copy, and what Copy puts on the clipboard (web/src/CodeBlock.tsx).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { codeOf } from "../src/CodeBlock.tsx";
import { Prose } from "../src/ui.tsx";

const render = (text: string, copyCode = true) => renderToStaticMarkup(createElement(Prose, { text, copyCode }));

/** What Copy would copy from each fenced block in `text`. */
function copied(text: string) {
  const found: { lang: string; text: string }[] = [];
  renderToStaticMarkup(createElement(Markdown, { components: { pre: ({ node }) => { found.push(codeOf(node)); return null; } }, children: text }));
  return found;
}

describe("a code block in a message", () => {
  it("gets a strip with the fence's language and Copy", () => {
    const html = render("Try this:\n\n```ts\nconst a = 1;\n```\n");
    expect(html).toContain('<span class="code-lang">ts</span>');
    expect(html).toContain('<button type="button" class="sm code-copy" aria-label="Copy code">Copy</button>');
    expect(html).toMatch(/<pre><code class="language-ts">const a = 1;\n<\/code><\/pre>/);
  });

  it("names no language when the fence names none, and still has Copy", () => {
    const html = render("```\nls -la\n```\n");
    expect(html).not.toContain("code-lang");
    expect(html).toContain('aria-label="Copy code"');
  });

  it("gives every fenced block its own strip", () => {
    const html = render("```sh\none\n```\n\ntext\n\n```py\ntwo\n```\n");
    expect(html.match(/class="sm code-copy"/g)).toHaveLength(2);
    expect(html).toContain(">sh</span>");
    expect(html).toContain(">py</span>");
  });

  it("leaves inline code alone", () => {
    const html = render("Run `npm test` first.");
    expect(html).toContain("<code>npm test</code>");
    expect(html).not.toContain("code-block");
    expect(html).not.toContain("Copy");
  });

  it("is only for the prose that asks for it", () => {
    const html = render("```ts\nconst a = 1;\n```\n", false);
    expect(html).not.toContain("code-block");
    expect(html).not.toContain("Copy");
    expect(html).toContain("<pre>");
  });
});

describe("what Copy copies", () => {
  it("is the block's text, without the newline the parser ends a fence with", () => {
    expect(copied("```bash\nnpm test\n```")).toEqual([{ lang: "bash", text: "npm test" }]);
  });

  it("keeps the lines, the indentation and any blank line inside", () => {
    expect(copied("```py\ndef f():\n\n    return 1\n```")).toEqual([{ lang: "py", text: "def f():\n\n    return 1" }]);
  });

  it("is the text as written where the code holds markup or a path", () => {
    expect(copied("```html\n<b>hi</b> & /workspace/a.md\n```")).toEqual([{ lang: "html", text: "<b>hi</b> & /workspace/a.md" }]);
  });

  it("takes the first word of the fence's info as its language", () => {
    expect(copied("```ts title=a.ts\nx\n```")).toEqual([{ lang: "ts", text: "x" }]);
  });
});
