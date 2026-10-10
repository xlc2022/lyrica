# Brief: Modes and switches (Plan mode, renamed permission modes, tool switches)

**Thread:** Delegation (after Delegation 2, which changes the same permission
path). **Branch:** `feature/modes`.

**Depends on:** Delegation 2 merged.

**Read first:**
- AGENTS.md and PRINCIPLES.md;
- DESIGN.md: "Modes, in the message box" and "Switches in the message box"
  (under Runtime), and the Delegation and Subagents bullets;
- docs/workspace.md (Approval, thread settings), docs/delegation.md,
  docs/daemon.md (permission prompts), docs/web.md;
- docs/contracts.md: the planned Modes entry, `extension`, `daemon`.

## Goal

Choosing how much Lyrica may do is as quick as in Claude Code, and turning a
tool off for a chat is as quick as in Open WebUI, with every limit enforced by
the code. This serves principle 1 and keeps the boundaries structural.

## In scope

1. **Renamed modes**: `ask` (asks before `bash`, `write`, `edit`),
   `acceptEdits` (asks before `bash`), `auto` (default). Migrate stored
   settings in place ("ask before changes" → `ask`, "ask before commands" →
   `acceptEdits`). A per-user default for new threads.
2. **Plan mode.**
   - Only read-only tools are active: `read`, `recall`, `read_memory`,
     `web_search`/`web_fetch` if switched on, `delegate` with read-only roles
     only, and a new `propose_plan({ plan })`. `write`, `edit`, `bash`,
     `image` and `remember` are not active.
   - `propose_plan` shows the plan as a card with **Go ahead in…** (Ask,
     Accept edits, Auto) and **Keep planning**; it goes through the same
     approval path as tool approvals, so any open view can answer. Approving
     switches the thread's mode and she continues with the plan in context.
   - The tool counts against the budget (principle 8); say the new total.
3. **Switches**: thread settings `webSearch` and `images` beside the existing
   `internet`, each on by default except where the thread's settings say
   otherwise. Off removes the tools from the session (`setActiveTools`), and
   the workspace still refuses network with `internet` off. Subagents and
   child threads inherit and can only narrow.
4. **Inheritance**: subagents and child threads get the parent's mode or a
   stricter one (order: plan, ask, acceptEdits, auto); a Plan-mode parent's
   subagents are read-only roles only.
5. **Web UI.** A mode picker beside the message box (the current mode's name;
   a menu with each mode's one-line description and a number key, as in
   Claude Code's); Shift+Tab cycles; a "+" menu with the three switches;
   the plan card. The thread settings panel shows the same values.
6. **Docs.** docs/workspace.md, docs/delegation.md, docs/web.md.

## Out of scope

- An Auto mode that judges each call with a model (Claude Code's
  classifier). Auto stays "freely inside the grants".

## Done when

- `npm run typecheck` and `npm test` pass in CI, including the sandbox
  suites.
- Tests show that:
  - stored modes migrate correctly;
  - in Plan mode `write`, `edit`, `bash`, `image` and `remember` aren't
    available and a writer subagent is refused, while reading works;
  - approving a plan switches the mode and the next turn can write;
  - irreversible actions still ask in Auto;
  - each switch off removes its tools, and a subagent or child thread can't
    turn it back on;
  - a child of an Ask thread can't run in Auto.

## Handoff notes

(The thread fills this in if it stops before it's done.)
