# Brief: Projects (sleep)

**Thread:** Sleep. **Branch:** `feature/projects-sleep`. **Model:** Opus.

**Depends on:** Projects (back end): `Thread.project`, `pageForProject`,
`projectNotes`.

**Read first:** AGENTS.md; DESIGN.md "Projects", "Memory" and "Sleep";
docs/sleep.md, docs/memory.md; docs/contracts.md `core/store` and `sleep`
(Planned (Projects)).

## Goal

Each project's page says what Lyrica knows about the project: decisions,
requirements, pitfalls, who to ask, what is open. Every thread of the
project starts with it, so the project carries its own memory from day to
day (principle 5: invest in the curator).

## In scope

1. **Consolidate** writes and updates the "what she knows" part of
   `p:project-<id>` from that night's notes and threads of the project,
   citing them as any page does. One page per project, in its pool.
2. **Li's instructions** on the page are User introduced: sleep keeps them
   word for word and only adds around them (the store already refuses
   anything else).
3. Project notes folded into the page stay notes; the `project` section
   then loads them through the page, not as recent notes.
4. An unlogged project gets no page from sleep.
5. Unfinished work in a project goes into WAKE as for any work.
6. **Docs:** docs/sleep.md and docs/memory.md.
7. **Watching threads** (projects.md): a `[Watching threads]` message in the
   project chat quotes Li from a thread. Sleep takes Li's words from the
   thread where they were said, never from that message. Built in #97:
   a look isn't indexed and `read_memory` shows it as a pointer.

## Done when

- Tests: a night with project notes updates the page and cites them; Li's
  instructions survive word for word; a private project's page is written
  only by private sleep; an unlogged project gets none. An eval: after a
  decision noted in one thread, the next night's page states it.

## Handoff notes

(The thread fills this in if it stops before it's done.)
