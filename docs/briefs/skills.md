# Brief: Skills

**Status:** Built on `claude/project-thread-30ndu9` (Roadmap thread), in review.
Roadmap item 4. The owner chose it on 2026-10-20 and decided: her own skills
need approval, with a setting to approve them automatically, and skills load
in every thread.
**Read first:** AGENTS.md, PRINCIPLES.md (3, 6, 8), DESIGN.md "Memory" and
"Code mode", docs/contracts.md (Memory tools, pool store), docs/ux.md.

## Why

She repeats jobs such as render checks, CI fixes and releases, and does them
a little differently each time. Claude Code and Codex keep reusable
procedures as skills. The prompt carries one line per skill, and the body is
read only when a task calls for it. That way she gets better at recurring
jobs without a longer prompt (comparison.md, "Reusable procedures").

## What a skill is

A name (lowercase words joined by `-`, at most 64 characters), a one-line
description of when to use it (at most 200 characters), and a body in
Markdown (at most 8,000 characters).

## A. Where skills come from

1. **Repositories.** Each checkout the thread works in (`checkoutsOf`), in
   any mode, is searched for `.claude/skills/*/SKILL.md` and
   `.agents/skills/*/SKILL.md` with `git ls-files`. The name and description
   come from the file's frontmatter. There are at most 20 per repository,
   and they are read the same way `repoRules` reads files (the sandbox's
   `cat` and `git`, 5 s each). She reads a body with `read` at its path.
2. **The person's.** Written in **Settings → Skills**.
3. **Hers.** She saves a draft with `save_skill`. It is used once the person
   approves it, or straight away when **Approve her skills automatically**
   is on.

Library skills (2 and 3) are stored in the pool they belong to, in that
pool's encrypted database, in a `skills` table added by pool step 10 (expand
only), and reached only through the pool's view. They are limited to 100 per
pool. A memory wipe removes them with the pools unless its **Keep skills**
box (ticked by default) stays ticked; then active skills carry over.
Saving a name that already exists replaces that skill once the new version
is approved; until then the old one stays active.

**Pools.** A skill saved from a Private thread is in private.db and is
listed only in Private threads. The person's skills and skills saved from
General threads are in general.db and listed everywhere. A General thread
can't open private.db, and Settings lists only the pools the display shows.

## B. The index in every thread

- A stable system section `skills` lists each active skill as its name, its
  description, and where to read it: `read_memory` with `s:<name>` for
  library skills, or the file path for repository skills.
- It is capped at 40 skills and 4,000 characters. Library skills come first,
  then repository skills, cut whole.
- One line says to read a skill before doing the job it describes and to
  follow it.
- Subagents don't get it. A coder works in the parent's checkouts, and the
  parent passes on what it needs.
- Repository skills are looked up only when the thread has checkouts, so a
  thread without any starts no sandbox for them. Each thread caches them by
  checkout and HEAD, so an unchanged checkout costs one git call a turn. An
  edit to a SKILL.md shows once it is committed.
- `save_skill`'s words are counted in daemon/test/context.test.ts's headroom
  (`SKILL_TOOL_TEXT`), as Agent loop asked.
- `read_memory` takes `s:<name>` and returns the body of an active skill in
  that thread's pools.

## C. `save_skill`

- `save_skill({ name, description, body })` is one new model-facing tool,
  making 21 in all, within principle 8's budget of 30. It isn't offered in
  read-only threads or to subagents.
- The result says whether the skill is active now or waiting for approval.
- Guidance: save a skill after a job she will do again worked, or when the
  person asks her to remember how to do something. Never put credentials or
  facts about the person in a skill: those belong in notes.

## D. Approval

- **In the thread:** the `save_skill` call shows as a card with the name,
  the description and the body (folded), and **Approve** and **Decline**.
  Once the person answers, or when auto-approve is on, the card shows the
  outcome instead.
- **In Settings → Skills:**
  - every library skill, with its source (yours or hers), its pool and its
    state;
  - **Approve** and **Decline** on waiting ones, and **Remove** on each;
  - **Add skill**, with name, description and body fields;
  - the switch **Approve her skills automatically**, off by default (user
    setting `skills.auto_approve`).
- A waiting skill appears in Notifications as a suggestion that links to
  Settings → Skills.
- Nothing from a repository or from her can turn auto-approve on, or approve
  a skill.

## Out of scope

- Skills for sleep.
- Skill files beyond the body (scripts, references).
- Sharing a skill between users.
- Slash commands to run a skill.

## Principles

- **3:** Pi's skill format and on-demand reading, with Lyrica's own index.
- **6:** her drafts wait for the person, unless the person chose otherwise.
- **8:** one new tool (21 of 30) and no new process.
- **Privacy:** skills in each pool's own database, nothing logged.

## Docs to update

- DESIGN.md (Memory, skills).
- docs/contracts.md (`save_skill`, `read_memory` `s:`, pool step 10, API).
- docs/memory.md.
- docs/ux.md (Settings → Skills, the card).
- docs/web.md.
