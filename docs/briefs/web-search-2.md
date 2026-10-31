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

## Part C: engines that refuse (2026-10-31)

Her search on the dev deployment answered nothing: SearXNG's three
default general engines had all refused (DuckDuckGo and Startpage a
CAPTCHA, Brave "too many requests") at a few searches an hour, from a
home address, and SearXNG's own defaults rest a refused engine for up to
a day, while she retried every empty search at once.

1. **SearXNG settings** (the install.sh template, the NixOS module, the
   guide): Bing, Qwant and Yahoo on, Startpage off (a proof-of-work
   CAPTCHA), rests of 15, 10 and 3 minutes instead of a day, and a 6 s
   engine timeout, since Qwant and Yahoo miss 3 s.
2. **Her side** (`SearchGate` in `core/src/web.ts`): requests to SearXNG
   a second apart, the same search answered from its last reply for a
   minute, a retry only when an engine failed passingly, and, when every
   engine refused, how long each has been refusing and that asking
   again gets the same answer. Her guideline says not to.
3. Out of scope: a keyed or paid engine (Brave's API and the like need a
   sign-up), a proxy or Tor for SearXNG's outgoing requests.

## Out of scope

Paid search APIs, a search cache, new tools, and changing what a private
thread may reach.

## Handoff

Part A: merged in #628 (fda62c5). Part B: merged in #635 (5a868a9).
Part C: on `feature/web-search-rate`; done as written above, with tests
in core/test/web.test.ts. Next: PR review, merge, then the dev
deployment rebuilds so the module's new SearXNG settings apply.
