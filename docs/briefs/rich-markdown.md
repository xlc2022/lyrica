# Rich Markdown in chat

Serves principle 1, experience before infrastructure: an answer laid out as a
table, a diagram or a chart should read as one, not as raw marks. The
renderer stays local: nothing it draws calls the network or runs a script the
page didn't ship (the privacy and cloud boundaries).

## Step 1: GitHub's Markdown (this PR)

Before it, `Prose` ran plain CommonMark, so no table rendered at all, and a
model that wrote a table on one line showed its pipes as text. Now:

- `remark-gfm` in `Prose` (`web/src/ui.tsx`): tables, task lists,
  strikethrough, footnotes, bare links, everywhere Markdown renders.
- `unfoldTables` (`web/src/tables.ts`) puts a one-line table back on its rows
  before parsing; fenced code is left as written.
- Styles in `app.css` under `.prose`; docs/ux.md "Tables and other Markdown
  in a message".

## Step 2: diagrams and charts (proposed, waits on the user's pick)

- **Diagrams:** a ` ```mermaid ` fence drawn by Mermaid (flowcharts,
  sequence, state, Gantt, pie, timeline), `securityLevel: "strict"`, themed
  from the app's tokens, loaded as its own chunk only when a message holds
  one. The block keeps its strip with **Source** to see the text.
- **Charts:** a ` ```vega-lite ` fence (JSON) drawn by Vega-Lite as SVG,
  data inline only (no `url` data: a spec that names one is refused), its own
  chunk. Models write Vega-Lite and Mermaid well without being taught.
- **Math (optional):** `$…$` and `$$…$$` by KaTeX.
- A block that fails to parse shows as its code block with a muted line
  saying why; while it streams it stays a code block.
- Her context gains one line naming the formats that render, so she uses
  them (core context assembly, PR review).

## Handoff

Done: step 1 on `claude/project-thread-x5a8r2`. Next: the user's pick for
step 2, then build it as a follow-up PR with UI review. Open: whether math is
wanted.
