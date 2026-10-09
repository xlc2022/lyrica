# Lyrica: design

This is the current, agreed design. [PRINCIPLES.md](PRINCIPLES.md) explains
*why*; this document explains *what*. Component details live in `docs/`.

To change anything here, raise it in the design thread and update this document
in a pull request. Don't reopen a settled point without new evidence. Reversals
of earlier choices are listed under [History](#history) so they aren't relitigated.

## Who Lyrica is for

Lyrica is one continuous companion, running on a server Li administers. Each
person who uses her has one or more **users**. Li keeps several for herself
(for example a public-facing one and a private one), and someone else, such as
Li's partner, can have their own. Each user has its own password, its own
encrypted databases, its own endpoint and model settings, and its own memory.
To Lyrica, each user is a different relationship. She is still one
individual: her persona is the only thing users share.

- Users are either **administrators** or **normal users**. Administrators can:
  - change any account's administrator status from the control panel (the last
    administrator can't be demoted);
  - approve changes to Lyrica's persona;
  - edit global settings such as the sleep time and the endpoint list.

  They can't read another user's threads or memory: each user's data is
  encrypted with that user's own key. There is no password reset that keeps
  data, so a forgotten password loses that user's data.
- **One browser, one person.** A browser holds several users at once only if
  they are **linked**: users that belong to the same person, linked by entering
  both passwords. Switching between linked users needs no password. Logging in
  as a user who isn't linked to the ones already there first ends their session
  in that browser. The menu says **Switch user**.
- **Words in the UI.** A person's own linked users are their **personas**
  ("Link separate persona"). Lyrica's own character is always **Lyrica's
  persona**, as in "Changes to Lyrica's persona", so the two are never
  confused.
- **Logging out** keeps the user's key in memory, so sleep can run, unless that
  user turns this off in settings. **Lock** always drops it.
- **Not protected from the operator.** Users are protected from each other in
  Lyrica, not from whoever runs the machines. Root on the running server can
  read an unlocked user's data. Shared endpoints run on accounts and model
  hosts the administrator controls, which may log prompts. A user who needs
  privacy from the operator should use only their own endpoints, or not use
  this server.- Accounts stay minimal: local users, Argon2id password hashes and a web login
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
- **The web UI is React with TypeScript, built with Vite.** Models will write
  and maintain almost all of it, and React is what they know best; `tsc`
  checks its components like the rest of the code.
- **How the web UI looks:**
  - Calm and plain, so the conversation comes first. Colour comes from the
    user's accent, not from decoration.
  - Her messages run full width as prose. The user's sit in a lightly tinted
    block. No chat bubbles.
  - Light or dark follows the device, with an override in settings.
  - Each user chooses an accent colour and a monogram in settings. No
    avatar images.
  - Her inner workings (memories she recalled, notes she saved, tool calls)
    show as one-line markers that expand when tapped. A subagent shows as a
    small card that opens its thread.
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
  - **Every endpoint and every model it offers has a permanent ID.** An
    endpoint's name is a label that can change.
    - Each model an endpoint offers is its own entry with its own ID, so the
      same model on two endpoints is two entries. "DeepSeek" in a private
      thread can only ever mean a local copy.
    - Profiles, thread overrides and recent calls refer to these IDs, so
      renaming an endpoint breaks nothing, and the same model on two
      endpoints can sit in one fallback list.
    - A model an endpoint no longer lists keeps its entry, marked
      **missing**, so a profile never changes silently.
    - The UI recognises the same model on different endpoints and can offer
      it as a fallback.
  - **Model groups.** A user can group entries from different endpoints as
    one model, for example "Qwen 3.8 27B" served by the Blackwell machine,
    the 3090 and a laptop, in their preferred order. A group has its own
    permanent ID.
    - Profiles and overrides can name a group or a single entry. A group in a
      fallback list expands in place into its members, in order.
    - The usual rules filter members: a private or local-only thread skips
      cloud members, and a group that mixes kinds is usable as a whole only
      in the Custom profile.
    - The router skips a member that can't handle the call, such as one
      without tool support when tools are needed, or one whose context
      window is smaller than the conversation, and moves on to the next.
    - Groups live in the model library, not on a page of their own: each
      model's row opens to its copies, and the grouped ones show how they
      differ (quantisation, context window, tools, vision), with warnings.
    - Lyrica suggests groups but never creates them. A strong suggestion is
      the same file on two hosts, matched by checksum; a weak one is a
      matching name. The user confirms.
    - Administrators make shared groups from shared endpoints. Each user can
      make personal groups from their own and shared entries.
    - When an entry is replaced or removed, the change applies inside groups
      too, and a group left empty is flagged in Clean up.
  - **Editing an endpoint never changes its IDs.** A new URL, address or key,
    or re-pairing a host, keeps them all, so moving a server means editing
    its address.
  - **Cleaning up** never deletes silently, because profiles, overrides and
    saved workflows refer to these IDs, including other users' profiles,
    which stay encrypted while those users are locked:
    - An endpoint unreachable for 14 days is marked **stale**, and a model
      missing for 30 days is marked **gone**. Fallbacks skip both.
    - A gone model that nothing refers to is removed after 30 days.
    - Everything else goes through a **Clean up** view. It shows where each
      stale endpoint or gone model is still used, and offers **Replace
      with…** (pre-filled with the same model on another endpoint, where
      there is one) or **Remove**.
  - **Redirects and tombstones.**
    - A replacement leaves a **redirect** from the old ID to the new one,
      and a removal leaves a **tombstone**. They are stored where the
      endpoint lives: `self.db` for shared endpoints, the user's `user.db`
      for personal ones. Routing follows them at once, for every user.
    - Each user's own lists are rewritten the next time they unlock, with a
      one-time notice on their Models page.
    - A redirect or tombstone is deleted once no user's lists still refer to
      it.
  - **History never breaks.** Recent calls and messages keep the model's name
    and endpoint label with its ID, so old entries read correctly after the
    ID is gone.
  - **Reset IDs** gives an endpoint and its models fresh IDs, for a server you
    want treated as new. It leaves redirects from the old IDs, so nothing
    breaks. The same mechanism **merges** two endpoints that turned out to be
    the same server.
- **Tasks.** Different tasks use different models: chat, cheap and strong
  subagents, compaction, titles, embeddings, each sleep phase, and creating
  and editing images.
- **Profiles.** A **control panel** sets default models per task in three
  profiles:
  - **Local:** local models only. Private and local-only threads always use
    it.
  - **Cloud:** cloud models only.
  - **Custom:** local and cloud models mixed freely, for example a local
    model for titles and a cloud one for chat, or a local model with a cloud
    fallback. Only general threads that aren't local-only can use it.

  Each user chooses which profile general threads use by default, Cloud or
  Custom, and a general thread can switch. Each thread can also override
  which model handles which task, including the main conversation and its
  subagents. That applies to every thread, with or without folders.
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
  - Background runs with status, wait and stop.
  - **Conversation both ways.** Lyrica sends a subagent a message at any
    point: it joins the work in progress, answers an open question, or
    continues a finished subagent in its own thread with everything it
    knew, even after a restart. A subagent asks Lyrica a question and waits,
    or sends her a note and keeps working.
  - **The user can talk to a subagent** from its card in Lyrica's chat. The
    message reaches the subagent as the user's, and Lyrica is told in her own
    thread. The subagent keeps the folders, permissions and model its parent
    gave it.
  - **Fork:** a subagent can start from a copy of Lyrica's conversation
    instead of a blank slate (off by default, since it costs more). It stays
    in the same pool under the same rules.
  - **Approvals from subagents.** Where the thread's permission mode asks
    before commands or changes, a subagent's request shows in its own thread
    and in its parent's, and any open view can answer it. Writers run in
    such threads instead of being refused.
  - Parallel writers get separate git worktrees.
  - Limits, cost tracking, and a live view in the web UI.
  - Everything runs inside `lyricad`. A background run interrupted by a
    restart is marked interrupted, never silently lost.
- **Subagents** work like Claude's: Lyrica hands one a bounded task and gets
  its result back. Underneath each is a stored thread, so it is encrypted in
  its parent's pool, inherits "Do not log" and the parent's workspace
  settings (or narrower), and is forgotten with its parent.
  - In the UI a subagent lives inline, as a card in the parent's chat that
    expands to its work and can be messaged. It is not listed in the sidebar.
  - **Child threads** are different: conversations of their own (forks and
    copies of a thread, and threads Lyrica starts), listed collapsibly under
    their parent in the sidebar, which the user opens and talks in like any
    thread.
- **Lyrica chooses between them the way Claude does.** A subagent when she
  needs an answer to carry on and the task is bounded (search, read,
  review, check). A child thread when the work is a stream of its own that
  outlasts the conversation, that the user may want to follow or steer, or
  that needs a long context of its own, such as "I'll keep going on the
  homelab migration in its own thread."
  - A child thread is full Lyrica: her persona, memory tools and the tools
    its settings allow. It inherits the parent's pool, "Do not log",
    local-only, permission mode and workspace settings, or narrower ones.
  - It and its parent message each other: it posts short updates at
    milestones (a badge on it in the sidebar, a card in the parent), and the
    parent or the user can message it at any time. Its approvals appear in
    the child thread, and in Notifications.
  - It keeps going in the background and stays until it is forgotten.
    Forgetting a parent asks whether to forget its child threads too, ticked
    by default.
- **The user can rewind, retry and branch at any turn,** because weak local
  models often need a few tries:
  - **Regenerate** on any of Lyrica's replies removes it and everything after
    it, then asks again. **Regenerate with…** does the same with another model
    the thread may use (local only in a private or local-only thread).
  - **Delete** removes the last turn, as in LM Studio, again and again until
    the one to retry; **Delete from here** removes a message and everything
    after it.
  - **Edit** on one of the user's messages replaces it in place, as in
    ChatGPT: the edited text is sent and what followed is replaced.
  - **Branch from here** makes a child thread holding the conversation up to
    that message, and leaves the original as it was.
  - There are no versions to flip between inside a thread: a thread is one
    line, and branches keep alternatives.
- **What a removed turn takes with it.** Its entries are deleted like
  forgotten ones: notes written in those turns go too, sleep and search never
  see them, and pages that already rest on them are flagged for rewriting.
  Subagents started in them are stopped and forgotten. A short Undo follows,
  then it is final.
- **Pinned messages.** Any message, the user's or Lyrica's, can be pinned.
  - A pinned message is easy to find again: each thread's header lists its
    pins, and the sidebar's search has a Pinned view across threads.
  - It stays in Lyrica's context word for word: compaction keeps pinned
    messages instead of summarising them, in a `pinned` section of the
    prompt within a budget of 2,000 tokens (oldest pins are summarised first
    when over, and the thread's header says so).
  - Sleep treats a pin as a sign the message matters when it consolidates.
  - Pins live with the thread, in its pool. A branch keeps the pins in the
    turns it copies. Removing turns that hold a pin says so in the
    confirmation.
- **Orphans are cleaned up.**
  - Lyrica's own leftovers go automatically: subagent runs and threads,
    images and other outputs in the thread's folder, uploads attached only to
    removed messages, and the thread's scratch files.
  - Files in the user's folders are restored, as Claude Code's rewind does.
    Before her `write` or `edit` tools change a file, Lyrica keeps a snapshot
    of it, encrypted in the user's home. Removing turns deletes files those
    turns created and puts back files they changed, but only files nothing has
    touched since; anything changed later is kept and listed. The
    confirmation lists each, ticked by default.
  - Changes made by shell commands can't be tracked reliably: files touched
    only by commands are listed as not tracked. Git branches left by
    subagents in removed turns are listed, ticked when they have no commits.
  - A nightly sweep removes what slipped through (thread folders of forgotten
    threads, worktrees with no live run) and snapshots older than 30 days.
  - A branch copies the earlier entries the way an export does, keeping
    their original IDs, so memories and citations that point at them still
    resolve, and sleep and recall don't count them twice.
  - It is a child thread like any other: the same pool, "Do not log",
    local-only and settings as its parent, nested under it in the sidebar.
    Subagents aren't branched with it; their results are already in the
    copied turns.
  - In version one, subagents can't start subagents of their own.
- **Local-only.** In a private or local-only thread, any attempt to use a cloud
  model, for any purpose, fails with an error. Nothing ever falls back across
  the local/cloud line.
- **Models page.** One page in the control panel covers everything about
  models:
  - endpoints and model hosts, each with its live status. **Add endpoint**
    takes any OpenAI-compatible URL, with an optional key, declared cloud or
    local, for quick testing or a server started by hand. **Add model host**
    pairs a managed host. A local endpoint over plain HTTP outside this
    machine or the tailnet is marked **unencrypted**;
  - the local, cloud and custom profiles. Each task (chat, subagents,
    titles, embeddings, sleep, images) shows on one line what answers it
    right now, and opens to its ordered list of models. A task can instead
    use another task's list (**Same as**), one level deep: by default titles
    and compaction follow cheap subagents, and sleep follows strong
    subagents. A task with no list of its own follows Chat, as before;
  - two libraries, **Text models** and **Image models**, because the two
    are managed differently. The image library is described under Images.
  - a **Downloads** page in the top bar, with a count while anything is
    downloading. It holds **Download text model**, **Download image model**
    and **Accounts**, downloads in progress with Cancel, and finished
    downloads and deletions until cleared. The libraries themselves stay
    free of downloads;
  - the **text model library** stays usable with hundreds of models (an
    OpenRouter account, a large shared models folder):
    - one row per model, which opens to its copies on every endpoint. That
      is where groups are made, ordered and undone, and where Lyrica's
      suggestions to group copies appear. Each copy shows its **raw name**:
      the file under the models folder, or the endpoint's model ID. Search
      matches raw names too;
    - **what counts as the same model:** copies are the same weights in
      another quantisation or format. A model's identity is its base name,
      size and finetune, read from GGUF metadata (`general.basename`,
      `size_label`, `finetune`, `base_model.*`), from the hub's model card
      (`base_model` with `base_model_relation`, where only `quantized`
      makes a copy), or from the endpoint's model ID. A finetune, merge or
      adapter is a model of its own with a link to its base: never listed
      under it, never suggested for its group. A copy whose file records no
      finetune but whose name has words the model's name doesn't is flagged
      for a check, and **Not this model** moves any copy to a row of its
      own;
    - search, and filters by kind, endpoint and what a model can do (chat
      with tools, vision, embeddings, images), or groups only;
    - **starred** models, which pickers show first;
    - each picker offers only models suited to its task, so the embeddings
      task lists only embedding models;
    - **Download model:** ask a paired host to download one, from Hugging
      Face, ModelScope or a link (see Downloads under the model host);
    - **Delete** a copy Lyrica downloaded herself, after a confirmation that
      says where it's used. Nothing else can be deleted from the library. Lists that named it skip it, and its ID is
      kept as removed so other users' lists are tidied when they next
      unlock;
    - **Accounts:** saved tokens for gated repositories on Hugging Face and
      ModelScope. Like endpoint keys, a user's own token is encrypted in
      their `user.db`, and an administrator can share one for every user in
      `self.db`. A read-only token is enough;
  - each model host's GPUs, roles, pinned and loaded models, VRAM and queue,
    with pause, through the host's dashboard;
  - recent calls: which model answered, and when a fallback was used.

  Each user manages their own endpoints and profiles. Administrators manage
  shared endpoints and model hosts.
- **Fallbacks.** A profile can list several models for a task, in order. If
  the first one's endpoint is down, the next is used, and the thread shows
  which model actually answered.
  - In the Local and Cloud profiles a fallback never crosses the local/cloud
    line.
  - In Custom it may, because the user chose that mix. Each model is marked
    cloud or local, and a call that fell back to cloud says so.
  - Private and local-only threads never see the Custom profile, so this can
    never reach them.
- **Reasoning level.** For models that support it, the message box has a
  thinking control (Off, Low, Medium, High, showing only the levels the
  current model offers), as in Claude and ChatGPT.
  - It is a per-thread setting, with a per-user default, and goes to the
    model through Pi's thinking level (`reasoning_effort` for
    OpenAI-compatible endpoints, the chat template's thinking switch for
    llama.cpp and vLLM models that use one).
  - Offerings carry a `reasoning` capability with their levels, from
    discovery or set by hand in the library.
  - When a fallback model can't think, the thread says so beside the model
    badge rather than failing. Subagent roles keep their own level.
  - Thinking text stays in the thread, encrypted like the rest, shown as a
    collapsed marker. It isn't indexed for recall.
- **Visibility.** The current model and endpoint, with a clear cloud or local
  badge, are always visible in a thread. Choosing an endpoint, public or
  custom, is easy.
- **Shared endpoints.** An administrator can set up endpoints once for every
  user, such as OpenRouter or the GPU machine. These live in `self.db`. Users
  can also add their own in their `user.db`.
- **Hardware.**
  - Lyrica runs in a VM with an RTX 3090 (24 GB).
  - Her larger models run on Li's workstation, on the LAN, with two RTX 6000
    Pro Blackwell GPUs. It is also Li's gaming machine and dual-boots
    Windows, so it is **not always available**. The 3090 VM is the
    always-on base.
  - Both count as **local**: the data stays on Li's network.
- **"Local" means on Li's own network:** the LAN, or Li's Tailscale tailnet.
  - A model host, SSH target or allowed host reached over Tailscale
    (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`, or a `*.ts.net` name) counts as
    local, like one on the LAN.
  - Endpoints are still declared local by the user. As a guard against
    mistakes, Lyrica warns when a local endpoint resolves to an address
    outside private, loopback or tailnet ranges.
- **Later: Lyrica manages her own models.** A small **model host** runs on
  each GPU machine: the 3090 VM and the Blackwell workstation. It serves text
  models through vLLM or llama.cpp (`llama-server`), and images through
  ComfyUI (see [Images](#images)).
  - **Containers.**
    - The model host ships as a Docker Compose file with pinned images, run
      with Docker or Podman on Linux.
    - Containers keep the GPU stacks (CUDA or ROCm, vLLM) pinned and apart
      from the rest of the machine, which matters on a personal workstation.
    - Windows isn't a model host: when the workstation is booted into
      Windows, it is simply away.
    - `lyricad` itself stays a native service (see Deployment).
  - **NVIDIA and AMD**, through a compose profile per vendor (CUDA or ROCm
    images). The machine needs only the GPU driver and the container
    runtime's GPU support.
  - **Our images, pinned by digest.** The host API and ComfyUI images are ours,
    built in CI from pinned versions. vLLM and llama.cpp use their official
    images, also pinned by digest. Nothing is pulled as `latest`.
  - **One way in.** Only the host API container can be reached from outside.
    Lyrica connects to it over mutual TLS with pinned keys (see Pairing), and
    it passes requests on to the model servers (vLLM, llama.cpp, ComfyUI).
    - The model servers sit on an internal Docker network. The host API can
      reach them, but they can't reach the internet or anything else, and
      nothing outside can reach them directly.
    - **Over Tailscale**, the stack runs its own Tailscale container. The model
      host is then a device of its own on the tailnet (for example
      `lyrica-blackwell`), and Tailscale's access rules can allow only
      Lyrica's VM.
    - **On the LAN**, the published port is bound to the machine's LAN
      address, never to every interface, because Docker's published ports
      bypass the machine's firewall. The host API also accepts only the
      addresses of the Lyrica servers it is paired with.
  - **Models folder.** Models live in a folder set on the dashboard. That can
    be a shared folder on another drive that LM Studio also uses, for example.
    - It is mounted read-only into the model servers. Downloads go into a
      `lyrica` subfolder of it.
    - llama.cpp loads GGUF files from it directly, and ComfyUI finds
      checkpoints and LoRAs through its extra model paths.
  - **Downloads,** from Lyrica's model library or the host's dashboard: from
    Hugging Face, ModelScope or an https link. A shared host takes requests
    from administrators only, and a personal host from its owner.
    - A small **fetch** service is the only container with internet access.
      It can write only to the `lyrica` subfolder, and has no GPU and no way
      to the other containers. `host-api` asks it to list a repository's
      files and to download one, so nothing needs the Docker socket.
    - Only GGUF and safetensors files are accepted. Pickle formats (`.bin`,
      `.pt`, `.ckpt`) can run code when they load, so they are refused. A
      model that needs `trust_remote_code` is never run.
    - Each file is checked against the checksum its hub publishes, or one
      given with a link. A link without one is marked **unverified**. A file
      downloads under a temporary name and appears only once it is checked.
    - Links are https only. Fetch checks every address it connects to,
      redirects included, and refuses this machine, the LAN and the tailnet.
    - An access token for a gated repository comes from Lyrica's saved
      tokens (see Accounts) and travels with each request. The host never
      stores it.
    - **Deleting** works only on files fetch downloaded. Fetch keeps a
      record of each download, with its path, size and checksum, and deletes
      only a file in that record that hasn't changed since. A file put in
      the `lyrica` subfolder by hand, and everything elsewhere in the shared
      folder, such as LM Studio's, is never deleted. A loaded model is
      unloaded first.
    - Free space is checked first. A paused host still downloads. A finished
      model gets its offering ID at once, and Lyrica suggests adding it to a
      group of the same model.
  - **No prompt logs.** Docker keeps container output on disk by default, so
    the serving containers log nothing. ComfyUI's folders are in memory
    (`tmpfs`).
  - **No Docker socket.** The host API manages VRAM through each server's own
    API: vLLM's sleep and wake, llama.cpp's model loading, and ComfyUI's
    `/free`. It never touches the Docker socket, which would amount to root.
  - **Dashboard**, served by the host API on port 7236. It shows:
    - GPUs and VRAM, loaded and pinned models, and the queue;
    - usage statistics: requests, tokens, images and time per model. Never
      prompts, results or who asked, and nothing leaves the machine;
    - pause, resume and restart;
    - the models folder, downloads, and each GPU's role and pinned models.

    It can be opened three ways:
    - **At the machine:** `http://127.0.0.1:7236`, with no login.
    - **From elsewhere,** for a headless host: the same dashboard over
      Tailscale or the LAN, behind a password set at first start and
      rate-limited. Over Tailscale it uses HTTPS with a real certificate for
      the host's tailnet name, from Tailscale. On the LAN it uses HTTPS with
      a certificate the host makes.
    - **From Lyrica's control panel,** which reaches it through the paired
      connection.

    It checks the Host and Origin headers, so a web page open in a browser
    can't drive it.
  - **Pairing.** A host's identity is a key it holds, not its address, so
    hosts can move.
    - On first start the host makes a key and certificate, kept in its data
      folder. `lyricad` has its own key in `self.db`.
    - On the Models page, **Add model host** takes a name and one or more
      addresses (a LAN address, a tailnet name). Lyrica tries them in order.
    - The host's dashboard (and its log) shows a one-time **pairing code**,
      about 16 characters long, which expires after 10 minutes. It is pasted
      into Lyrica. Each side proves it knows the code, tied to both
      certificates as it sees them, so a machine in the middle, or someone on
      the LAN without the code, can't pair.
    - Both sides then pin each other's certificate. Every connection is
      mutual TLS with those keys: no tokens. Over Tailscale it also runs
      inside WireGuard, and Tailscale's access rules remain an outer fence.
    - **Addresses** can be edited at any time, and trust stays with the key.
      A host whose key changed must be paired again, and Lyrica says so
      plainly.
    - **Unpairing** works from either side: remove the host in Lyrica, or
      revoke a Lyrica server on the host's dashboard. A host can be paired
      with several Lyrica servers, such as a test instance.
    - Administrators pair **shared** hosts, in `self.db`, for every user. Any
      user can pair a **personal** host, in their `user.db`, that only they
      can use. Hosts are always local endpoints, with the usual warning if an
      address resolves outside Li's network.
  - **Management API.** Each host serves an OpenAI-compatible endpoint plus a
    small, authenticated management API: list, load, unload, status, and
    download models. Lyrica can start, stop and switch models on it.
  - **Placement.** The same host runs on every GPU machine, and an
    administrator decides what runs where.
    - The **3090 VM** is the always-on base. It holds the small text models
      (titles, embeddings, cheap subagents), a capable fallback chat model,
      and a small image model.
    - The **Blackwell workstation** runs the large models and the best image
      models when it is up. Profiles list it first and the 3090 second, so
      Lyrica keeps working when it's off, paused or booted into Windows.
  - **Pause**, for games for example, is on the dashboard and in Lyrica's
    control panel. It finishes the current job, unloads every model, and
    declines new work until it is resumed. Lyrica then uses her fallbacks.
  - **Sleep** runs on the 3090's models when the workstation is away at the
    scheduled time. A pool whose sleep model is set to the workstation only
    waits until it is back, as with any endpoint that's offline.
  - **The host manages each GPU's VRAM.** No program can grab a GPU behind its
    back:
    - Each GPU has a role, set on the dashboard or in Lyrica's control
      panel: a whole GPU for vLLM (which
      reserves a fixed share), or a **shared** GPU for llama.cpp models and
      ComfyUI.
    - On a shared GPU, models can be **pinned** (always loaded, such as the
      embedding and title models). Every other model is loaded on demand.
    - When a model needs room, the host unloads idle models, least recently
      used first. It never unloads a pinned model or one in use, and asks
      ComfyUI to free its memory after it has been idle a while.
    - Requests wait in a queue per GPU. Interactive chat comes first, then
      images, then background work (sleep, cheap subagents). If a request
      can't fit, it fails with a plain reason, such as "the GPU is busy with a
      chat model", rather than running out of memory.
    - Each model's VRAM use is measured on its first load and remembered. The
      control panel shows each GPU's use, what is loaded, and the queue.

## Images

Lyrica can create and edit images, the way ChatGPT does: she writes the image
prompt herself from the conversation, looks at the result, and tries again if
it's off.

- **One `image` tool**, with `create` and `edit`.
  - She picks **fast** or **quality**, never a model.
  - The profiles' `image.create` and `image.edit` tasks decide what those
    mean, so the router's rules apply as for text. Private and local-only
    threads use local image models only.
  - Results go to the thread's folder in the user's encrypted home and show
    inline in the chat. The prompts she wrote are part of the encrypted thread.
- **Local images** run on **ComfyUI**, inside the model host on a GPU machine.
  ComfyUI supports new open models (Krea 2, Z-Image, Qwen-Image, SDXL, and
  editing models such as Qwen-Image-Edit) as they appear. It is contained,
  because as it ships it has no login, runs every plugin with full rights, and
  saves prompts into images and history:
  - it listens only on the GPU machine, runs as its own user, and has no
    internet access;
  - there is no plugin manager, only a few custom nodes pinned to reviewed
    commits;
  - its input, output and temp folders are in RAM, image metadata is off,
    results come back over its websocket, and its history is cleared after
    every job;
  - Lyrica reaches it only through the model host's paired API (mutual
    TLS), which fills workflow templates kept in Lyrica's repository. She can
    never send ComfyUI a workflow of her own.
- **Image models are recipes.** An image model isn't one file: most need a
  diffusion model, one or two text encoders and a VAE, unless a checkpoint
  holds them all. A recipe names each part by its role (and an encoder by its
  slot, such as T5 or CLIP-L), any LoRAs built in with their strength, the
  workflow template for its architecture (one per architecture, not per
  model), and default settings (steps, CFG, sampler, size). Lyrica calls
  recipes, never files, so she never picks parts herself.
  - **Parts are shared.** One T5 encoder or VAE serves several recipes. Each
    part shows its raw file name, size, precision and which recipes use it.
    The host measures VRAM per part.
  - **Identity** follows the text rule. A recipe is its diffusion model plus
    its built-in LoRAs: a lower-precision encoder makes a copy that differs,
    and a built-in LoRA that changes the results (a Lightning LoRA, a style)
    makes a model of its own, linked to its base.
  - **Where recipes come from,** borrowing from Invoke's model manager:
    - **Starter recipes** shipped with the host for each supported
      architecture, with each part's known-good file and checksum. Download
      model fetches only the parts the host doesn't have.
    - **Scan folder:** the host reads each safetensors header (tensor names
      only, never loading the file) to tell a checkpoint, diffusion model,
      text encoder, VAE or LoRA and its architecture. Files are used in
      place, never copied or deleted. Lyrica proposes recipes from matching
      parts, and offers to download missing ones. A proposed recipe does
      nothing until the user confirms it (an administrator on a shared
      host). Proposals wait on a **To review** page of their own, with a
      count on the Image models tab: grouped by host, filtered by ready or
      parts missing, with **Use**, **Download parts** and **Ignore** for one
      or many at once, so a scan that finds dozens of files stays easy. A
      file with no template for its architecture is kept as a file.
    - Hugging Face, ModelScope and links, as for text models.
    - Unlike Invoke, parts are fixed in the recipe rather than chosen for
      each image, because Lyrica, not a person, makes the call.
  - **Editing a recipe.**
    - **Change** on a text encoder or VAE lists every file on that host with
      the same role, slot and architecture, from Lyrica's downloads or the
      shared folder, plus **Download another**. A custom VAE or encoder is
      chosen this way.
    - **Add a part** adds a LoRA with its strength, or a VAE or text encoder
      used instead of a checkpoint's own. A VAE or encoder keeps the model
      the same. A LoRA changes the results, so by default it saves a new
      model linked to the original, which stays as it was.
    - LoRAs and added parts can be removed again.
  - **The image library** lists recipes, and by type (checkpoints, diffusion
    models, text encoders, VAEs, LoRAs, unused files), filtered by
    architecture. Deleting a recipe deletes only the parts Lyrica downloaded
    that no other recipe uses, and says which it keeps and why.
  - Quantized GGUF diffusion models run through one more pinned custom node
    (ComfyUI-GGUF), so smaller GPUs can use them.
- **Upscaling** uses **SeedVR2**, through its pinned ComfyUI node
  (ComfyUI-SeedVR2_VideoUpscaler). It's an image model like the others: a
  recipe of its DiT (3B or 7B, at FP16, FP8 or GGUF) and its VAE, with
  defaults such as the scale and the largest size. The task
  `image.upscale` has its own list in each profile (7B on the Blackwell,
  3B on the 3090), and the `image` tool gains `upscale`. Photos of you
  follow the same rule as for edits. Video is out of scope.
- **Cloud image services** are cloud endpoints like any other: OpenAI's image
  API first, then others (for example Black Forest Labs, Krea, Google, and
  aggregators such as fal or Replicate). They're used only where cloud is
  allowed.
- **Photos of you.** Each user can keep reference photos of themselves in
  their encrypted home, for edits and for putting them in new scenes. Sending
  these photos to a cloud model is the user's choice, with a setting:
  - **Never.**
  - **Ask once a day**, the default. The first time a day that one would go
    to a cloud model, she asks first, the way she asks before a command. A yes
    lasts until the end of that day.
  - **Always.**

  This rule is enforced by the `image` tool, not by instructions to the model.
- **Later:** a personal LoRA, trained on the user's photos on the GPU machine
  for a closer likeness. It would be stored encrypted in their home, and loaded
  into the GPU machine's memory only for a job. Choosing a LoRA for one image
  (a style, a person) comes with it: the `image` tool would offer a short list
  of LoRAs the user enabled, with their trigger words, and each recipe would
  say which LoRA slots it takes. Until then, LoRAs exist only inside
  recipes.
- **Wireframes and diagrams** are drawn as code (HTML, SVG or Mermaid) and
  rendered to an image by a headless browser in her sandbox. Image models are
  poor at exact layouts and text. Storyboards suit the image models, with
  reference images keeping characters consistent.

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
- **About you.** Each pool has one page about its user, `p:about-user`: who
  they are, what they prefer and dislike, and what they care about, citing the
  notes behind it. It is loaded every turn as its own section next to WAKE,
  with its own budget, so a stated dislike isn't forgotten in an unrelated
  conversation.
  - A private thread loads the private page first, then the general one if
    there is room. A general thread loads only the general page.
  - Sleep keeps it up to date. Until Sleep exists, the user can write it in the
    memory browser. User edits are authoritative, as for any memory.
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
- **What she'd like to raise** after a night (a thought from the dream, a
  question from consolidation, a persona suggestion) never opens a
  conversation by itself.
  - Each becomes an item in the **Sleep** section of the sidebar, with a
    badge. **Start a chat** opens a new thread in that pool where she begins
    with it. Items can also be dismissed.
  - WAKE is orientation only: where things stand and what's in motion. It
    holds no dream content, so a new thread doesn't open with her dreams.
  - Dreams still come up naturally. When a conversation touches something she
    dreamt about, recall brings the dream back and she may mention it ("I
    dreamt about something like this last night"). She just never opens a
    new thread with it.
- **UI:** the **Sleep** section in the sidebar shows these items, and what she
  did each night.

## Persona

- The v1 persona in `persona/` is the seed.
- She proposes changes when asked to reflect on how things have been going, and
  in her dream journal. Every change keeps a revision.
- A proposal comes from one user's conversation or dream, so it may carry that
  user's details. That user sees it first, and can edit it, send it on, or drop
  it. Only a proposal they send on reaches the administrators, who approve or
  reject it. A proposal from an administrator's own conversation goes straight
  to review.
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
- **Modes, in the message box,** as in Claude Code: a picker beside the
  message box (Shift+Tab cycles), per thread, with a per-user default.
  - **Ask:** asks before commands and file changes.
  - **Accept edits:** file changes go through; commands ask.
  - **Auto** (the default): works freely inside the thread's grants.
  - **Plan:** she can only read, recall and use read-only subagents. She
    writes a plan and asks to go ahead; approving it switches the thread to
    the mode the user picks, and she carries on.
  - Irreversible actions that leave the server always ask, whatever the
    mode. Subagents and child threads get the parent's mode or a stricter
    one; a Plan-mode parent's subagents are read-only. Enforced in the
    `tool_call` hook and by which tools are active, never by instructions.
- **Switches in the message box,** as in Open WebUI: a "+" beside the
  message box turns tools on or off for this thread, without opening its
  settings: **Web search** (`web_search` and `web_fetch`), **Internet for
  commands** (the sandbox's internet switch) and **Images** (the `image`
  tool). A switch that's off removes the tools from the session, so she
  can't use them; a subagent or child thread can't turn back on what its
  parent turned off. Local-only and the pool are not switches here: they
  stay in the thread's settings, where changing them is deliberate.
- **Deployment:** `lyricad` runs as a systemd service, in practice inside an
  LXC container or VM on Li's Proxmox. No Docker. The host needs bubblewrap,
  gocryptfs, pasta, FUSE and unprivileged user namespaces. In an LXC container, that
  means turning on the nesting and FUSE features. One install script sets up
  the service users, `lyricad`'s unit, and the built-in Caddy.
- **Reaching the web UI:**
  - `lyricad` serves plain HTTP on `127.0.0.1` behind an HTTPS proxy. The
    browser never gets plain HTTP: login cookies are `Secure`.
  - The name is a subdomain of Li's domain (for example
    `lyrica.example.net`), whose DNS record points at a Tailscale address. On
    the LAN, local (split) DNS gives the same name a LAN address, so one
    certificate works for both.
  - Certificates come from a **DNS-01 challenge** through the DNS provider's
    API, because a Tailscale address can't be reached for the usual HTTP
    challenge.
  - An administrator chooses the proxy in the control panel, under **Web
    access**:
    - **Built-in Caddy**, the default. Lyrica's install includes a pinned
      Caddy, built with the DNS plugins for several common providers, running
      as its own service. `lyricad` writes Caddy's whole configuration through
      Caddy's admin API, on a Unix socket only `lyricad` can use. The panel
      sets the name, which addresses to serve on (Tailscale, LAN), the DNS
      provider and its credentials, and shows the certificate's state.
    - **External proxy**: a Caddy, or another proxy, elsewhere on Li's
      network. `lyricad` also listens on one Tailscale or LAN address and
      accepts connections only from the proxy addresses listed in the panel.
      Over Tailscale the hop is plain HTTP inside WireGuard. Over the LAN it is
      HTTPS, with a certificate `lyricad` makes and the panel shows for
      pinning in the proxy. Plain HTTP never crosses the LAN. The panel gives
      a Caddyfile snippet for the proxy.
    - In external mode, `lyricad` keeps the extra listener's settings and its
      TLS key in a file only its service user can read, as Caddy does with
      its own keys. That way the unlock page is reachable while `lyricad` is
      locked. Until unlock, that listener serves only the unlock page.
  - A change never locks the administrator out. The old setup keeps serving
    until the new one has a valid certificate, and it comes back if the new one
    doesn't get one.
  - The DNS credentials are stored encrypted in `self.db`. Caddy keeps its own
    copy with its certificates, readable only by Caddy's service user, so it
    goes on serving, and the unlock page stays reachable, while `lyricad` is
    locked. Use a token limited to the one DNS zone.
  - Sandboxes never reach the front door. On the proxy's ports, they are
    refused this machine's own addresses, the external proxy's addresses, and
    whatever Lyrica's name resolves to when the sandbox starts.
- **Phones:** the web UI works well on a phone from the start.
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
  Core, Memory, Workspace, Models, Delegation, Daemon, Web UI, Sleep,
  Integrations, Model host, Models 2, Images, Delegation 2, Child
  threads and Modes.
  - Each works from a brief in `docs/briefs/` on its own branch and ends with a
    pull request.
  - No more than two or three are active at once.
  - Sessions hand off through the repo (briefs, docs, PR descriptions), never
    through chat transcripts.
- **The cheapest model that does the job well.** Before starting a thread or
  subagent, judge how hard the task is.
  - Work that builds or reviews a boundary (privacy, cloud, sandbox, keys,
    authentication) uses the strongest model.
  - Small, well-specified work uses a cheaper model: copy changes, a UI page
    from a finished mockup, a mechanical refactor, running checks.
  - A cheaper model gets a complete prompt: the files to touch, the exact
    change, how to check it, and what to leave alone.
  - Checks that need no judgement (test runs, screenshots) are done directly,
    without a subagent.
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
- **Personas → users who may be different people (2026-10-09).** Li's
  partner may use Lyrica too. Switching without a password is now limited to
  linked users, persona proposals need the originating user's consent before
  an administrator sees them, and staying unlocked after logout is a per-user
  choice.
- **Model host: native install → containers (2026-10-09).** The Blackwell
  machine is Li's personal workstation. A Compose stack keeps the GPU stacks
  pinned and apart from the rest of the machine, with images per GPU vendor,
  and is easy to add or remove. Windows isn't a model host. `lyricad` stays
  native.
- **Image models: files → recipes (2026-10-09).** Most image models need
  several files that work only together, and many share parts. Lyrica can't
  be asked to choose encoders and VAEs, so the user settles them once in a
  recipe. The image library is separate from the text one.
- **Model downloads: one-off container → fetch service (2026-10-09).** The
  host has no Docker socket, so nothing could start a one-off container.
  Downloads also became open-ended (Hugging Face, ModelScope, links) instead
  of a pinned catalogue, so the checks moved into fetch: file formats,
  checksums and addresses.
- **Tool budget raised from 6 to 8, then to 30 (2026-10-09).** First to make
  room for web research, then because Lyrica works like a coding agent (files,
  commands, SSH). The budget still exists so that every tool has to justify
  itself.
