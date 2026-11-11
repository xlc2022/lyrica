# Memory use on Status

**Ask (the user, 2026-11-11):** track which memories are most salient and most
accessed, and show it in Administration as telemetry, as its own card beside
the other charts.

**Principles.** 5 (memory is reconstruction: seeing what recall surfaces is how
the user judges recall quality) and 6 (make review easy). Nothing feeds back
into recall or sleep.

## What was built

- **Counting** (docs/memory.md, "Recall counts"): pool step 16 adds `recalls`,
  numbers per note or page per UTC hour for automatic recall (`recalled`), a
  `recall` hit (`searched`) and `read_memory` (`opened`). IDs and numbers only;
  31 days kept; deleted with the memory; a private thread's count of a general
  memory stays in the private pool. Not counted: sleep's threads, threads that
  aren't remembered, messages, the journal and WAKE.
- **Salience** has no score of its own in Lyrica. The card uses what memory
  already derives: how many notes, pages and journal entries cite a memory now
  (**Cited by**, **Most cited**).
- **Endpoint:** `GET …/admin/memory-use?days=7|30` (docs/contracts.md).
- **Card:** Memory use, the fourth card on Status (docs/ux.md, "Which memories
  she leans on"; `web/src/MemoryUse.tsx`).
- **Privacy:** the administrator sees only their own memory, in the pools their
  display shows, so a note's first line is shown as in the memory browser.

## Handoff

Done: counting, endpoint, card, docs, tests (`daemon/test/memory-use.test.ts`).
Next: nothing planned. Open: whether the user wants a longer window than 31 days.
