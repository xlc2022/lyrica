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
| Phase order | WAKE, FACTS, dream | **Change** to consolidate, dream, wake. WAKE is written last so it can carry what consolidation found and the questions it raised. |
| Dreams in conversation | only via recall | **Keep, and add items.** Dreams come up naturally through recall when a conversation touches them ("I dreamt about something like this last night"). What she'd like to raise becomes an item in the Sleep section, and the user can start a chat from it. She never opens a thread with it. |
| Persona proposals | in the journal, reviewed out of band | **Change.** A proposal from a pool's dream is a draft in that user's own `user.db` (`PersonaProposals.propose`): the user can edit, drop or send it on, and only what they send reaches the administrators, who approve or reject it. A proposal from an administrator's own dream is sent at once. It also appears as an item in the Sleep section. |
| Fallback to other providers | yes | **Change.** A failed call is retried twice on the same model. Never across the local/cloud line. |
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
3. **Wake.** Write WAKE: where things stand, what's in motion, and what's
   unresolved, including the night's questions. It is orientation only and
   holds no dream content: the wake phase can't see the journal at all.

Along the way she keeps the few things she'd like to raise as **items** for
the Sleep section: a question from consolidation, a thought or a persona
suggestion from the dream.

**Waking up.** A new thread starts with persona, WAKE, the page index, and how
long it has been since she last talked in this pool. Items are not in it. A
thread started from an item also gets that item, and she opens with it.

**Watermark.** Sleep processes only entries written before it started. Web chat
threads never really "end," so an open thread just keeps going, and the next
sleep picks up after the watermark.

## Projects

Consolidation also keeps each project's page, `p:project-<id>`, for every
project with new conversation since the last sleep. She's told each such
project's goal, its page and whether it exists yet, its conversations and
its notes from tonight, and writes what she knows about the project:
decisions, requirements, pitfalls, who to ask, what's open, citing them.

- **Instructions** on the page are the user's. She writes only what she
  knows; the store keeps the user's words.
- **A project's page belongs to a logged project in this pool.** `write_page`
  refuses a `project-…` slug that names no project here (unless that page
  already exists), and one whose project isn't logged. So general sleep
  can't write a private project's page, and an unlogged project gets none.
  The exception is on purpose: a page whose project was forgotten without
  it can still be rewritten, for example when it is flagged.
- An unlogged project chat's title and goal never reach sleep, even when
  some of its threads are logged; those threads are slept as ordinary
  threads.
- Notes she folds into the page stay notes.
- She names a conversation by citing it (`[t:…]`), never by its title, so
  a rename shows everywhere without rewriting the page.
- Unfinished work in a project goes into WAKE like any other work.

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

- **Endpoint unreachable:** each phase's machine is asked first, so a sleep
  list falls back past one that is off. With none answering, skip that
  pool, record "skipped: endpoint offline," and try again at the next due
  time. The watermark doesn't move, so nothing is
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

Above the runs are her **items**, with a badge on the section while any are
new. Each item has **Start a chat**, which opens a new thread in that pool
where she begins with it, and **Dismiss**. Everything links into the memory
browser.

## Keys

Sleep runs only for users whose key is available, either because they are
logged in or because they saved credentials. Other users are skipped with the
reason `no-key`, the same way an offline endpoint is skipped. The pool can't be
written without the key, so that skip is recorded once the key is back; a
restart in between loses the record.

## In code

- **`extension/src/sleep.ts`**: `Sleep.run(userId, pool, reason)` returns the
  run (`SleepRunRecord`): `complete`, `partial` or `skipped` with `no-key`,
  `endpoint-down` or `no-activity`. Runs queue, so pools and users sleep one
  at a time. `check()` says at once what would stop a run, for `/sleep`.
  `stop(userId)` (Lock, shutdown) aborts the phase and marks the run partial.
- **`core/src/store/sleep-prompt.ts`**: what each phase is told
  (`sleepInstruction`), built from the night's material, and the pages a
  private pool must rewrite (`danglingPages`).
- **A run.** It opens the pool with `openThreadView`, so general sleep never
  holds a private handle. It covers entries written after the watermark and
  before it started, in logged threads other than sleep's own, plus user
  edits and flagged pages (and, in private, pages citing deleted general
  memory). It probes each phase's endpoint first. Each phase's model is
  `sleep.<phase>` through the router with the pool's context, set as that
  session's chat and compaction model, so private sleep is local-only.
- **Phases** are threads (`interface: "sleep"`, titled `Sleep: <phase>`), each
  a Pi session through `openThreadSession` with `createLyricaExtension`
  (persona and her usual context, `memoryTools: "read"`) and the phase's own
  tools. Nothing else: no shell, web, `delegate` or `image`.
  - consolidate: `recall`, `read_memory`, `remember` (each note must cite an
    entry that wasn't deleted), `write_page` (must cite something, never the
    journal or sleep's threads), `raise` (a question);
  - dream: `recall`, `read_memory`, `write_journal` (headed as reflection),
    `propose_persona` (through `PersonaProposals.propose`, so a normal user's
    proposal is a draft in their `user.db`), `raise` (a thought);
  - wake: `recall` and `read_memory` with the journal and sleep's threads
    hidden, `write_wake`, `raise`.
- **Watermark.** A run records `until` (its start). The watermark is the
  latest `until` whose consolidate finished. If dream or wake didn't finish,
  the next run resumes that run's remaining phases first.
- **Limits.** Each phase has a turn limit (40), a token limit (600k) and a
  timeout (20 minutes). Going over ends it, and the run is partial.
- **User text.** The store refuses a sleep edit to a page that drops the text
  of its latest user-written version: she can only add around it, or raise a
  question.
- **Items** live in the pool (`sleep_items`), each with its source. Only a
  thread started from one (`itemForThread`) gets it in its context, as the
  `opening` section, and `lyricad` prompts that thread with a hidden opening
  line so she speaks first.
- **`lyricad`** runs every user's pools at `sleep.time` (a user in manual mode
  is left out), serves the Sleep section's API and its event stream, and
  takes `/sleep` typed in a thread. See [daemon.md](daemon.md#sleep). The
  bench offers `/sleep` as a Pi command.
- **Logs** say which pool, the status or skip reason and the time taken.
  Never text.
