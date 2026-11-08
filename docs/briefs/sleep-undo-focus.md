# Brief: Undo a night, and a thought for tonight

**Status:** built, in review. **Branch:** `claude/project-thread-tehlh0`.
**Built by:** the dreaming comparison thread (Opus).
**Read first:** AGENTS.md, PRINCIPLES.md, docs/sleep.md, docs/memory.md
("Every edit is a revision"), docs/contracts.md (Writing memories, Sleep
runs), docs/ux.md (the Sleep page row).

## Goal

Two small additions to sleep that came out of comparing Lyrica's sleep with
other agents' "dreaming" (Anthropic's Managed Agents dreams write to a copy a
person can discard; their dreams take a plain steer such as "focus on
coding-style preferences"). The user asked for both on 2026-11-08.

1. **Undo.** A person can take back the newest night in a pool: what it
   wrote goes, so memory is as it was before that night, and the next sleep
   covers that time again. Principle 6 (trust her judgment; make review
   easy): she keeps writing without asking, and a bad night costs one click
   rather than a page-by-page restore. No model call.
2. **Tonight.** A person can leave one line per pool for her to think about
   in tonight's dream. It steers, it doesn't dictate: the dream stays hers.
   Principle 9 (she grows through her dreams) and principle 6.

## Undo

- **What it takes back:** every revision sleep wrote in the run's window
  (its start to its end) except the renamed-files step's respellings, which
  record real file renames and stay. A memory with no revision left goes
  without a tombstone (a note, page or journal entry the night made, or a
  first WAKE): nothing was forgotten on purpose, and the next sleep may write
  it again. A memory with revisions left gets its newest remaining one back
  as its text, with no new revision, so the History reads as if the night
  never wrote. The notes the night marked replaced (`supersede`, or a note
  saved with `supersedes`) get back what replaced them before, from the run's
  record (pool step 14's `sleep_runs.superseded`). Its items are dismissed.
  A persona proposal stays: it is already a draft the person reviews.
- **Only the newest run** in that pool that wasn't skipped, once it has
  ended, and not while sleep is running for that user. After an undo, the
  run before it becomes the newest and can be undone too.
- **Refused** when a memory the night changed has a newer revision (someone
  edited it since, or a later run respelled it), or something the night
  didn't write cites a note the night made. The refusal names the memory, so
  the person can restore it by hand from its History.
- **The run** becomes skipped with the reason `undone`, so the watermark and
  resuming pass over it as over any skip, and the release before reads it as
  a skip. Its row still opens to anything its renamed-files step respelled.
- A restored page that cites a deleted or replaced note is flagged, so the
  next sleep rewrites it.

## Tonight

- One line per pool (`sleep_focus`, pool step 14), at most 300 characters,
  set or cleared by the person. It lives in that pool's own database, so a
  private line never reaches a general context or a cloud model.
- The dream's instruction carries it, said as the person's ask, with leave to
  follow wherever it leads. Consolidation and wake don't see it.
- A line counts as new activity, so a night with only a line still sleeps.
- It clears once a dream that started after it was set has written its
  journal entry. A line set during a run waits for the next.

## Interface

On the Sleep page, between the items and History: a **Tonight** row per shown
pool (the pool word, a text field, **Save**; a set line shows with **Clear**).
In an open run's detail, the newest run of its pool ends with **Undo this
night…**, a small secondary button; disabled with the reason as its tooltip
when refused; confirmed by a dialog. An undone run reads "Undone".

## Out of scope

Undoing a run that isn't the newest, a pruned superseded note (`pruneSuperseded`
removes only notes replaced two weeks earlier), persona proposals, and her
setting the line herself from a conversation (that would need a tool).

## Handoff

Done: store (`undoSleepRun`, `sleepUndoBlock`, `undoableRun`, `sleepFocus`,
`setSleepFocus`, `clearSleepFocus`), pool step 14, sleep's tools record what
they supersede, the dream's instruction carries the line, lyricad's two routes,
the Sleep page's Tonight forms and Undo this night…, docs, unit tests
(extension and daemon sleep tests) and an e2e test with screenshots in the
project files under `sleep-undo-focus/`.

Next: review fixes. Open question for review: Undo removes the night's
revisions rather than adding a restoring one (principle 5 keeps old text as a
revision); a restoring revision by the person would make sleep treat the whole
page as the person's words, so this was chosen on purpose.
