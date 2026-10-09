# Lyrica: design

This is the current, agreed design. [PRINCIPLES.md](PRINCIPLES.md) explains
*why*; this document explains *what*. Component details live in `docs/`.

To change anything here, raise it in the design thread and update this document
in a pull request. Don't reopen a settled point without new evidence. Reversals
of earlier choices are listed under [History](#history) so they aren't relitigated.

## Who Lyrica is for

Lyrica is one continuous companion for Xu, running on a server Xu administers.
Xu talks to her through several **personas**. Each persona is a separate
**user** with its own password, its own encrypted databases, its own endpoint
and model settings, and its own memory. To Lyrica, each user is a different
relationship. She is still one individual: her persona is the only thing users
share.

- Users are either **administrators** or **normal users**. Administrators can:
  - change any account's administrator status from the control panel (the last
    administrator can't be demoted);
  - approve changes to Lyrica's persona;
  - edit global settings such as the sleep time and the endpoint list.
- Accounts stay minimal: local users, Argon2id password hashes and a web login
  cookie. No identity providers or roles beyond administrator.
- No memory crosses between users. A one-way "may read" link between users can
  be added later if it's missed.

## Memory pools: general and private

Each user has two pools of memory.

| | General | Private |
|---|---|---|
| Models | Cloud models or a custom endpoint | Custom endpoint only, for every call |
| Reads | General only | Private and general |
| Writes | General | Private |
| Sleep | Its own, on the general sleep model | Its own, on a custom endpoint |

- **Private never reaches a general context or a cloud model.** This is
  enforced structurally, not by instructions to the model:
  - the pools are separate databases;
  - general code never holds a handle to a private database;
  - a private conversation's Pi runtime contains no cloud models at all.
- A **general** thread can also be switched to **local-only**. That keeps the
  conversation's own model calls on the custom endpoint. Its memories still
  belong to the general pool, so general sleep may later process them with a
  cloud model. Anything that must never reach the cloud belongs in the private
  pool.

## Interfaces and threads

- Web chat is the main interface. The CLI, Matrix and a forum come later, in
  that order, each built only once the previous one works well.
- **Each interface keeps its own threads.** Lyrica is continuous across
  interfaces because she remembers, not because threads are mirrored. Moving a
  thread to another interface is an explicit export that copies it. Nothing
  syncs.
- A thread belongs to one user, one pool and one interface, all chosen when it
  is created.
- **Visibility:**
  - Two checkboxes, **Show general** and **Show private**, show or hide all
    content from a pool.
  - Any thread can be hidden, and **Show hidden threads** reveals them.
  - These settings are saved per user. They only affect what's displayed:
    hiding doesn't change what Lyrica remembers.

## Models and endpoints

Lyrica runs on a mix of models such as DeepSeek 4.1 Flash, GLM 5.3 Flash,
Qwen 3.8 27B and Qwen 3.8 Flash Next, reached through public and custom
endpoints.

- Every endpoint is declared **cloud** or **local** by the user. Its API type
  never decides this.
- Different tasks use different models: chat, cheap and strong subagents,
  compaction, titles, embeddings, and each sleep phase.
- A **control panel** sets default models per task, in a **cloud profile** and
  a **local profile**. Each thread can override which model handles which
  task.
- Each user lists the models Lyrica may choose by herself when delegating.
- In a private or local-only thread, any attempt to use a cloud model, for any
  purpose, fails with an error. Nothing ever falls back across the local/cloud
  line.
- The current model and endpoint, with a clear cloud or local badge, are always
  visible in a thread. Choosing an endpoint, public or custom, is easy.

## Storage, encryption and unlocking

- Each user's memory and threads live in encrypted SQLite (SQLCipher): a
  general database, a private database, and a `user.db` for credentials and
  settings. A shared `self.db` holds Lyrica's persona and global settings.
- Each user's data key is wrapped by their password. It becomes available when
  the user logs in, or at startup if they chose **save credentials**, in which
  case it's kept with systemd credentials and sealed to the TPM where one
  exists.
- `lyricad` asks for a passphrase on start to unlock `self.db`. An option saves
  this too, so it can start unattended.
- Memory never goes into a git repository. Backups are encrypted.
- What this protects against: a stolen disk, a leaked backup, or someone
  reading the files while a user is locked.
- What it doesn't protect against: root on the running server while a user is
  unlocked, or anything already sent to a cloud model.

## Memory

Details in [docs/memory.md](docs/memory.md).

- **Layers:** threads → notes (small facts she saves whenever she likes) →
  pages (her understanding of one subject) → WAKE (her orientation) → journal.
- **Lineage:** each layer cites the one below it by ID, inline. "Where did this
  come from" and "what was it consolidated into" are both answered from those
  citations.
- **Writes:** she saves notes without asking. Pages change only during sleep.
  Every edit keeps the previous text as a revision.
- **Review:** users search, review and edit her memory in a memory browser in
  the web UI.
- **Deletion has four levels:** archive, delete a memory, forget a thread, and
  forget a topic. A deleted memory leaves a **tombstone** that holds no text,
  only IDs, so sleep doesn't extract the same fact again from a thread that
  still exists.

## Sleep

Details in [docs/sleep.md](docs/sleep.md).

- **Cycle:** consolidate → dream → wake, adapted from Monika. Each phase is an
  agentic session written in her own voice, with only her memory tools.
- **Schedule:** nightly at 04:00 by default, for each pool with new activity.
  `/sleep` runs it by hand. A **manual** mode works like Monika: sleep happens
  only on `/sleep`, which then opens a fresh thread.
- **Pools:** general and private sleep run separately, each with its own model.
- **Skipping:** sleep skips a user whose key isn't available, or a pool whose
  endpoint is offline, and tries again at the next due time. Nothing is lost.
  The next sleep just covers a longer period.
- **Dreams:** she may bring them up in conversation, as her persona inclines
  her to.
- **UI:** a **Sleep** section in the sidebar shows what she did each night.

## Persona

- The v1 persona in `persona/` is the seed.
- She proposes changes when asked to reflect on how things have been going, and
  in her dream journal. An administrator approves each change, and every change
  keeps a revision.
- Because the persona is shared by all users, a proposal must not carry private
  details from the conversation that prompted it.
- She has a **self-primer** on her own design, architecture and goals. It is
  loaded when the topic comes up, not always. It includes the rule that when
  she edits her own code, she keeps the documentation current and readable.
  She starts fresh, with no v1 memories imported.

## What she does

- **First duties:** maintaining a calendar and sorting data.
- **Integrations:** Google Calendar, iCloud and CalDAV (which covers Nextcloud)
  for calendars; files, notes, downloads and email for sorting. Each sits behind
  a common adapter interface, and they don't all need to be connected at first.
- **Much later:** managing computer systems such as Xu's Proxmox deployment,
  once she has proven reliable and sensitive data can be kept on local models.

## Runtime

- The Lyrica Pi extension holds everything that makes her Lyrica: persona,
  context assembly, memory tools and sleep.
- **`lyricad`** is one Node process. It hosts Pi SDK sessions for web chat and
  later Matrix and the forum, using that same extension.
- The CLI is Pi's terminal UI with the same extension loaded.
- Interfaces between components are in [docs/contracts.md](docs/contracts.md).

## How the project runs

- **Claude does most of the rebuild.** Lyrica edits herself with other models
  only once she is usable again.
- **The design thread** (the "Agent harness design principles" session) owns
  PRINCIPLES, this document and the contracts, and keeps coding to a minimum.
- **Feature threads** are separate Claude Code sessions tagged `project:lyrica`:
  Core, Memory, Models, Web, Sleep and Integrations.
  - Each works from a brief in `docs/briefs/` on its own branch and ends with a
    pull request.
  - No more than two or three are active at once.
  - Sessions hand off through the repo (briefs, docs, PR descriptions), never
    through chat transcripts.
- Contributor rules for everyone, including other models and later Lyrica, are
  in [AGENTS.md](AGENTS.md).

## History

Points where the design reversed an earlier choice. Don't reopen them without
new evidence.

- **Restart (2026-10-09).** v1 had grown to about 41,000 lines for one user:
  12 compose services, 37 slash commands, 14 model tools and 48 SQL tables.
  - Most of it was policy machinery: accounts, session presets, memory tiers,
    forgetting receipts, leases and a delegation ledger.
  - Meanwhile the persona called her a secretary with no calendar or task
    tools, and her `SOUL.md` was 14 lines.
  - The pieces were careful; there was no single thesis to rank them against,
    so each review added guards and nothing was removed.
  - **Kept:** the persona seed, topic routing, and the WAKE/journal shape of
    sleep.
  - **Left behind:** v1's session-policy presets, the General/Sensitive tiers,
    the controller with leases and fences, the delegation ledger, and
    forgetting receipts.
- **Plain files in git → encrypted SQLite (2026-10-09).** Readable markdown in
  a repository wasn't private enough.
- **No accounts → personas as users (2026-10-09).** Xu's personas need
  separate credentials and fully separate data.
- **"Spaces" → users with general and private pools (2026-10-09).** This is
  simpler than per-space flags, and private reading general is safe because
  private runs only on local models.
- **Local-only scope narrowed for general threads (2026-10-09).** In a general
  thread, local-only covers that conversation's own model calls, not its later
  memory.
- **Tool budget raised from 6 to 8 (2026-10-09)** to leave room for web
  research next to memory, delegation and the integrations.
