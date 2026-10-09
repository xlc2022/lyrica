# Lyrica: design

This is the current, agreed design. [PRINCIPLES.md](PRINCIPLES.md) explains
*why*; this document explains *what*. Component details live in `docs/`.

To change anything here, raise it in the design thread and update this document
in a pull request. Don't reopen a settled point without new evidence. Reversals
of earlier choices are listed under [History](#history) so they aren't relitigated.

## Who Lyrica is for

Lyrica is one continuous companion for Li, running on a server Li administers.
Li talks to her through several **personas**. Each persona is a separate
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
- **Names and pronouns.** Each user has a login name, a display name and
  pronouns. Users can change their display name and pronouns at any time in
  settings, and previous names are kept with dates. The first user is **Li**.
  Memory refers to users by token rather than by name, so a change never
  requires rewriting memories (see
  [docs/memory.md](docs/memory.md#names-and-pronouns)).
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

Lyrica runs on a mix of models: DeepSeek 4.1 Flash, GLM 5.3 Flash, Qwen 3.8
27B and Qwen 3.8 Flash Next.
- **Cloud:** through OpenRouter.
- **Local:** through LM Studio or KoboldCpp. The Qwen models and a local copy
  of DeepSeek run there.

- **Endpoints.** Every endpoint is declared **cloud** or **local** by the user.
  Its API type never decides this.
  - A model is an endpoint plus a model ID. The same model on two endpoints is
    two different entries, one cloud and one local. "DeepSeek" in a private
    thread can only ever mean the local copy.
- **Tasks.** Different tasks use different models: chat, cheap and strong
  subagents, compaction, titles, embeddings, and each sleep phase.
- **Profiles.** A **control panel** sets default models per task, in a **cloud
  profile** and a **local profile**. Each thread can override which model
  handles which task, including the main conversation and its subagents. That
  applies to every thread, with or without folders.
- **Delegation.** When Lyrica delegates, she picks a tier, never a model,
  following a simple rule:
  - **cheap** for searching, reading, summarizing and checking;
  - **strong** for writing, judgment, and changing code or files.

  The thread's `subagent.cheap` and `subagent.strong` models decide which
  model that is.
- **`delegate` is Lyrica's own tool, built on Pi's SDK,** and covers what
  `pi-subagents` offers that makes sense for her. See
  [docs/delegation.md](docs/delegation.md) and History.
  - Roles (scout, researcher, reviewer, worker, oracle) and custom roles.
  - Parallel runs, chains, review loops, councils and saved workflows.
  - Background runs with status, wait, stop and steer.
  - A subagent can ask the parent a question.
  - Parallel writers get separate git worktrees.
  - Limits, cost tracking, and a live view in the web UI.
  - Everything runs inside `lyricad`. A background run interrupted by a
    restart is marked interrupted, never silently lost.
- **Subagents** are ordinary threads.
  - They inherit "Do not log" and their parent's workspace settings, or
    narrower ones.
  - In the UI they appear nested under their parent thread, collapsed behind a
    `>` that expands to show them.
  - In version one, subagents can't start subagents of their own.
- **Local-only.** In a private or local-only thread, any attempt to use a cloud
  model, for any purpose, fails with an error. Nothing ever falls back across
  the local/cloud line.
- **Visibility.** The current model and endpoint, with a clear cloud or local
  badge, are always visible in a thread. Choosing an endpoint, public or
  custom, is easy.
- **Shared endpoints.** An administrator can set up endpoints once for every
  user, such as OpenRouter or the GPU machine. These live in `self.db`. Users
  can also add their own in their `user.db`.
- **Hardware.**
  - Lyrica runs in a VM with an RTX 3090 (24 GB).
  - Most of her models will run on a second machine on the LAN, with two RTX
    6000 Pro Blackwell GPUs.
  - Both count as **local**: the data stays on Li's network.
- **"Local" means on Li's own network:** the LAN, or Li's Tailscale tailnet.
  - A model host, SSH target or allowed host reached over Tailscale
    (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`, or a `*.ts.net` name) counts as
    local, like one on the LAN.
  - Endpoints are still declared local by the user. As a guard against
    mistakes, Lyrica warns when a local endpoint resolves to an address
    outside private, loopback or tailnet ranges.
- **Later: Lyrica manages her own models.** A small **model host** service
  runs on each GPU machine. It wraps vLLM on the Blackwell machine (both GPUs,
  for the large models) and llama.cpp (`llama-server`) on the 3090 VM (small
  fast models: titles, embeddings, cheap subagents).
  - Each model host serves an OpenAI-compatible endpoint plus a small,
    authenticated management API: list, load, unload, status.
  - Lyrica connects to it as a local endpoint she can also start, stop and
    switch models on.
  - LAN only, authenticated with a token.
  - This is a separate thread, after the web UI.

## Storage, encryption and unlocking

- Each user's memory and threads live in encrypted SQLite (SQLCipher): a
  general database, a private database, and a `user.db` for settings.
- A shared `self.db` holds Lyrica's persona, global settings, and the user
  index: logins, administrator flags, profiles, and each user's
  password-wrapped key. Names and pronouns are therefore readable whenever
  `lyricad` is unlocked, even while that user is locked. Their memory is not.
- Each user's data key is wrapped by their password. It becomes available when
  the user logs in, or at startup if they chose **save credentials**, in which
  case it's kept with systemd credentials and sealed to the TPM where one
  exists.
- `lyricad` needs a passphrase to unlock `self.db`.
  - As a service, it starts **locked** and the web UI shows an unlock page.
  - Run by hand with `lyrica serve`, it can prompt in the terminal instead.
  - A "save credentials" option skips both, so it can start unattended.
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
- **Writes:** she saves notes without asking, one fact per note, and is told
  to save liberally. Sleep reports how many notes it had to catch up on, which
  shows whether she's noting too little. Pages change only during sleep. Every
  edit keeps the previous text as a revision.
- **Review and editing:** users can search, edit, restore and delete any of
  their memories (notes, pages, WAKE, journal) in a memory browser in the web
  UI, or with `lyrica mem` at the terminal.
  - Every edit is a revision.
  - Name tokens survive edits.
  - Sleep treats user edits as authoritative and asks rather than overwriting
    them.
- **Users can add their own memories**, notes or pages, in either pool. A
  memory can link to threads, specific messages or other memories, or float
  free. Everything a user adds is in the **User introduced** collection.
  Lyrica treats it as authoritative and never rewrites it.
- **Workspace activity is memory too.** File reads, edits and commands are
  thread entries. Sleep turns them into pages about each project or folder,
  and opening a folder brings back what she knows about it.
- **Do not log thread in memory** is a checkbox on each thread. An unlogged
  thread isn't indexed, slept or noted from, but she can still read her
  existing memory in it. Daughter threads (subagents, forks, exports) inherit
  the setting and can't turn it off.
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
- **Much later:** managing computer systems such as Li's Proxmox deployment,
  once she has proven reliable and sensitive data can be kept on local models.

## Runtime

- The Lyrica Pi extension holds everything that makes her Lyrica: persona,
  context assembly, memory tools and sleep.
- **`lyricad`** is one Node process. It embeds Pi through Pi's SDK: each
  active thread is a Pi session object inside `lyricad`, not a separate `pi`
  process. All interfaces go through it, with the same extension, and it is the
  only process that writes Lyrica's databases.
- **She works like a coding agent.** She has Pi's `read`, `write`, `edit` and
  `bash`, but they never run inside `lyricad`. Details are in
  [docs/workspace.md](docs/workspace.md).
  - Each operation goes either to a bubblewrap sandbox, which sees only the
    folders granted to the thread, or to a named SSH target.
  - An administrator decides which folders each user may grant, with separate
    lists for the general and private pools. The lists live in `self.db`, so
    the user's password isn't needed and users can't extend their own.
  - Shared drives (Samba, NFS) are host mounts, granted like any other folder.
  - Each user has an encrypted home workspace (gocryptfs) for uploads and
    working files, unlocked with that user's key.
  - Every thread has two network switches for its tools: **internet** (on by
    default in general, off in private) and **this machine's services** (off
    by default in both). There are per-user defaults and per-thread
    overrides.
  - Each thread can also have an **allowed hosts** list: IP addresses,
    address ranges (CIDR), hostnames, or URLs, each optionally limited to a
    port. Listed hosts are reachable even with internet off, so a private
    thread can use one service on another machine on your network and
    nothing else. Each user sets a default list per pool, and subagents get
    their parent's list or less.
  - Hostnames are resolved when the sandbox starts and pinned in its
    `/etc/hosts`. With internet off, the sandbox has no DNS at all, so a
    lookup can't be used to smuggle data out.
  - When any of this is on, the sandbox gets its own isolated network
    (`pasta` plus firewall rules inside the sandbox's namespace), never the
    host's.
  - `lyricad`'s own API (on every address) and the host's Unix sockets are
    never reachable, even if listed.
  - A workspace is just a thread with folders granted. It has the same
    settings as any other thread: models for the main conversation and
    subagents, local-only, internet, folders and permission mode.
  - Subagents work in their parent's workspace and can only narrow its
    settings, never widen them.
- **Deployment:** `lyricad` runs as a systemd service, in practice inside an
  LXC container or VM on Li's Proxmox. No Docker. The host needs bubblewrap,
  gocryptfs, pasta, FUSE and unprivileged user namespaces. In an LXC container, that
  means turning on the nesting and FUSE features.
- **One command, `lyrica`**, written in TypeScript like the rest of the
  project:

  | Subcommand | What it does |
  |---|---|
  | `lyrica serve` | Starts `lyricad`. This is what the systemd unit runs. |
  | `lyrica chat` | The terminal interface: a thin client of the running `lyricad` over a local Unix socket. Its threads are stored encrypted like any other interface's. |
  | `lyrica admin …` | Set up, manage users and administrators, change passwords and profiles. |
  | `lyrica mem …` | Search, show, add, edit and delete memories. Edits are typed at the prompt, never through a temporary file. |
  | `lyrica dev` | The developer bench. See below. |

  Passwords and passphrases are only ever typed at a hidden prompt, never
  passed as arguments or environment variables.
- **The developer bench (`lyrica dev`)** runs Pi's own terminal interface with
  the Lyrica extension loaded, for testing persona, prompt assembly and tools
  before `lyricad` exists, and for debugging afterwards.
  - It works only against a separate development runtime with test users,
    never real data, because Pi's terminal interface writes plaintext session
    files.
  - A debug flag prints the assembled prompt for each turn.
  - The same in-process setup, run headless, drives the continuity evals.
- Interfaces between components are in [docs/contracts.md](docs/contracts.md).

## How the project runs

- **Claude does most of the rebuild.** Lyrica edits herself with other models
  only once she is usable again.
- **The design thread** (the "Agent harness design principles" session) owns
  PRINCIPLES, this document and the contracts, and keeps coding to a minimum.
- **Feature threads** are separate Claude Code sessions tagged `project:lyrica`:
  Core, Memory, Workspace, Models, Delegation, Web, Sleep and Integrations.
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
- **No accounts → personas as users (2026-10-09).** Li's personas need
  separate credentials and fully separate data.
- **"Spaces" → users with general and private pools (2026-10-09).** This is
  simpler than per-space flags, and private reading general is safe because
  private runs only on local models.
- **Local-only scope narrowed for general threads (2026-10-09).** In a general
  thread, local-only covers that conversation's own model calls, not its later
  memory.
- **Own `delegate` rather than `pi-subagents` (2026-10-09).**
  - `pi-subagents` 0.76 is about 15,500 lines of source.
  - It writes child transcripts, event logs and run receipts to disk in
    plaintext, and runs background children in a separate process.
  - It resolves models outside our router.
  - Monika needed a 4,800-line patch to fit it to her needs.
  - Our needs (encrypted storage, `lyricad` as the only writer, the
    local-only router, sandboxed tools, nested threads in the web UI) don't
    fit it. A feature-complete version of our own is estimated at 1,500 to
    2,500 lines on Pi's SDK.
  - We borrow its role prompts and feature list, not its runtime.
- **Tool budget raised from 6 to 8, then to 30 (2026-10-09).** First to make
  room for web research, then because Lyrica works like a coding agent (files,
  commands, SSH). The budget still exists so that every tool has to justify
  itself.
