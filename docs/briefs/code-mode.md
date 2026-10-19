# Brief: Code mode

**Status:** Approved to build (the owner, 2026-10-19); brief in PR review.

**Branch:** `feature/code-mode`. **Built by:** Codex on the test machine
(Opus for review fixes).
**Read first:** AGENTS.md, PRINCIPLES.md (1, 2, 6, 8), DESIGN.md
(Delegation, Projects, Memory), docs/contracts.md (core/workspace, Modes,
Delegation), docs/memory.md, docs/delegation.md, docs/workspace.md,
docs/ux.md (Thread settings).

## Goal

She codes like a competent coding agent when the work is code. Today
every turn she takes carries her whole companion self: the full persona,
WAKE, the about-user page, recall from anything in the pool, and tools for
models, downloads and images. A coding agent's context is mostly the task
and the repository. Code mode gives a thread or a subagent that shape,
without cutting her off from what the user has told her about how to work.

- Principle 6: the user decides, so code mode only narrows what she sees
  and uses. It never widens a permission, so she may turn it on herself.
- Principle 1: memory stays, narrowed to the project and to the user's
  stated coding and workflow preferences.
- Principle 8: one switch, one task model, one role, no new process.

## In scope

**A. The switch.** A thread setting `code: boolean`, off by default.

- Stored as a `thread_workspaces` column (`code`, the next free user.db
  step, expand-only) and returned in `ThreadSettings`.
- Inherited like the other switches: a child thread, routine thread or
  branch of a code-mode thread starts in code mode. Unlike the narrowing
  switches, a child may turn it off.
- Three ways on and off, all the same setting:
  - **Thread settings** → Behaviour: a Switch **Code mode** with the hint
    "Focus on the code: a coding model, a short persona, and only this
    project's memory and your working preferences."
  - **By asking her:** a `threads` action `code({ on, task?, done? })`.
    She uses it when the user asks for code mode, or turns it off when
    they ask. It applies from her next turn, emits a `settings` event, and
    is refused in a subagent.
  - **A project** may set it for its new threads (Project settings →
    General, beside the threads model), applied in children.ts with
    `threadsModel`.
- Code mode never changes the thread's Mode. Auto, the project's command
  rules and machine limits work as they do now.

**B. What changes in a code-mode turn.**

1. **Model.** A new task `code` ("Coding" in Models), added to
   `LATER_TASKS` as `{ same: "subagent.strong" }`. A code-mode thread's
   chat calls use the `code` list. A thread's own model choice still wins.
2. **Persona.** SOUL.md only. STYLE, REGISTER and topic routing are left
   out, so she keeps who she is but not her conversational register.
3. **Memory sections.**
   - Kept: the project section (goal, the user's instructions, notes since
     sleep, the page), folder pages and pinned items.
   - Left out: WAKE, the about-user page and the page index.
   - Recall is filtered to project items (`inProject`) plus **working
     preferences**: notes whose `about` includes `working` (D). Add a
     `SearchOptions.only` filter that reuses `inProject`; don't copy it.
     Outside a project, recall is preferences only.
   - `remember`, `recall` and `read_memory` stay. Recall's filter applies
     to her `recall` calls too, unless she passes `everywhere: true` for a
     single search.
4. **Tools off:** `models`, `downloads`, `image` and `react`, via
   `setToolsOff(…, "code", …)`. Everything else is unchanged.
5. **Guidelines:** a short code-mode block in the prompt: read before
   editing, run the repository's checks after each change, read a failing
   log before changing anything, keep diffs small, and say what was
   verified. Keep it to five lines (principle 8).

**C. Starting with what she's doing and what's done.**

- `code({ on: true, task, done })` takes two short fields (300 and 1200
  characters): what she is about to do, and what has been done so far
  (decisions, branch, open PR). They are kept on the thread as the **Code
  task** section, shown in the stable prompt while code mode is on, and
  replaced by the next `code` call.
- When the user turns code mode on from Thread settings, her next turn's
  guidelines ask her to set the task with `code` first, so the section is
  never empty for long.
- The section also lists, with no model call: each of the thread's
  repositories with its branch, the commits on it since the base branch
  (subject lines only, at most 10), and an open pull request with its
  check state if the forge watcher knows one.

**D. Working preferences.**

- The `remember` guidelines gain one line: "When the user states how they
  want code or work done, add `working` to the note's about."
- Sleep's consolidate step keeps `working` on notes it merges, and may add
  it to a note that plainly states a coding or workflow preference.
- No new note kind and no schema change for this: `about` already exists.

**E. The `coder` subagent role.** A built-in role beside `worker`:

- tier `strong` but model from the `code` task; tools read, write, edit,
  bash, recall, read_memory; writes; thinking high.
- Unlike other subagents, it starts with code mode's memory sections:
  the project section and recall filtered as in B3. It still gets no
  persona beyond its role prompt.
- Its task is the delegate step's `task` plus an optional `done`, shown as
  the Code task section. Its role prompt is the B5 guidelines.
- A custom role named `coder` overrides it, as for other built-ins.
- **Every model knows it's there**, including small local ones. The
  `delegate` tool's role list names `coder` first with a one-line use
  ("code changes in a repository: edit, test, fix"), and the thread
  guidelines gain one line, outside code mode as well: "For a coding job,
  delegate to the `coder` role, or turn on code mode if the user is
  working with you on it." Both are always in the prompt, not behind
  `tool_search`.

## Out of scope

- Changing Mode, command rules or machine limits.
- A new note kind, or moving existing notes into `working` (sleep may tag
  as it consolidates).
- LSP, indexing or new coding tools.
- Renaming or removing `worker`.

## Done when

- Scripted: in a code-mode thread the assembled prompt has SOUL but not
  STYLE or REGISTER, has the project section and a Code task section, has
  no WAKE or about-user page, and the tool list lacks models, downloads,
  image and react. Turning it off restores all of them.
- Recall in code mode returns a project note and a `working` note, and
  not an unrelated note with the same words; `everywhere: true` returns
  it.
- `threads code` turns it on and off, is refused in a subagent, and never
  changes Mode. The setting migrates from every released user schema.
- A child thread of a code-mode thread starts in code mode; a project
  with code mode for new threads starts them in it.
- A `coder` subagent gets the project section and the filtered recall,
  and the `code` model list.
- The eval also asks a plain (non-code-mode) thread to fix the fixture's
  failing test. The scripted check asserts `coder` and the guideline line
  are in the prompt; the real-model check, run against a local model when
  one is configured, records whether her first tool call delegates to
  `coder` or turns on code mode.
- A new eval, `evals/code-mode.eval.ts`: a fixture repository with a
  failing test. The scripted check asserts the prompt and tools above.
  The real-model check, when configured, records whether she runs the
  tests, edits, and reruns them before saying it's done.
- Playwright: the Code mode switch in Thread settings at 1280 and 390 px,
  and the Coding task in Models.
- docs/contracts.md, memory.md, delegation.md, workspace.md, web.md,
  ux.md and DESIGN (Delegation, Memory) are updated in the same PR.

## Handoff notes

(None yet.)
