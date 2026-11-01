# Brief: Renaming a file keeps its links

**Status:** Built (2026-11-01, PR in review). **Owner:** the "Rename files with links auto-updated" thread.
**Read first:** AGENTS.md, DESIGN.md ("Files and images"), docs/workspace.md ("Renaming keeps links"),
daemon/src/relink.ts, core/src/workspace/renames.ts.

## Goal

Renaming or moving a file or photo in the Files panel (or a project's Files and images) leaves every
link to it working: the chips and images in messages, her tool calls and results, the draft, and her
own next turn, which knows the new name.

## Decision

A real rename with every stored mention rewritten, over a fixed ID with a cosmetic name. Her tools,
commands and the sandbox work by path, so an ID scheme would need a translation layer in every tool
and in her context (principle 3, lean on Pi; principle 8, small surface). The rewrite is one store
method and one helper, with no schema change and no migration.

## In scope

- Rewriting the old path as each thread that can reach the file writes it, in its stored entries
  and draft, in the request's pool; re-indexing changed entries.
- Reopening each changed thread's open session at its next turn, reloading its open views, and a
  note in her next turn naming old and new path.

## Out of scope

- Memories, notes, pages and other files that copied the path: they keep it (memory changes are
  hers, with revisions; principle 5).
- The other pool, and a file renamed by her own commands (`mv` in bash): only the panel's rename
  rewrites.
- Her reasoning blocks and image bytes, never rewritten.

## Handoff note

Done: everything in scope, with a route test (daemon/test/files.test.ts) and unit tests
(core/test/workspace.test.ts "renaming keeps links"). Next: nothing planned. Open: whether her own
`mv` should rewrite too, if real use asks for it.
