import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { clamp, cutPage, outside, OUTSIDE_GUIDELINE, fetchArgv, fetchedPage, maskSecrets, RENDER_MS, renderArgv, renderedPage, SEARCH_CATEGORIES, SEARCH_TIMES, searxngSearch, type ExecutionTarget, type FetchedPage } from "@lyrica/core";
import { Type } from "typebox";
import { setToolsOff } from "./gate.ts";

// web_search and web_fetch (DESIGN.md, "Switches in the message box"). The
// Web search switch turns both off (SWITCHED_TOOLS in workspace.ts).

export interface WebTools {
  /** The server's SearXNG address, read on every call; without one there is no web_search. */
  searxng(): string | null | undefined;
  /** The thread's sandbox, looked up on every call: web_fetch runs there, under the thread's network switches. */
  target(): ExecutionTarget;
  /** Whether the sandbox has Chromium and node, to render a page built by JavaScript. */
  canRender?(): boolean;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, ...(isError ? { isError: true } : {}) });

export function createWebExtension(web: WebTools): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const gate = (ctx: ExtensionContext) => setToolsOff(pi, ctx, "web", web.searxng() ? [] : ["web_search"]);

    pi.registerTool({
      name: "web_search",
      label: "Web search",
      description: "Search the web. Returns titles, dates, URLs and snippets; read a result with web_fetch.",
      promptSnippet: "search the web",
      promptGuidelines: ["Search when the answer depends on something current or that you don't know; read the best result with web_fetch before relying on a snippet, and say where it came from.", "When a search says its engines refused and are resting, don't search again for the same thing: use what you have, or tell the user search is resting.", OUTSIDE_GUIDELINE],
      annotations: { openWorldHint: true, readOnlyHint: true },
      parameters: Type.Object({
        query: Type.String({ description: "What to search for." }),
        count: Type.Optional(Type.Integer({ description: "How many results, 1 to 20; 8 if left out." })),
        time: Type.Optional(StringEnum(SEARCH_TIMES, { description: "Only results from the past day, week, month or year." })),
        category: Type.Optional(StringEnum(SEARCH_CATEGORIES, { description: "Which engines to ask; general if left out." })),
        page: Type.Optional(Type.Integer({ description: "Which page of results, 1 to 10; 1 if left out." })),
      }),
      async execute(_id, p, signal) {
        const address = web.searxng();
        if (!address) return text("Web search isn't set up: it needs a SearXNG address in Administration.", true);
        try {
          const found = await searxngSearch(address, p.query, { count: clamp(p.count, 8, 20), time: p.time, category: p.category, page: clamp(p.page, 1, 10) }, signal);
          return text(outside(`a web search for "${p.query.replace(/\s+/g, " ").trim()}"`, found));
        } catch (err) {
          return text((err as Error).message, true);
        }
      },
    });

    pi.registerTool({
      name: "web_fetch",
      label: "Web fetch",
      description: "Read a web page or PDF as text: a page's main text as Markdown. It is fetched from this conversation's sandbox, so its internet switch and allowed hosts apply.",
      promptSnippet: "read a web page or PDF as text",
      promptGuidelines: ["A cut page names the offset to read on from.", OUTSIDE_GUIDELINE],
      annotations: { openWorldHint: true, readOnlyHint: true },
      parameters: Type.Object({
        url: Type.String({ description: "An http or https URL." }),
        maxChars: Type.Optional(Type.Integer({ description: "Most characters to return, up to 50000; 20000 if left out." })),
        offset: Type.Optional(Type.Integer({ description: "Where to start, in characters: the offset a cut page names to read on. 0 if left out." })),
      }),
      async execute(_id, p, signal) {
        let url: URL;
        try { url = new URL(p.url.trim()); } catch { return text(`${p.url} isn't a URL.`, true); }
        if (url.protocol !== "http:" && url.protocol !== "https:") return text("web_fetch reads only http and https URLs.", true);
        const target = web.target();
        if (!target.run) return text("web_fetch runs only in the sandbox.", true);
        try {
          // A page that echoes a request back never shows her the sandbox's credentials.
          const secrets = target.secrets?.() ?? [];
          const run = async (argv: string[], timeoutMs: number) => {
            const r = await target.run!(argv, { signal, timeoutMs });
            return { ...r, stdout: maskSecrets(r.stdout, secrets), stderr: maskSecrets(r.stderr, secrets) };
          };
          let page: FetchedPage = await fetchedPage(url.href, await run(fetchArgv(url.href), 30_000), signal);
          // A page built by JavaScript: render it in the sandbox's Chromium, under the same switches, and keep what reads longer.
          if (page.thin && web.canRender?.()) {
            const r = await run(renderArgv(url.href), RENDER_MS).catch(() => undefined);
            const rendered = r && renderedPage(url.href, r);
            if (rendered && rendered.text.length > page.text.length) page = rendered;
          }
          if (page.isError) return text(page.text, true);
          // Again on the text, which a charset, Markdown or a PDF's streams may have spelled differently from the bytes.
          if (secrets.length) page = { text: maskSecrets(Buffer.from(page.text), secrets).toString("utf8") };
          const part = cutPage(page.text, clamp(p.maxChars, 20_000, 50_000), p.offset ?? 0);
          if (part.isError) return text(part.text, true);
          // The note on where to read on is outside the markers, so a page can't fake it.
          return text(`${outside(url.href, part.text)}${part.note ? `\n${part.note}` : ""}`);
        } catch (err) {
          return text(`Couldn't fetch ${url.href}: ${(err as Error).message}.`, true);
        }
      },
    });

    pi.on("session_start", (_event, ctx) => gate(ctx));
    pi.on("before_agent_start", (_event, ctx) => { gate(ctx); });
  };
}
