import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { clamp, fetchArgv, fetchedPage, searxngSearch, type ExecutionTarget } from "@lyrica/core";
import { Type } from "typebox";
import { setToolsOff } from "./gate.ts";

// web_search and web_fetch (DESIGN.md, "Switches in the message box"). The
// Web search switch turns both off (SWITCHED_TOOLS in workspace.ts).

export interface WebTools {
  /** The server's SearXNG address, read on every call; without one there is no web_search. */
  searxng(): string | null | undefined;
  /** The thread's sandbox, looked up on every call: web_fetch runs there, under the thread's network switches. */
  target(): ExecutionTarget;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, ...(isError ? { isError: true } : {}) });

export function createWebExtension(web: WebTools): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const gate = (ctx: ExtensionContext) => setToolsOff(pi, ctx, "web", web.searxng() ? [] : ["web_search"]);

    pi.registerTool({
      name: "web_search",
      label: "Web search",
      description: "Search the web. Returns titles, URLs and snippets; read a result with web_fetch.",
      promptSnippet: "search the web",
      promptGuidelines: ["Search when the answer depends on something current or that you don't know; read the best result with web_fetch before relying on a snippet, and say where it came from."],
      annotations: { openWorldHint: true, readOnlyHint: true },
      parameters: Type.Object({
        query: Type.String({ description: "What to search for." }),
        count: Type.Optional(Type.Integer({ description: "How many results, 1 to 20; 8 if left out." })),
      }),
      async execute(_id, p, signal) {
        const address = web.searxng();
        if (!address) return text("Web search isn't set up: it needs a SearXNG address in Administration.", true);
        try {
          return text(await searxngSearch(address, p.query, clamp(p.count, 8, 20), signal));
        } catch (err) {
          return text((err as Error).message, true);
        }
      },
    });

    pi.registerTool({
      name: "web_fetch",
      label: "Web fetch",
      description: "Read a web page as text. It is fetched from this conversation's sandbox, so its internet switch and allowed hosts apply.",
      promptSnippet: "read a web page as text",
      annotations: { openWorldHint: true, readOnlyHint: true },
      parameters: Type.Object({
        url: Type.String({ description: "An http or https URL." }),
        maxChars: Type.Optional(Type.Integer({ description: "Most characters to return, up to 50000; 20000 if left out." })),
      }),
      async execute(_id, p, signal) {
        let url: URL;
        try { url = new URL(p.url.trim()); } catch { return text(`${p.url} isn't a URL.`, true); }
        if (url.protocol !== "http:" && url.protocol !== "https:") return text("web_fetch reads only http and https URLs.", true);
        const target = web.target();
        if (!target.run) return text("web_fetch runs only in the sandbox.", true);
        try {
          const r = await target.run(fetchArgv(url.href), { signal, timeoutMs: 30_000 });
          const page = fetchedPage(url.href, r, clamp(p.maxChars, 20_000, 50_000));
          return text(page.text, page.isError);
        } catch (err) {
          return text(`Couldn't fetch ${url.href}: ${(err as Error).message}.`, true);
        }
      },
    });

    pi.on("session_start", (_event, ctx) => gate(ctx));
    pi.on("before_agent_start", (_event, ctx) => { gate(ctx); });
  };
}
