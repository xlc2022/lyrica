# Sleep, dreams and waking

**Status: agreed.** It's based on a review of Monika's
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
| Sleep saved as experience | yes | **Keep.** Sleep sessions are threads in a "sleep" area of the pool, so dreams can be recalled. |
| Trigger | manual | **Add** nightly at 04:00 for each pool with new activity, plus manual `/sleep`. A setting restores Monika's manual-only behavior. |
| Phase order | WAKE, FACTS, dream | **Change** to consolidate, dream, wake. WAKE is written last so it can carry what she thought about overnight. |
| Dreams in conversation | only via recall | **Change.** WAKE may include something from the dream she wants to bring up. Her persona decides how and when. |
| Persona proposals | in the journal, reviewed out of band | **Change.** They go into WAKE as something she wants to talk about. She raises them, an administrator decides in conversation, and the change is applied with confirmation. |
| Fallback to other providers | yes | **Change.** Retries only within the models the pool allows. Never across the local/cloud line. |
| Tools during sleep | everything | **Narrow** to memory tools only: no shell or web. |
| Scope | one user | **Add** users and pools. Each pool sleeps separately. Private sleep reads general memory but writes only to the private pool. |

## The cycle (per pool)

1. **Consolidate.** She reads the notes since the last sleep and skims the
   threads they came from. For anything important that she never saved, she
   writes a note (catch-up stays light; Monika manages without it). Then she
   updates or creates pages, citing notes. Contradictions become questions for
   the user rather than guesses. This step also rewrites pages flagged by a
   deletion. Notes and pages a user edited or added since the last sleep are
   authoritative: she builds on them, and asks rather than overwriting them.
   She never edits or deletes a memory a user wrote.
2. **Dream.** Free reflection, as in Monika, written into the journal. It's
   marked as reflection, so nothing in a dream becomes a fact by itself.
3. **Wake.** Write WAKE: where things stand, what's in motion, what's
   unresolved, anything from the dream she wants to bring up, and any persona
   proposal she wants to raise.

**Waking up.** A new thread starts with persona, WAKE, the page index, and how
long it has been since she last talked in this pool.

**Watermark.** Sleep processes only entries written before it started. Web chat
threads never really "end," so an open thread just keeps going, and the next
sleep picks up after the watermark.

## Memory pools

Sleep never mixes general and private memory:

- **General sleep** reads and writes only the general database. It may run on a
  cloud model or on a custom endpoint.
- **Private sleep** reads general memory as background and writes only to its
  own private database. It runs only on a custom endpoint.

The control panel sets a sleep model for each pool, and optionally a model per
phase (for example, a cheaper model for consolidation and a stronger one for
dreaming). A private pool's model picker lists only custom-endpoint models.

**Citations across pools.** A private page may cite general notes, but a general
page can never cite private ones. If a general note is deleted, the private
pool's next sleep notices the dangling citation and rewrites the page. General
code therefore never needs to open a private database.

## Modes

| Setting | Behavior |
|---|---|
| `sleep.mode: scheduled` (default) | Nightly at `sleep.time` (04:00) for each pool with new activity. `/sleep` also works. |
| `sleep.mode: manual` | Works like Monika: sleep runs only on `/sleep`, which asks for confirmation, sleeps, then opens a fresh thread. |

## When the endpoint is offline

Before a pool's sleep starts, `lyricad` checks the pool's sleep model with a
cheap request (such as listing models).

- **Endpoint unreachable:** skip that pool, record "skipped: endpoint offline,"
  and try again at the next due time. The watermark doesn't move, so nothing is
  lost. The next sleep simply covers a longer period.
- **Endpoint drops partway through:** phases already finished stay finished,
  and the remaining phases run next time.
- **Manual `/sleep` with the endpoint down:** an immediate, plain error.

Cloud and general sleep never fall back to a different model. Retries stay
within the pool's configured models.

## Sleep in the UI

The web UI has a **Sleep** section in the sidebar. For each run, per pool, it
shows:

- the status (complete, partial, or skipped and why);
- notes she added;
- pages created or changed, with a diff;
- the dream;
- the new WAKE.

Each item links into the memory browser.

## Keys

Sleep runs only for users whose key is available, either because they are
logged in or because they saved credentials. Other users are skipped with the
reason `no-key`, the same way an offline endpoint is skipped.
