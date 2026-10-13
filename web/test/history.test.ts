// Principle 6: one paging surface, and addresses that carry the search and page so Back returns to them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryPage } from "../src/api.ts";
import { HistoryHead, HistoryList } from "../src/History.tsx";
import { href, parse } from "../src/route.ts";
import { useLoad } from "../src/ui.tsx";

vi.mock("../src/ui.tsx", async (original) => ({ ...await original<typeof import("../src/ui.tsx")>(), useLoad: vi.fn() }));

const loaded = (data: unknown) => ({ data, error: "", reload: vi.fn(), set: vi.fn() });
beforeEach(() => { vi.mocked(useLoad).mockReset(); });

describe("history addresses", () => {
  it("carry the search text and page number, and drop them at the defaults", () => {
    expect(parse("#/u/u1/history/sleep?q=endpoint-down&page=3")).toEqual({ page: "history", userId: "u1", kind: "sleep", q: "endpoint-down", at: 3 });
    expect(href({ page: "history", userId: "u1", kind: "sleep", q: "endpoint-down", at: 3 })).toBe("#/u/u1/history/sleep?q=endpoint-down&page=3");
    // Page 1 and no search are the defaults, so they leave no trace.
    expect(parse("#/u/u1/history/journal/general?page=1")).toEqual({ page: "history", userId: "u1", kind: "journal", pool: "general" });
    expect(href({ page: "history", userId: "u1", kind: "journal", pool: "general", at: 1 })).toBe("#/u/u1/history/journal/general");
    expect(parse("#/u/u1/history/sleep")).toEqual({ page: "history", userId: "u1", kind: "sleep" });
    // Call history and Download history carry them too, across a round trip with spaces.
    const r = parse("#/u/u1/models/downloads/history?q=a%20b&page=4");
    expect(r).toEqual({ page: "models", userId: "u1", tab: "downloads", add: "history", q: "a b", at: 4 });
    expect(href(r)).toBe("#/u/u1/models/downloads/history?q=a+b&page=4");
  });
});

describe("paging controls", () => {
  const page = (total: number) => ({ entries: total ? [{ id: "x" }] : [], total }) as unknown as HistoryPage<unknown>;
  const list = (data: ReturnType<typeof page>, at?: number) => renderToStaticMarkup(createElement(HistoryList, {
    path: "/x", route: { page: "history", userId: "u1", kind: "sleep", ...(at ? { at } : {}) }, render: () => null,
  }));

  it("marks only the digits mono and bounds the numbers with muted gaps", () => {
    vi.mocked(useLoad).mockReturnValue(loaded(page(480)));
    const html = list(page(480), 12);
    expect(html).toContain('Page <span class="num">12</span> of <span class="num">24</span>');
    // The current page is pressed and focusable, never disabled.
    expect(html).toContain('<button type="button" class="sm num" aria-label="Page 12" aria-current="page">12</button>');
    expect(html).not.toContain("disabled");
    const buttons = [...html.matchAll(/aria-label="Page (\d+)"/g)].map((m) => Number(m[1]));
    expect(buttons).toEqual([1, 10, 11, 12, 13, 14, 24]);
    // One muted ellipsis in each gap of skipped numbers.
    expect(html.match(/<span class="muted gap"/g)).toHaveLength(2);
  });

  it("shows one page as one button", () => {
    vi.mocked(useLoad).mockReturnValue(loaded(page(5)));
    const html = list(page(5));
    expect(html).toContain('Page <span class="num">1</span> of <span class="num">1</span>');
    expect(html.match(/aria-label="Page \d+"/g)).toHaveLength(1);
    expect(html).not.toContain("muted gap");
  });

  it("says nothing matches when a search finds nothing", () => {
    vi.mocked(useLoad).mockReturnValue(loaded(page(0)));
    expect(list(page(0))).toContain("Nothing matches.");
  });
});

describe("Show all", () => {
  const to = { page: "history" as const, userId: "u1", kind: "sleep" as const };

  it("hides the link when there is nothing more to open", () => {
    expect(renderToStaticMarkup(createElement(HistoryHead, { to, count: 1 }))).not.toContain("Show all");
    expect(renderToStaticMarkup(createElement(HistoryHead, { to, count: 2 }))).toContain('href="#/u/u1/history/sleep">Show all</a>');
    // Without a count the link stays as it was.
    expect(renderToStaticMarkup(createElement(HistoryHead, { to }))).toContain("Show all");
  });
});
