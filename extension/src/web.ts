import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { BROWSE_ACTIONS, type Browser, clamp, copyName, cutPage, outside, OUTSIDE_GUIDELINE, FETCH_BYTES, FETCH_TOO_LARGE, fetchArgv, fetchedPage, kiwixLines, kiwixPage, kiwixSearch, maskSecrets, offlineQuery, OUTPUT_OVER, RENDER_MS, renderArgv, renderedPage, SEARCH_CATEGORIES, SEARCH_TIMES, searxngSearch, type ExecutionTarget, type FetchedPage } from "@lyrica/core";
import { Type } from "typebox";
import { setToolsOff } from "./gate.ts";

// web_search and web_fetch (DESIGN.md, "Switches in the message box"). The
// Web search switch turns both off (SWITCHED_TOOLS in workspace.ts). An
// offline copy of Wikipedia on kiwix-serve joins a search, answers alone a
// search naming Wikipedia, and answers a fetch of a wikipedia.org page
// before the sandbox goes online.

export interface WebTools {
  /** The server's SearXNG address, read on every call; without one or a kiwix-serve there is no web_search. */
  searxng(): string | null | undefined;
  /** The server's kiwix-serve address (the offline copy of Wikipedia), read on every call. */
  kiwix?(): string | null | undefined;
  /** The thread's sandbox, looked up on every call: web_fetch runs there, under the thread's network switches. */
  target(): ExecutionTarget;
  /** Whether the sandbox has Chromium and node, to render a page built by JavaScript. */
  canRender?(): boolean;
  /** The thread's browser, in its sandbox. Without it (a subagent), there is no browse. */
  browser?(): Pick<Browser, "act">;
  /** Whether browse may tick a simple bot-check box: an administrator's switch, read on every call. */
  botChecks?(): boolean;
}

/** How much of a page one browse action answers with; `read` with an offset goes on. */
const BROWSE_CHARS = 12_000;

/** A check box on a page that asks whether she is a person, as browse's page text shows it. */
const BOT_BOX = /\[\d+\] checkbox "[^"\n]*\b(robot|human|bot)\b/i;
/** What browse adds, outside the markers, when the administrator allows it and the page shows such a box. */
const BOT_ALLOWED = "The administrator lets you tick a simple check box that asks whether you are a robot: click it, then read the page again.";

/** What a refused fetch adds when the thread has browse. */
const FETCH_REFUSED = "The site refused a plain fetch and may answer a browser: open the same address with browse.";

/** How many offline hits join a search at most. */
const OFFLINE_HITS = 5;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, ...(isError ? { isError: true } : {}) });

export function createWebExtension(web: WebTools): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const gate = (ctx: ExtensionContext) => setToolsOff(pi, ctx, "web", web.searxng() || web.kiwix?.() ? [] : ["web_search"]);

    pi.registerTool({
      name: "web_search",
      label: "Web search",
      description: "Search the web, and the server's offline copy of Wikipedia when it has one; a search naming Wikipedia (\"... wikipedia\" or site:wikipedia.org) asks only the offline copy, and the web if the copy has nothing; online skips the copy. Returns titles, dates, URLs and snippets; read a result with web_fetch.",
      promptSnippet: "search the web",
      promptGuidelines: ["Search when the answer depends on something current or that you don't know; read the best result with web_fetch before relying on a snippet, and say where it came from.", "When a search says its engines refused and are resting, don't search again for the same thing: use what you have, or tell the user search is resting.", OUTSIDE_GUIDELINE],
      annotations: { openWorldHint: true, readOnlyHint: true },
      parameters: Type.Object({
        query: Type.String({ description: "What to search for." }),
        count: Type.Optional(Type.Integer({ description: "How many results, 1 to 20; 8 if left out." })),
        time: Type.Optional(StringEnum(SEARCH_TIMES, { description: "Only results from the past day, week, month or year." })),
        category: Type.Optional(StringEnum(SEARCH_CATEGORIES, { description: "Which engines to ask; general if left out." })),
        page: Type.Optional(Type.Integer({ description: "Which page of results, 1 to 10; 1 if left out." })),
        online: Type.Optional(Type.Boolean({ description: "true: only the web, never the offline copy, as when the user asks for the live Wikipedia." })),
      }),
      async execute(_id, p, signal) {
        const address = web.searxng();
        const kiwix = web.kiwix?.();
        if (!address && !kiwix) return text("Web search isn't set up: it needs a SearXNG or Kiwix address in Administration.", true);
        if (p.online && !address) return text("Web search online isn't set up: it needs a SearXNG address in Administration.", true);
        const count = clamp(p.count, 8, 20), page = clamp(p.page, 1, 10);
        const query = p.query.replace(/\s+/g, " ").trim();
        // The offline copy has no dates, categories or pages: it joins a plain search's first page.
        const plain = !!kiwix && !p.online && page === 1 && !p.time && (!p.category || p.category === "general");
        // A search naming Wikipedia asks the offline copy alone, and the web only when the copy has nothing.
        let missed = "";
        if (plain && offlineQuery(query).wikipedia) {
          const hits = await kiwixSearch(kiwix, query, count, signal).catch((err: Error) => err);
          if (Array.isArray(hits) && hits.length) return text(outside(`a search of ${copyName(hits[0]!.book)} for "${query}"`, kiwixLines(hits)));
          missed = Array.isArray(hits) ? `The offline copy had nothing for "${offlineQuery(query).query}".` : hits.message;
          if (!address) return text(missed, true);
        }
        const offline = plain && !missed
          ? kiwixSearch(kiwix, query, Math.min(count, OFFLINE_HITS), signal).then(kiwixLines, (err: Error) => ({ failed: err.message }))
          : Promise.resolve("");
        const online = address
          ? searxngSearch(address, p.query, { count, time: p.time, category: p.category, page }, signal).then((t) => t, (err: Error) => ({ failed: err.message }))
          : Promise.resolve("");
        const [web_, wiki] = await Promise.all([online, offline]);
        const parts = [web_, wiki].filter((x): x is string => typeof x === "string" && !!x);
        const failed = [missed, ...[web_, wiki].flatMap((x) => (typeof x === "string" ? [] : [x.failed]))].filter(Boolean);
        if (!parts.length) return text(failed.join(" "), true);
        return text(`${outside(`a web search for "${query}"`, parts.join("\n\n"))}${failed.length ? `\n${failed.join(" ")}` : ""}`);
      },
    });

    pi.registerTool({
      name: "web_fetch",
      label: "Web fetch",
      description: `Read a web page or PDF as text: a page's main text as Markdown. A wikipedia.org page comes from the server's offline copy when it has one (unless online), and a picture it lists comes back as an image; anything else is fetched from this conversation's sandbox, so its internet switch and allowed hosts apply.${web.browser ? " A page that needs a click, a field filled in or a login, that comes back empty because a script draws it, or whose site refuses the fetch (answers 401, 403 or 429, or with Anubis's check), is browse's." : ""}`,
      promptSnippet: "read a web page or PDF as text",
      promptGuidelines: ["A cut page names the offset to read on from.", OUTSIDE_GUIDELINE],
      annotations: { openWorldHint: true, readOnlyHint: true },
      parameters: Type.Object({
        url: Type.String({ description: "An http or https URL." }),
        maxChars: Type.Optional(Type.Integer({ description: "Most characters to return, up to 50000; 20000 if left out." })),
        offset: Type.Optional(Type.Integer({ description: "Where to start, in characters: the offset a cut page names to read on. 0 if left out." })),
        online: Type.Optional(Type.Boolean({ description: "true: fetch the page online even when the offline copy has it, as when the user asks for the live Wikipedia." })),
      }),
      async execute(_id, p, signal) {
        let url: URL;
        try { url = new URL(p.url.trim()); } catch { return text(`${p.url} isn't a URL.`, true); }
        if (url.protocol !== "http:" && url.protocol !== "https:") return text("web_fetch reads only http and https URLs.", true);
        // The offline copy first: a page it has never needs the network.
        const kiwix = p.online ? undefined : web.kiwix?.();
        if (kiwix) {
          try {
            const local = await kiwixPage(kiwix, url, signal);
            if (local && "image" in local) {
              return { content: [{ type: "text" as const, text: `A picture from ${local.copy}: ${url.href}` }, { type: "image" as const, data: local.image.toString("base64"), mimeType: local.mimeType }], details: undefined };
            }
            if (local) {
              if (local.isError) return text(local.text, true);
              const part = cutPage(local.text, clamp(p.maxChars, 20_000, 50_000), p.offset ?? 0);
              if (part.isError) return text(part.text, true);
              return text(`${outside(`${url.href} (${local.copy})`, withSections(part))}${part.note ? `\n${part.note}` : ""}`);
            }
          } catch { /* online instead */ }
        }
        const target = web.target();
        if (!target.run) return text("web_fetch runs only in the sandbox.", true);
        try {
          // A page that echoes a request back never shows her the sandbox's credentials.
          const secrets = target.secrets?.() ?? [];
          // The run's output is capped too: curl's own limit counts bytes on the wire, and a compressed body can inflate far past it.
          const run = async (argv: string[], timeoutMs: number) => {
            let r: Awaited<ReturnType<NonNullable<ExecutionTarget["run"]>>>;
            try {
              r = await target.run!(argv, { signal, timeoutMs, maxBytes: FETCH_BYTES });
            } catch (err) {
              throw (err as Error).message.startsWith(OUTPUT_OVER) ? new Error(FETCH_TOO_LARGE) : err;
            }
            return { ...r, stdout: maskSecrets(r.stdout, secrets), stderr: maskSecrets(r.stderr, secrets) };
          };
          let page: FetchedPage = await fetchedPage(url.href, await run(fetchArgv(url.href), 30_000), signal);
          // A page built by JavaScript: render it in the sandbox's Chromium, under the same switches, and keep what reads longer.
          if (page.thin && web.canRender?.()) {
            const r = await run(renderArgv(url.href), RENDER_MS).catch(() => undefined);
            const rendered = r && renderedPage(url.href, r);
            if (rendered && rendered.text.length > page.text.length) page = rendered;
          }
          // A site that turns curl away often answers a browser: say so in the failure itself, where she reads it.
          if (page.isError) return text(page.refused && web.browser ? `${page.text} ${FETCH_REFUSED}` : page.text, true);
          // Again on the text, which a charset, Markdown or a PDF's streams may have spelled differently from the bytes.
          if (secrets.length) page = { text: maskSecrets(Buffer.from(page.text), secrets).toString("utf8") };
          const part = cutPage(page.text, clamp(p.maxChars, 20_000, 50_000), p.offset ?? 0);
          if (part.isError) return text(part.text, true);
          // The note on where to read on is outside the markers, so a page can't fake it; its headings stay inside.
          return text(`${outside(url.href, withSections(part))}${part.note ? `\n${part.note}` : ""}`);
        } catch (err) {
          return text(`Couldn't fetch ${url.href}: ${(err as Error).message}.`, true);
        }
      },
    });

    if (web.browser) pi.registerTool({
      name: "browse",
      label: "Browse",
      description: "Use a web page in this conversation's own browser, when web_fetch isn't enough: the page needs a click, a field filled in, a login, or several steps to reach something, or web_fetch was refused (401, 403, 429, Anubis) or came back empty. browse waits out Anubis's check by itself. Every action answers with the page as it is now, as text, with each link, button and field on a line of its own under a number; act on one by its number. The browser stays open between calls and keeps its logins. A file a page offers is saved in downloads/ of this conversation's folder. It runs in this conversation's sandbox, so its internet switch and allowed hosts apply. To read a page whose address you have, try web_fetch first.",
      promptSnippet: "use a web page: click, fill in fields, log in; open a page web_fetch was refused",
      promptGuidelines: [OUTSIDE_GUIDELINE],
      annotations: { openWorldHint: true },
      parameters: Type.Object({
        action: StringEnum(BROWSE_ACTIONS, { description: "open: go to url. read: the page again, from offset. click: the numbered thing. type: text into the numbered field, replacing what it holds. select: the option named by text in the numbered select. attach: a file of this conversation's (path) into the numbered file field, which asks the user first. scroll: a screen down or up, for a page that loads more as it scrolls. back: the page before. screenshot: the visible part as an image. close: close the browser, keeping its logins." }),
        url: Type.Optional(Type.String({ description: "open: an http or https URL." })),
        ref: Type.Optional(Type.Integer({ description: "click, type, select: the number in brackets before the thing, from the latest page text." })),
        text: Type.Optional(Type.String({ description: "type: the text. select: the option's name." })),
        submit: Type.Optional(Type.Boolean({ description: "type: true presses Enter after the text." })),
        direction: Type.Optional(StringEnum(["down", "up"] as const, { description: "scroll: down if left out." })),
        offset: Type.Optional(Type.Integer({ description: "read: where to start, in characters, as a cut page names. 0 if left out." })),
        path: Type.Optional(Type.String({ description: "attach: the file, as a path in this conversation's folder." })),
      }),
      async execute(id, p, signal) {
        let url: URL | undefined;
        if (p.action === "open") {
          try { url = new URL((p.url ?? "").trim()); } catch { return text(`${p.url ?? "Nothing"} isn't a URL.`, true); }
          if (url.protocol !== "http:" && url.protocol !== "https:") return text("browse opens only http and https URLs.", true);
        }
        const numbered = p.action === "click" || p.action === "type" || p.action === "select" || p.action === "attach";
        if (p.action === "attach" && !p.path) return text("attach needs path: the file to attach.", true);
        if (numbered && p.ref === undefined) return text(`${p.action} needs ref: the number of the thing on the page.`, true);
        if ((p.action === "type" || p.action === "select") && p.text === undefined) return text(`${p.action} needs text.`, true);
        try {
          const r = await web.browser!().act(id, {
            action: p.action, ...(url ? { url: url.href } : {}), ...(numbered ? { ref: p.ref } : {}),
            ...(p.text !== undefined ? { text: p.text } : {}), ...(p.action === "attach" ? { path: p.path } : {}), ...(p.submit ? { submit: true } : {}), ...(p.direction ? { direction: p.direction } : {}),
          }, signal);
          if (p.action === "close") return text("The browser is closed. Its logins are kept.");
          if (r.image) return { content: [{ type: "text" as const, text: `A screenshot of ${r.url}` }, { type: "image" as const, data: r.image, mimeType: "image/jpeg" }], details: undefined };
          if (r.text === undefined) return text(`Couldn't ${p.action}: ${r.fail ?? "the browser gave no page"}.`, true);
          // The page's own words, a message box's included, go between the markers; what is ours stays outside them.
          const whole = [`${r.title}\n${r.url}`, ...(r.notes?.length ? [r.notes.join("\n")] : []), r.text || "The page shows no text."].join("\n\n");
          const part = cutPage(whole, BROWSE_CHARS, p.action === "read" ? p.offset ?? 0 : 0);
          if (part.isError) return text(part.text, true);
          // Off, nothing is said about such a box (the owner's rule); on, the note is ours, so a page can't fake it.
          const allowed = web.botChecks?.() && BOT_BOX.test(r.text) ? `\n${BOT_ALLOWED}` : "";
          // What was downloaded is ours to say, after the markers; the site's name for a file is cut short.
          const saved = (r.downloads ?? []).map((d) => {
            const name = JSON.stringify(d.name.slice(0, 80));
            return d.path ? `Downloaded ${name} to ${d.path}${d.bytes !== undefined ? ` (${size(d.bytes)})` : ""}.` : `Couldn't download ${name}: ${d.fail ?? "it failed"}.`;
          });
          return text(`${r.fail ? `${r.fail}\n` : ""}${outside(r.url ?? "the browser", withSections(part))}${part.note ? `\n${part.note}` : ""}${saved.length ? `\n${saved.join("\n")}` : ""}${allowed}`, !!r.fail);
        } catch (err) {
          return text(`Couldn't ${p.action}: ${(err as Error).message}.`, true);
        }
      },
    });

    pi.on("session_start", (_event, ctx) => gate(ctx));
    pi.on("before_agent_start", (_event, ctx) => { gate(ctx); });
  };
}

/** A size in bytes, in kB or MB. */
const size = (n: number) => (n < 1_000_000 ? `${Math.max(1, Math.round(n / 1000))} kB` : `${(n / 1_000_000).toFixed(1)} MB`);

/** A cut page's text with the headings past its window after it, both the page's own words. */
function withSections(part: { text: string; sections?: string }): string {
  return part.sections ? `${part.text}\n\n${part.sections}` : part.text;
}
