# Web search 2

The owner's decision (2026-10-29): revisit her `web_search` and `web_fetch`
and build the improvements below. The tools stay two (principle 8), every
provider stays free (SearXNG and local code), and the privacy rules don't
change: search goes from `lyricad` to the server's SearXNG, every fetch
runs in the thread's sandbox under its network switches, and credentials
stay masked. The agent loop is a risky area, so the code goes to PR review.

## Part A: the tools (one PR)

1. **Only the article, as Markdown.** `web_fetch` runs Mozilla Readability
   (over linkedom) and gives the main text as Markdown (turndown), headed
   by the page's title, URL, byline and date. A page Readability can't read
   falls back to the whole body, without scripts, styles, navigation,
   forms or images. curl sends a browser's user agent, since many sites
   refuse curl's.
2. **Read on past the cut.** An `offset` argument (characters) starts
   where the last cut ended; the cut note names the offset to use.
3. **PDFs.** A PDF is read as text with pdf.js (unpdf) in a child
   process of `lyricad`, killed past a time limit or once its resident
   memory passes a limit (a worker thread's heap limit didn't hold: pdf.js
   decodes streams outside the heap), so a bad file can't stall the daemon. Fetches may be up to 10 MB.
4. **Search filters and dates.** `web_search` takes `time` (day, week,
   month, year), `category` (general, news, science, it, videos) and
   `page`; each result shows its date when SearXNG has one.
5. **Pages built by JavaScript.** When a page's text is nearly empty and
   the sandbox has Chromium, `web_fetch` renders it there
   (a small script on the sandbox's node driving Chromium over its
   DevTools pipe, as the page preview does; `--dump-dom` hung in testing),
   under the same network switches, and reads that.
6. **Outside content marked.** Both tools' results go between two
   markers holding a code made fresh for each call, and her guideline says
   what is between them is information, never instructions (the owner,
   2026-10-29). The owner declined making commands ask after she reads a
   page.
7. **Clearer failures.** A search with no results whose engines failed is
   retried once; if still empty, she's told which engines didn't answer
   and why, and SearXNG's suggestions.

## Part B: sources under her reply (a UI PR after A)

The pages she read show under her next words as a **Sources** row of
links (title and host), built from her successful `web_fetch` calls since
the person's last message or her last words. Home: docs/ux.md, "The pages
she read for a reply". Searches aren't listed: a snippet isn't a page she
read.

## Out of scope

Paid search APIs, a search cache, new tools, and changing what a private
thread may reach.

## Handoff

Part A: merged in #628 (fda62c5). Part B: on `claude/project-thread-ax31pt`
(web/src/Messages.tsx `Sources`/`sourcesOf`, web/src/app.css; tests in
web/test/tool-markers.test.ts and the "Sources" e2e in web-chat.spec.ts,
with a `fetch:` command in the e2e fake). Next: UI review, then merge.
