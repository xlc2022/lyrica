// An image a command made, named in her prose by a link or a bare path, shows its thumbnail under the paragraph
// (web/src/ui.tsx, linkedImages; docs/ux.md §6, "A file or image named in a message").
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FileLinks } from "../src/paths.tsx";
import { Prose } from "../src/ui.tsx";

const files: FileLinks = {
  href: (p) => `#/files${p}`,
  url: (p) => `/content?path=${encodeURIComponent(p)}`,
  thumb: (p) => `/thumb?path=${encodeURIComponent(p)}`,
};
const render = (text: string, skipImages?: ReadonlySet<string>) => renderToStaticMarkup(createElement(Prose, { text, files, skipImages }));
const thumbs = (html: string) => [...html.matchAll(/class="inline-img"[^>]*>(?:<img[^>]*src="([^"]+)")/g)].map((m) => decodeURIComponent(m[1]!.replace(/^\/thumb\?path=/, "")));

describe("an image named by a link in her prose", () => {
  it("keeps the link and shows the image's thumbnail under the paragraph", () => {
    const html = render("Done — [ecee7342-8x.png](/workspace/images/ecee7342-8x.png), 7295×9216, 46 MB.");
    expect(html).toContain('<p>Done — <a href="#/files/workspace/images/ecee7342-8x.png" title="/workspace/images/ecee7342-8x.png">ecee7342-8x.png</a>, 7295×9216, 46 MB.</p>');
    expect(thumbs(html)).toEqual(["/workspace/images/ecee7342-8x.png"]);
    expect(html).toContain('<div class="linked-images">');
  });

  it("does the same for a bare path and a relative link, each image once", () => {
    const html = render("Saved /workspace/images/a.png and [a.png](images/a.png), then [b](images/b.jpg).");
    expect(thumbs(html)).toEqual(["/workspace/images/a.png", "/workspace/images/b.jpg"]);
  });

  it("shows nothing for links to other files, remote images or an image already shown this turn", () => {
    expect(thumbs(render("See [the plan](/workspace/plan.md) and [a photo](https://example.org/x.png)."))).toEqual([]);
    expect(thumbs(render("Here: [a.png](/workspace/images/a.png).", new Set(["/workspace/images/a.png"])))).toEqual([]);
    expect(render("Plain words, no links.")).not.toContain("linked-images");
  });

  it("ends a list item with its own images, and leaves a code block alone", () => {
    const html = render("- [a.png](/workspace/images/a.png)\n- [b.png](/workspace/images/b.png)\n\n```\ncp /workspace/images/c.png out.png\n```");
    expect(thumbs(html)).toEqual(["/workspace/images/a.png", "/workspace/images/b.png"]);
    expect(html.match(/<li>[^]*?<div class="linked-images">/g)).toHaveLength(2);
  });

  it("doesn't double an image the paragraph already shows as a picture", () => {
    expect(thumbs(render("[![a](/workspace/images/a.png)](/workspace/images/a.png)"))).toEqual(["/workspace/images/a.png"]);
  });
});
