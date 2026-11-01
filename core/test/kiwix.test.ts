import { afterEach, describe, expect, it } from "vitest";
import { forgetKiwixBooks, kiwixBooks, kiwixLines, kiwixPage, kiwixPicture, kiwixSearch, kiwixStatus } from "../src/kiwix.ts";

// The offline copy of Wikipedia on kiwix-serve, as web_search and web_fetch
// read it (docs/contracts.md, "web_search and web_fetch"). The replies are
// kiwix-serve 3.5's, shortened.

const A = "http://127.0.0.1:8889";
const BOOK = "wikipedia_en_all_maxi_2026-06";

const CATALOG = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
  <title>All Entries</title>
  <entry>
    <id>urn:uuid:1</id><title>Wikipedia</title><updated>2026-06-01T00:00:00Z</updated><language>eng</language>
    <name>wikipedia_en_all_maxi</name><flavour>maxi</flavour>
    <link rel="http://opds-spec.org/image/thumbnail" href="/catalog/v2/illustration/1/?size=48" type="image/png;width=48;height=48;scale=1"/>
    <link type="text/html" href="/content/${BOOK}" />
    <author><name>Wikipedia</name></author>
  </entry>
  <entry>
    <id>urn:uuid:3</id><title>Wikipedia</title><updated>2026-05-01T00:00:00Z</updated><language>eng</language>
    <name>wikipedia_en_all_nopic</name><flavour>nopic</flavour>
    <link type="text/html" href="/content/wikipedia_en_all_nopic_2026-05" />
  </entry>
  <entry>
    <id>urn:uuid:2</id><title>Wiktionary</title><updated>2026-05-01T00:00:00Z</updated><language>eng</language>
    <name>wiktionary_en_all_maxi</name><flavour>maxi</flavour>
    <link type="text/html" href="/content/wiktionary_en_all_maxi_2026-05" />
  </entry>
</feed>`;

const search = (items: [string, string, string][]) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><channel>
<title>Search: q</title><opensearch:totalResults>${items.length}</opensearch:totalResults>
${items.map(([t, l, d]) => `<item><title>${t}</title><link>${l}</link><description>${d}</description><book><title>Wikipedia</title></book><wordCount>21</wordCount></item>`).join("\n")}
</channel></rss>`;

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>Lute</title></head><body><div id="mw-content-text"><h1>Lute</h1>
<figure><img src="../I/Lute_photo.webp" alt="A Renaissance lute"><figcaption>A lute</figcaption></figure>
<p>${"A lute is any plucked string instrument with a neck and a deep round back enclosing a hollow cavity. ".repeat(6)}</p>
<p>See also <a href="Ada_Lovelace">Ada Lovelace</a> and <img src="https://upload.wikimedia.org/x.png"></p></div></body></html>`;

/** A kiwix-serve: its catalog, one search reply, the articles it has by path, and a picture. */
function serve(o: { hits?: Record<string, [string, string, string][]>; pages?: Record<string, string>; suggest?: { value: string; kind: string; path?: string }[] } = {}) {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname === "/catalog/v2/entries") return new Response(CATALOG, { headers: { "content-type": "application/atom+xml" } });
    if (u.pathname === "/search") {
      const book = u.searchParams.get("books.name")!;
      return new Response(search(o.hits?.[book] ?? []), { headers: { "content-type": "application/rss+xml" } });
    }
    const raw = /^\/raw\/([^/]+)\/content\/(.*)$/.exec(u.pathname);
    if (raw) {
      const path = decodeURIComponent(raw[2]!);
      if (raw[1] === BOOK && path === "I/Lute_photo.webp") return new Response(Buffer.from("RIFF....WEBPVP8 "), { headers: { "content-type": "image/webp" } });
      const page = raw[1] === BOOK ? o.pages?.[path] : undefined;
      return page ? new Response(page, { headers: { "content-type": "text/html" } }) : new Response("no", { status: 404 });
    }
    if (u.pathname === "/suggest") return new Response(JSON.stringify(o.suggest ?? []), { headers: { "content-type": "application/json" } });
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, urls };
}

afterEach(() => forgetKiwixBooks());

describe("the offline copy of Wikipedia", () => {
  it("lists the books from the catalog, each with the wikipedia.org it copies", async () => {
    const { f } = serve();
    expect(await kiwixBooks(A, undefined, f)).toEqual([
      { id: BOOK, name: "wikipedia_en_all_maxi", title: "Wikipedia", language: "eng", date: "2026-06-01", wiki: "en" },
      { id: "wikipedia_en_all_nopic_2026-05", name: "wikipedia_en_all_nopic", title: "Wikipedia", language: "eng", date: "2026-05-01", wiki: "en" },
      { id: "wiktionary_en_all_maxi_2026-05", name: "wiktionary_en_all_maxi", title: "Wiktionary", language: "eng", date: "2026-05-01", wiki: "" },
    ]);
    expect(await kiwixStatus(A, f)).toEqual({ kiwixState: "reachable", books: [
      { name: "wikipedia_en_all_maxi", title: "Wikipedia", language: "eng", date: "2026-06-01" },
      { name: "wikipedia_en_all_nopic", title: "Wikipedia", language: "eng", date: "2026-05-01" },
      { name: "wiktionary_en_all_maxi", title: "Wiktionary", language: "eng", date: "2026-05-01" },
    ] });
    const down = (async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }); }) as unknown as typeof fetch;
    expect(await kiwixStatus(A, down)).toEqual({ kiwixState: "unreachable", kiwixReason: "kiwix-serve can't be reached: ECONNREFUSED.", books: [] });
    expect(await kiwixStatus(null, f)).toEqual({ kiwixState: "unset", books: [] });
  });

  it("searches every book on its own and merges the hits in turn, as wikipedia.org links where it can, each once", async () => {
    const { f, urls } = serve({ hits: {
      [BOOK]: [["Lute", `/content/${BOOK}/A/Lute`, "Lute A lute is any plucked string instrument with a neck...."], ["Oud", `/content/${BOOK}/A/Oud`, "Oud The oud is a short-neck lute-type instrument...."]],
      "wikipedia_en_all_nopic_2026-05": [["Lute", "/content/wikipedia_en_all_nopic_2026-05/A/Lute", "Lute A lute is any plucked string instrument...."]],
      "wiktionary_en_all_maxi_2026-05": [["lute", "/content/wiktionary_en_all_maxi_2026-05/lute", "lute A plucked string instrument...."]],
    } });
    const hits = await kiwixSearch(A, "lute", 5, undefined, f);
    expect(hits.map((h) => [h.title, h.url, h.snippet])).toEqual([
      ["Lute", "https://en.wikipedia.org/wiki/Lute", "A lute is any plucked string instrument with a neck"],
      ["lute", `${A}/content/wiktionary_en_all_maxi_2026-05/lute`, "A plucked string instrument"],
      ["Oud", "https://en.wikipedia.org/wiki/Oud", "The oud is a short-neck lute-type instrument"],
    ]);
    expect(urls.filter((u) => u.includes("/search?"))).toEqual([
      `${A}/search?pattern=lute&books.name=${BOOK}&format=xml&pageLength=5`,
      `${A}/search?pattern=lute&books.name=wikipedia_en_all_nopic_2026-05&format=xml&pageLength=5`,
      `${A}/search?pattern=lute&books.name=wiktionary_en_all_maxi_2026-05&format=xml&pageLength=5`,
    ]);
    expect(kiwixLines(hits.slice(0, 1))).toBe("Offline copy of Wikipedia 2026-06:\n- Lute\n  https://en.wikipedia.org/wiki/Lute\n  A lute is any plucked string instrument with a neck");
    expect(kiwixLines([])).toBe("");
    // The catalog was read once for both calls.
    expect(urls.filter((u) => u.endsWith("/catalog/v2/entries"))).toHaveLength(1);
  });

  it("reads a wikipedia.org page by its title, with links absolute on wikipedia.org and its pictures listed", async () => {
    const { f, urls } = serve({ pages: { "A/Lute": ARTICLE } });
    const page = await kiwixPage(A, new URL("https://en.m.wikipedia.org/wiki/Lute#History"), undefined, f);
    if (!page || "image" in page) throw new Error("expected a page");
    expect(page.copy).toBe("the offline copy of Wikipedia (2026-06)");
    expect(page.text.split("\n").slice(0, 2)).toEqual(["# Lute", "https://en.m.wikipedia.org/wiki/Lute#History"]);
    expect(page.text).toContain("[Ada Lovelace](https://en.m.wikipedia.org/wiki/Ada_Lovelace)");
    expect(page.text).toContain(`Pictures, each readable with web_fetch:\n1. ${A}/content/${BOOK}/I/Lute_photo.webp (A Renaissance lute)`);
    expect(page.text).not.toContain("upload.wikimedia.org");
    expect(urls.at(-1)).toBe(`${A}/raw/${BOOK}/content/A/Lute`);
  });

  it("finds an article spelled differently through kiwix-serve's suggestions, and gives up on one no book has", async () => {
    const { f, urls } = serve({ pages: { "A/Ada_Lovelace": "<html><body><p>Ada</p></body></html>" }, suggest: [{ value: "Ada Lovelace", kind: "path", path: "A/Ada_Lovelace" }, { value: "ada ", kind: "pattern" }] });
    const page = await kiwixPage(A, new URL("https://en.wikipedia.org/wiki/ada%20lovelace"), undefined, f);
    expect(page && "text" in page && page.text).toContain("Ada");
    expect(urls.filter((u) => u.includes("/suggest?"))).toEqual([`${A}/suggest?content=${BOOK}&term=ada%20lovelace&count=10`]);
    expect(await kiwixPage(A, new URL("https://en.wikipedia.org/wiki/Nope"), undefined, f)).toBeUndefined();
    // Another language, another site, or no title: not the copy's.
    for (const u of ["https://de.wikipedia.org/wiki/Laute", "https://example.org/wiki/Lute", "https://en.wikipedia.org/w/index.php?title=Lute", "https://en.wikipedia.org/wiki/"]) {
      expect(await kiwixPage(A, new URL(u), undefined, f)).toBeUndefined();
    }
  });

  it("reads a page and a picture of kiwix-serve's own by their addresses", async () => {
    const { f } = serve({ pages: { "A/Lute": ARTICLE } });
    const page = await kiwixPage(A, new URL(`${A}/content/${BOOK}/A/Lute`), undefined, f);
    expect(page && "text" in page && page.text).toContain("[Ada Lovelace](http://127.0.0.1:8889/content/wikipedia_en_all_maxi_2026-06/A/Ada_Lovelace)");
    const picture = await kiwixPage(A, new URL(`${A}/content/${BOOK}/I/Lute_photo.webp`), undefined, f);
    if (!picture || !("image" in picture)) throw new Error("expected a picture");
    // WebP stays WebP where ImageMagick can't read this fake one; PNG where it can.
    expect(["image/webp", "image/png"]).toContain(picture.mimeType);
    expect(await kiwixPage(A, new URL(`${A}/content/other_book/Lute`), undefined, f)).toBeUndefined();
    expect(await kiwixPage(A, new URL(`${A}/content/${BOOK}/Missing`), undefined, f)).toBeUndefined();
  });

  it("gives the web UI a picture of its own, and nothing else, never asking another host", async () => {
    const { f, urls } = serve({ pages: { "A/Lute": ARTICLE } });
    expect(await kiwixPicture(A, `${A}/content/${BOOK}/I/Lute_photo.webp`, undefined, f)).toEqual({ bytes: Buffer.from("RIFF....WEBPVP8 "), mimeType: "image/webp" });
    expect(urls.at(-1)).toBe(`${A}/raw/${BOOK}/content/I/Lute_photo.webp`);
    const asked = urls.length;
    for (const u of [`${A}/content/${BOOK}/A/Lute`, `${A}/content/${BOOK}/I/Missing.webp`]) expect(await kiwixPicture(A, u, undefined, f)).toBeUndefined();
    expect(urls.length).toBe(asked + 2);
    for (const u of ["https://upload.wikimedia.org/x.png", `${A}/catalog/v2/entries`, `${A}/content/${BOOK}/I/Lute_photo.webp?x=1`, `http://127.0.0.1:88891/content/${BOOK}/I/Lute_photo.webp`, "not a url"]) {
      expect(await kiwixPicture(A, u, undefined, f)).toBeUndefined();
    }
    expect(urls.length).toBe(asked + 2);
  });
});
