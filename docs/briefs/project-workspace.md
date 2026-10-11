# Brief: Project settings: Folders and Machines

**Thread:** Project workspace. **Branch:** `feature/project-workspace`.
**Model:** Fable (it is all interface). **Depends on:** Web: machines
merged (#83).

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Projects" and
"Machines", docs/ux.md section 6 (the Project settings row and the Machines
rows), docs/web.md "Project settings page" and "Thread settings drawer",
`web/src/Project.tsx`, and the thread drawer's Folders and Machines
controls.

## Goal

A project is set up on one page. Li asked (2026-10-11) whether a project's
settings panel can set which machines and mounts its threads may use. It
can today, but only through the **Thread settings** link under This chat,
which opens the project chat's drawer. This moves the two rows that define
a project's workspace onto the page itself (principle 1: what Li does
often, in one place; docs/ux.md: settings reached often live in the thing's
own settings, not behind a hop).

## In scope

1. **Two rows under This chat** on the Project settings page, between Group
   and the Thread settings link: **Folders** and **Machines**, the same
   controls as the thread drawer's (folders from the allowed paths, each
   read-only or read-write; the sandbox always, then a switch per machine of
   the project's pool). They read and write the project chat's thread
   workspace through the existing settings API; nothing new in `lyricad`.
2. **One Save**, as now, which also patches the thread workspace when these
   changed; `lyricad`'s validation reason is shown in place of the estimate
   line, as the drawer does.
3. **The Thread settings link stays** for network, local-only and the other
   task models. Its tooltip, if it has one, no longer lists folders and
   machines.
4. **Inheritance is unchanged and is the point:** every thread the project
   starts gets these folders and machines or fewer (`inheritSettings`), and
   removing one here removes it from the project's threads at once. Nothing
   in this brief changes what a thread may do.
5. **Docs:** docs/web.md ("Project settings page"), docs/ux.md (the Project
   settings row already names the two rows after this brief's docs PR),
   DESIGN.md's Project settings bullet (same).

## Out of scope

- Per-project allowed folders separate from the user's (allowed paths stay
  per user and pool, set by an administrator).
- Any change to machines, grants or inheritance in `core/workspace`.
- Network, local-only or model rows on the page: the link covers them.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- The PR's checklist from docs/ux.md section 10 is filled in, with
  screenshots at 1280 and 390 of the General section showing the two rows,
  light and dark, no horizontal scroll.
- A project whose chat has a machine taken off on this page shows that
  machine gone from a running thread's facts line without a reload.
- UI review has said verified.

## After merging

Tell the standing Operator docs thread by cross-session message if anything
an operator does by hand changed (nothing is expected to), in addition to
the merge notice to the project chat.

## Handoff notes

(The thread fills this in if it stops before it's done.)
