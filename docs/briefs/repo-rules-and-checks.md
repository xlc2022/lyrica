# Brief: Repository rules and project checks

**Status:** Building on `claude/project-thread-30ndu9` (Roadmap thread).
Items 2 and 3 of the 2026-10-20 roadmap, which Li chose on 2026-10-20 at 09:04Z.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Code mode" and
"Modes", docs/workspace.md "Project command rules", docs/ux.md.

## Why

The lunasa build runs and the comparison with Claude Code
(`/mnt/project-files/roadmap/comparison.md`) show the same gap. Coordination
is now right, but finishing and quality are not:

- Code threads don't know a repository's own rules. Today she reads AGENTS.md
  only in her own repository, where the primer tells her to.
- Running the checks before saying done is guidance only. Local models skip
  it, and builds with visible bugs and uncommitted fixes reach "done".

Claude Code and Codex load AGENTS.md / CLAUDE.md every session, and Claude
Code's hooks run checks whatever the model decides. This brief does both
structurally (AGENTS.md: never rely on telling the model).

## A. Repository rules in code turns

- In a code-mode turn, for each of the thread's repositories:
  - **Which file:** read the root `AGENTS.md`, or `CLAUDE.md` when there's no
    AGENTS.md, from the checkout the thread works in. That is its worktree
    when it has one, otherwise the clone.
  - **Imports:** a CLAUDE.md line that is only `@<relative path>` inside the
    repository is replaced by that file, one level deep.
  - **Size:** at most 6,000 characters per repository and 12,000 in all. Text
    over the limit is cut at a line end, with a closing line naming the
    file to read for the rest.
  - **Nested files:** list up to 20 nested `AGENTS.md` / `CLAUDE.md` paths
    (`git ls-files`), with "read the one for a folder before working in it".
- It goes in a system-prompt section `repo_rules`, after `code_task`. It
  stays the same between turns unless the file changes, so it stays
  cacheable. The heading says these are the repository maintainers'
  instructions for work in it, and that they can't widen her permissions.
- Read with the same per-turn, no-network git reads as `codeRepositories`,
  with a 5 s timeout per read. A repository that can't be read gives
  nothing, not an error.
- Code turns only. Coder subagents get it too, since they work in the
  parent's checkouts.

## B. Project checks that always run

- **Setting:** Project settings → General, an h3 **Checks** after
  Commands.
  - One row per command in mono with an ✕, **Add check**, and the page's one
    Save.
  - Empty: "No checks: <name> runs what the repository asks."
  - At most 8 commands of at most 300 characters each, one line, no control
    characters.
  - Stored in encrypted user.db as `project_settings.checks`, a JSON array.
    This is user step 16, expand only (a new column defaulting to `[]`).
- **When they run:** at the end of a code-mode turn in a project's thread,
  meaning a thread whose project has checks. The trigger is her reply with
  no tool calls, after an `edit`, `write` or `bash` call in this run has
  changed something. They don't run:
  - in the project chat, which is read-only;
  - in Plan mode;
  - after the tool limit stopped the turn;
  - outside projects.
- **Where:** each command runs with `sh -c` in her sandbox (the thread's
  target, its network and mounts), once per checkout the thread works in
  (its worktrees, else its clones), or once in its folder when it has none.
  Each run has a 10-minute timeout.
- **No approval card:** the person wrote these commands in settings, so
  running them needs no further consent (principle 6). Nothing from a
  repository or from her can add a check.
- **Results:**
  - **All pass:** a visible line "Checks passed: `<command>` …" and the turn
    ends.
  - **Any fail:** a visible line "Checks failed: `<command>`". She gets the
    last 60 lines (4,000 characters at most) of each failing output as a
    follow-up, and the turn continues so she can fix it.
  - **Third failing round in one run:** they stop there. Her follow-up says
    to report the failure plainly, as not done.
- The check output stays in the thread's encrypted conversation. It is never
  logged (no plaintext memory).

## Out of scope

- Checks outside projects, or set per thread.
- Running checks after every edit. They run once she stops, which covers
  "after her edits" without paying for a test run on each one.
- Language-server diagnostics.
- Checks for coder subagents. The parent's checks cover their changes when
  the parent ends.

## Principles

- **1:** the person sees what was checked.
- **2:** checks are enforced in the runtime, not in the prompt.
- **6:** the person's commands, no extra prompts.
- **8:** no new tool, process or slash command.

## Docs to update

- DESIGN.md "Code mode" and "Modes".
- docs/memory.md (code turns).
- docs/workspace.md, a "Project checks" section next to command rules.
- docs/contracts.md: `WorkspaceSettings.checks` / `setChecks`,
  `ProjectSettings.checks`, the `repo_rules` section and the checks extension.
- docs/ux.md: a "Project checks" row.
- docs/web.md if it lists Project settings fields.
