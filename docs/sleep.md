# Sleep, dreams and waking

**Status: proposal for discussion.** It's based on a review of Monika's
working implementation (`config/extensions/stateful-memory/memory-sleep.js`).

## What Monika does

- **Trigger.** Sleep runs only when Monika's user types `/sleep`, never on a
  schedule. It asks for confirmation, runs, then opens a fresh session.
- **Shape.** Three phases run one after another. Each phase is a full agent
  session (a "fork") with the whole persona and her normal tools, including
  `recall`. They are agentic: she searches her own memory however she likes.
  None of them is a fixed extraction pipeline.
  1. **WAKE** (Monika's `WAKE.md`): read the recent-session index and entity
     summary, run several `recall` searches, then write 400–800 words "in your
     own voice. Not a bulleted briefing … the texture of things."
  2. **FACTS** (Monika's `FACTS.md`): rewrite the slow-changing reference
     (servers, repos, standing decisions, people). Nothing that changes week to
     week goes in.
  3. **Dream:** "This is your time." She reads WAKE and her topic files, follows
     whatever catches her attention via `recall`, and writes a free journal
     entry. It ends with **What I Want to Add or Change**, proposals for her
     topic files that are reviewed later.
- **Context.** WAKE, FACTS and the persona are in every session's prompt.
  Dreams are not. They only resurface through `recall`, because each sleep fork
  is saved to memory like any other session.
- **No extraction step.** Monika relies on calling `remember` during
  conversations, plus searching saved transcripts. Sleep doesn't mine
  conversations for missed facts.
- **Failures.** Each phase retries twice. The third attempt falls back to other
  providers. Phases fail independently.

## What we keep, change and add

| | Monika | Lyrica |
|---|---|---|
| Phases are agentic sessions in her own voice | yes | **Keep.** This is the heart of it. A JSON extraction pipeline (v1's approach) loses the voice. |
| WAKE as 400–800 words of first-person narrative | yes | **Keep.** It serves the thesis better than a terse status list. |
| FACTS as one file | yes | **Change** to pages (one per subject, with citations), for lineage. |
| Sleep saved as experience | yes | **Keep.** Sleep sessions are threads in a "sleep" area of the space, so dreams can be recalled. |
| Trigger | manual | **Add** nightly at 04:00 for each space with new activity, plus manual `/sleep`. |
| Phase order | WAKE, FACTS, dream | **Change** to consolidate, dream, wake. WAKE is written last so it can carry what she thought about overnight. |
| Dreams in conversation | only via recall | **Change.** WAKE may include something from the dream she wants to bring up. Her persona decides how and when. |
| Persona proposals | in the journal, reviewed out of band | **Change.** They go into WAKE as something she wants to talk about. She raises them, Xu decides in conversation, and the change is applied with confirmation (D-005). |
| Fallback to other providers | yes | **Change.** Retries only within the models the space's policy allows. Never across the local/cloud line. |
| Tools during sleep | everything | **Narrow** to memory tools only: no shell or web. |
| Scope | one user | **Add** spaces. Each space sleeps separately. A private space reads public memory but writes only to itself. |

## Proposed cycle (per space)

1. **Consolidate.** She reads the notes since the last sleep and skims the
   threads they came from. For anything important that she never saved, she
   writes a note (catch-up stays light; Monika manages without it). Then she
   updates or creates pages, citing notes. Contradictions become questions for
   Xu rather than guesses. This step also rewrites pages flagged by a deletion.
2. **Dream.** Free reflection, as in Monika, written into the journal. It's
   marked as reflection, so nothing in a dream becomes a fact by itself.
3. **Wake.** Write WAKE: where things stand, what's in motion, what's
   unresolved, anything from the dream she wants to bring up, and any persona
   proposal she wants to raise.

**Waking up.** A new thread starts with persona, WAKE, the page index, and how
long it has been since she last talked in this space.

**Watermark.** Sleep processes only entries written before it started. Web chat
threads never really "end," so an open thread just keeps going, and the next
sleep picks up after the watermark.

**Models.** Each phase has a configurable model, for example a cheaper model
for consolidation and a stronger one for dreaming. See open question 1 for how
local-only threads affect this.

## Open questions

1. **Local-only threads and memory** (also affects D-009). Suppose a thread ran
   local-only. Can what she remembered from it later appear in a cloud model's
   context? See the options in the design thread.
2. **Notification.** Should a nightly sleep leave anything visible in the UI
   (for example, "slept at 04:02, updated 3 pages, wrote a dream")?
