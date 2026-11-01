# Brief: Renaming a file keeps its links

**Status:** Messages built (PR #767, merged 2026-11-01); memories at sleep built (PR #769, merged 2026-11-01). **Owner:** the "Rename files with links auto-updated" thread.
**Read first:** AGENTS.md, DESIGN.md ("Files and images"), docs/workspace.md ("Renaming keeps links"),
daemon/src/relink.ts, core/src/workspace/renames.ts.

## Goal

Renaming or moving a file or photo in the Files panel (or a project's Files and images) leaves every
link to it working: the chips and images in messages, her tool calls and results, the draft, and her
own next turn, which knows the new name.

## Decision

A real rename with every stored mention rewritten, over a fixed ID with a cosmetic name. Her tools,
commands and the sandbox work by path, so an ID scheme would need a translation layer in every tool
and in her context (principle 3, lean on Pi; principle 8, small surface). The message rewrite is one store
method and one helper with no schema change; memories need one small pool table (step 13).

## In scope

- Rewriting the old path as each thread that can reach the file writes it, in its stored entries
  and draft, in the request's pool; re-indexing changed entries.
- Reopening each changed thread's open session at its next turn, reloading its open views, and a
  note in her next turn naming old and new path.
- Memories (second PR, decided by the user 2026-11-01): a ledger of renames per thread in the pool
  (`renames`, pool step 13), applied by plain code at the start of sleep to the notes, pages and
  journal entries citing that thread, as sleep's edit (never marked as the user's), with the old
  text kept as a revision.

## Out of scope

- Other files that copied the path: they keep it. (A user's own notes and words do follow: the user
  renamed the file or approved it, decided 2026-11-01.)
- The other pool, and a file renamed by her own commands (`mv` in bash): only the panel's rename
  rewrites.
- Her reasoning blocks and image bytes, never rewritten.

## Handoff note

Done: messages and drafts (PR #767), memories at sleep (second PR), with a route test
(daemon/test/files.test.ts), unit tests (core/test/workspace.test.ts "renaming keeps links",
core/test/store.test.ts "renamed files at sleep") and a migration test (pool step 13). Next: nothing planned. Open: whether her own
`mv` should rewrite too, if real use asks for it.
