# Rich Markdown in chat

Serves principle 1, experience before infrastructure: an answer laid out as a
table, a diagram or a chart should read as one, not as raw marks. The
renderer stays local: nothing it draws calls the network or runs a script the
page didn't ship (the privacy and cloud boundaries).

## Step 1: GitHub's Markdown (PR #576)

Before it, `Prose` ran plain CommonMark, so no table rendered at all, and a
model that wrote a table on one line showed its pipes as text. Now:

- `remark-gfm` in `Prose` (`web/src/ui.tsx`): tables, task lists,
  strikethrough, footnotes, bare links, everywhere Markdown renders.
- `unfoldTables` (`web/src/markdown.ts`) puts a one-line table back on its rows
  before parsing; fenced code is left as written.
- Styles in `app.css` under `.prose`; docs/ux.md "Tables and other Markdown
  in a message".

## Step 2: diagrams, charts and math (the user picked all three)

- `web/src/RichBlock.tsx`: a ` ```mermaid ` fence drawn by Mermaid (strict,
  SVG labels), a ` ```vega-lite ` fence by Vega-Lite (interpreted
  expressions, a loader refusing every URL, a spec naming one refused), math
  by KaTeX. Each loads as its own chunk only when a message holds one; the SVG
  is sanitized with DOMPurify. Preview | Source and Copy in the strip.
- `web/src/markdown.ts`: `mathMarks` turns `\( \)` and `\[ \]` into `$$`;
  `remark-math` runs without single-dollar math, since `$` is a price far
  more often.
- `FORMATS_LINE` in `extension/src/workspace.ts` tells her what renders.
- docs/ux.md "Diagrams, charts and math in a message"; docs/web.md;
  docs/workspace.md.

## Handoff

Done: step 1 (PR #576) and step 2 (PR #577). Next: nothing planned; watch whether she
uses the formats well, and whether a chart needs more than inline data.
Open: none.
