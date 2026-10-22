import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { href, parse } from "../src/route.ts";
import { UsageRows } from "../src/Usage.tsx";

describe("spend share", () => {
  it("keeps project and pool in Recent calls addresses", () => {
    const route = { page: "models" as const, userId: "user", tab: "calls" as const, pool: "private" as const, project: "web/a?b" };
    expect(parse(href(route))).toEqual(route);
  });
  it("renders model and thread shares, mono counts, and a project-filtered Recent calls link", () => {
    const html = renderToStaticMarkup(createElement(UsageRows, {
      userId: "user", pool: "general", threadId: "chat", threads: [],
      usage: { tokens: 30, input: 24, output: 6, gpuMs: 1000, models: [{ label: "Local", kind: "local", tokens: 20, input: 16, output: 4, gpuMs: 1000 }, { label: "Cloud", kind: "cloud", tokens: 10, input: 8, output: 2 }],
        threads: [{ threadId: "chat", tokens: 20, input: 16, output: 4 }, { threadId: "work", tokens: 10, input: 8, output: 2 }] },
    }));
    for (const head of ["Input", "Output", "Total", "GPU time"]) expect(html).toContain(`${head}</span>`);
    // Each row: input, output, then total, in mono.
    expect(html).toContain('<span class="num">16</span><span class="num">4</span><span class="num">20</span>');
    expect(html).toContain("By thread");
    expect(html).toContain("This chat");
    expect(html).toContain('title="Counts every request, cached reads included."');
    expect(html).toContain('title="Tokens counted before input and output were kept apart count here alone."');
    expect(html).toContain('title="Cloud: no GPU time"');
    expect(html).toContain("?project=chat&amp;pool=general");
    expect(html).toContain('title="GPU time">1.0 s');
  });
});
