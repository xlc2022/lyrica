# Brief: Page tools and offline libraries

**Status:** Built on `claude/project-thread-30ndu9` (Roadmap thread), in review.
The owner approved items 1 to 3 of the tooling proposal on 2026-10-23
("Send 1-3"). Item 4, a planning nudge, is parked in the roadmap.
**Read first:** AGENTS.md, PRINCIPLES.md (1, 2, 8), docs/workspace.md
("Sandbox", "Tools"), docs/contracts.md (extension, core/workspace).

## Why

In the same-file runs on lunasa (Flash Next, MiniMax, GPT, the 27B), every
project rebuilt the same tools before it built the page it was asked for:

- a headless Chromium screenshot script with the right GPU flags;
- PNG decoding for pixel checks, where one run read Chromium's 3-channel
  PNGs as 4-channel and argued for an afternoon over a bug that didn't exist;
- single-file bundling, and a check that the file loads nothing from the
  network;
- a WebGL engine of its own, partly because a single offline file can't
  load three.js from a CDN.

The homemade tools were slow to build and caused some of the worst stalls.
Giving every thread these tools, and the libraries, lets her spend the
turns on the page itself (principle 1: do what was asked, well).

## What to build

1. **One tool, `page`** (`extension/src/page.ts`), sandbox only, with three
   actions:
   - `preview`: opens an HTML file in the sandbox's Chromium (SwiftShader
     WebGL, network blocked) at a given size, with optional URL parameters
     and a wait after load. It returns the screenshot as an image, saved
     under `/workspace/previews/`, plus console messages, uncaught errors,
     blocked network requests, the canvases on the page, the share of pixels
     that differ from the background, and the dominant colours.
   - `bundle`: turns a page and its local scripts (module imports included),
     stylesheets and images into one self-contained HTML file, then checks it.
   - `check`: lists what a page would still load from elsewhere (http(s)
     URLs in `src`, `href`, `url()` and `@import`, and network calls such as
     `fetch`), and local files it still refers to.
2. **Offline libraries** mounted read-only at `/opt/libs` in every sandbox:
   three.js (with its addons), simplex-noise and tween.js, from Lyrica's own
   `node_modules`. `page bundle` resolves them by name (`"three"`,
   `"three/addons/…"`), and the prompt names them with their versions.

## Decisions

- **One tool, not three** (principle 8): the actions share the file, the
  browser and the checks. The tool count goes from 23 to 24 of 30 in a
  thread (`read`, `write`, `edit`, `bash`, `tool_search` and the extension's
  registered tools; the sleep-only tools aren't in a thread).
- **Chromium runs through the sandbox's `node`** with the DevTools protocol
  over a pipe, not by a Node library: nothing new in the sandbox, one
  browser launch per preview, and the messages come back exact.
- **PNG decoding happens in lyricad** (Node's zlib), on the bytes the
  sandbox returns, so a page can't fake its own stats.
- **Bundling uses esbuild in lyricad**, with every file read through the
  sandbox (its `read`), so a page can't reach a file outside the thread's
  folders and `/opt/libs`. esbuild is already in Lyrica's dependencies
  through tsx.
- **Modes:** `bundle` writes, so it asks where `write` asks and is held by
  the same-file check; `preview` and `check` only read. None of them run in
  Plan mode.

## Out of scope

- The planning nudge (item 4): parked in the roadmap until the owner says.
- Showing the screenshot in the tool card: the image-preview thread is
  changing tool cards; the result names the saved file meanwhile.
- More libraries: add them by the same pattern once a run shows the need.
