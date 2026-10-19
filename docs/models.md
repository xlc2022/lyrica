# Models

Every model call goes through one router, which picks the model for each task
from the user's presets and columns and the thread's own choices. Code:
`core/src/models/` (no Pi), `extension/src/models.ts` and `session.ts`.

## Guarantee

A private or local-only thread's Pi session holds only local endpoints, so
nothing in it can call a cloud model: not the conversation, not a child
thread, not Pi's compaction or retries. Anything sent to a cloud endpoint from a
general thread is outside this.

## Endpoints and offerings

An endpoint is a name, a kind (`cloud` or `local`, declared by whoever adds
it, never inferred), an OpenAI-compatible base URL and an optional API key.
A base URL without a scheme gets `http://` (local) or `https://` (cloud),
and one without a path gets `/v1`, so `10.0.0.5:1234` saves as
`http://10.0.0.5:1234/v1`; a given path is kept.

The Hosts and endpoints page distinguishes a plan from a keyed service:
ChatGPT plan or Grok plan versus API key pills. A cloud row also shows Text,
Vision and Image when offered; Image requires an adapter that can call a
marked image model and a key where required. A plan shows its kind and "only
you", plus an explicit account label from sign-in if supplied, instead of
its placeholder URL. A keyed endpoint shows its URL and a masked key suffix
(the last four characters, omitted for keys of four or fewer). No token is
returned. Capability pills wrap under the name on a phone. Model choices
name the endpoint after the model, muted, with the endpoint truncating first.
Add endpoint suggests **ChatGPT** for that plan and **OpenAI** for
api.openai.com; names remain editable. Endpoint names accept letters, digits
and `-`, at most 40 characters.

- **Permanent IDs.** Every endpoint has a UUID, and its name is a label that
  can change. Every model it offers is an **offering** with its own UUID, so
  the same model on two endpoints is two offerings. Presets, columns and thread
  choices name offerings (`ModelRef` is `{ offeringId }`). Renaming an
  endpoint, or changing its URL or key (`editEndpoint`), keeps every ID.
- **Paused.** `editEndpoint { paused }` pauses or resumes a plain endpoint
  or plan (`paused_at` on `endpoints`, added by expand-only self step 3 and
  user step 12 to databases made before it): the router skips it ("is
  paused") until it resumes. A model host pauses itself instead (`hostControl`).
- **Labels.** People and Lyrica name a model as `<endpoint>/<model>`, with
  `shared.` before a shared endpoint's name, so the two never collide. A host
  recipe's `<model>` is its name (`modelName`), never its `recipe/<id>`;
  every picker, list and "Made with" names it the same way.
  `find(userId, idOrLabel)` takes either form, and a recipe by name or ID. A saved workflow's models are
  stored by offering ID (`workflowSpec`), so renaming breaks nothing.
- **Shared** endpoints live in `self.db`. Only an administrator can add,
  change or remove them. Every user can use them. A user's **own**
  endpoints live in their `user.db`.
- `discover` reads `GET /v1/models`. A new model gets an offering; one the
  endpoint stops listing keeps its offering, marked `missing`, and gets it
  back if it returns. Models can be added by hand (`addModel`) and are never
  marked missing.
- **Capabilities:** context window, tools, vision, embedding, image, edit, upscale
  and thinking levels. OpenRouter reports the context, tools, thinking and
  modalities; llama-server reports the context
  (`meta.n_ctx`); LM Studio reports the context and vision on its own API
  (below); KoboldCpp reports neither. Anything can be
  set by hand (`setCapabilities`), which wins over discovery. Switching off
  image, edit, upscale or transcribe takes the model out of that task's lists
  in the user's presets and columns (a group stays), so no list keeps an
  entry the router would skip.
- `probe(userId, endpointId)` is `up` when `/v1/models` answers within 5
  seconds. For a local endpoint it also warns, without blocking, when the
  host resolves outside the owner's own network: loopback, RFC 1918, `fd00::/8`, or
  the Tailscale tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). `*.ts.net`
  names resolve through the host's resolver.
- A local endpoint over plain HTTP whose host isn't loopback or the tailnet
  is marked `unencrypted`.
- `sameModel` finds the same model on other endpoints of the same kind by
  name, ignoring an organisation prefix, a file extension and quantisation
  words (`baseName`), for a suggested fallback or replacement.

## Model hosts

A paired model host (the Model host thread's `host/`) is an endpoint with
`api: "host"`: always local, with an ordered list of addresses and the
host's pinned key fingerprint. Shared hosts live in `self.db` and only an
administrator pairs or manages them; a personal host lives in its user's
`user.db` and no one else sees it. Code: `core/src/models/host.ts`.

- **Lyrica's key.** Each `lyricad` has one ECDSA P-256 key and self-signed
  certificate, made on first use and kept in `self.db` (`host_identity`).
- **Pairing** (`pairHost`) follows `host/PAIRING.md`: the code is normalised
  and checked before anything is sent; on one TLS 1.3 connection that
  presents Lyrica's certificate, the host's fingerprint is read, the proof
  of the code bound to both fingerprints is sent, and the host's proof is
  checked. Only then is its key pinned. A failure gives a plain reason: no
  code, a wrong code, a host that can't prove it knows the code, or no
  address reachable.
  `pairHost(…, { endpointId })` pairs a host again after its key changed,
  keeping every ID.
- **Addresses** (`setHostAddresses`) can change at any time; trust and IDs
  stay. Each request tries them in order. A GET or HEAD is sent once more,
  on a fresh connection, when a kept-alive socket the host already closed
  resets.
- **Calls** go through `fetchFor(endpoint)`: undici, with a connector that
  checks the host's key before handing over the socket, so nothing is sent
  to a host whose key changed. That ends the call at once with "This host's
  identity changed. Pair it again." and never tries the next address. No
  session resumption. `modelRuntimeFor` gives each host's Pi provider this
  fetch, so chat, tools and streaming go through the host's `/v1`. It does
  so by wrapping the runtime's `prepareRequest`, an internal of Pi's
  `ModelRuntime` checked against Pi 1.1.0; re-check it when Pi is upgraded.
  The same wrapper adds each offering's saved settings.
- A host that can't be reached, or doesn't answer within 30 seconds, is a
  plain reason ("blackwell can't be reached."), a 502 through the daemon.
  Pairing waits at most 10 seconds for the host's answer, and checks that
  the name is free before using up the code.
- **Away.** A host that can't be reached, or answers `paused`, `busy`,
  `restarting`, `unavailable` or `unpaired`, is marked down in the health
  cache, so the next model in the list answers. The host's undici dispatcher
  and its connections have an `error` listener, so a reply cut off mid-stream
  fails its call rather than the process. `probe` reads
  `/host/v1/status` and counts only `running` as up.
- **Discovery** reads `/host/v1/models`: context length, tools, vision,
  embeddings, the file's checksum (`digest`, for strong group suggestions)
  and thinking. A chat template with an `enable_thinking` switch has one level, sent as
  `chat_template_kwargs.enable_thinking`; a template that always thinks (it opens
  `<think>` itself, like DeepSeek R1's) gets no switch. A template that writes
  `<think>` itself is reported as `opensThinking`. A host model that reports levels
  gets `reasoning_effort` like any OpenAI-compatible endpoint.
- `hostStatus` returns the host's status (GPUs, placements, loaded and
  pinned models, VRAM, queue) to anyone who can use it; `hostControl`
  pauses, resumes or restarts it and answers the whole status after, since
  the host's own answer is only its state. `hostUpdate` asks a host to
  update to the release Lyrica runs (its `update/…` tag; the daemon passes
  it, and refuses while she runs none); the host's own updater checks it
  again (host/README.md, "Updates"). A host whose updater is at work counts
  as down, and while it restarts the page keeps its last status, so it reads
  Updating rather than Unreachable.
- `pageStatus` is an endpoint's state for the Models page: one seen down in
  the last 30 seconds isn't asked again, and nothing waits more than 3
  seconds, so a host that's off doesn't hold the page — which matters because
  the shell polls `GET …/models/page`, which asks it for every endpoint,
  app-wide on every open tab: on load, every 30 seconds and on focus. A cloud
  endpoint whose provider would take a real probe request is asked at most
  every 90 seconds — its last answer stands in between; local endpoints stay
  at 30 seconds. A host that last answered paused, pausing or restarting
  keeps that status on the page while the router skips it, so the page can
  offer Resume. A host that answered
  `unpaired` (it revoked this server) says `unpaired: true` until it answers
  again or is paired again, so the page can offer Pair again….
- Unpairing is removing the endpoint; the host keeps listing this server
  until it is revoked there.
- Every user who can use a shared host sees its addresses, fingerprint and
  status (including its models folder's path), as they see a plain
  endpoint's URL. That is deliberate: none of it is a secret.

## Cleaning up

- An endpoint whose probes, discovery and calls have all failed for 14 days
  is **stale**: any reply that comes back clears it (`reportUp`, from every
  Pi session); an offering missing for 30 days is **gone**. The router skips
  both.
- `prune` runs nightly. It removes gone offerings no list names: a shared one
  only once every user's lists have been indexed and none names it, a
  user's own while they are unlocked. A shared offering gone for 7 days
  goes even while lists name it, leaving a tombstone; a locked user's lists
  drop it at their next unlock. An administrator's Remove in Clean up does
  the same sooner.
- `cleanup(userId)` lists the stale endpoints, gone models and empty groups
  the user can see, where they are used (the user's presets, columns, threads, saved
  workflows and groups, and shared groups), how many other users' lists name it, and the same model on
  another endpoint, if there is one.
- `replace(actor, from, to)` deletes an offering and leaves a **redirect** to
  another of the same kind (a shared one for a shared one).
  `removeOffering` and `removeEndpoint` leave **tombstones**. A new redirect
  repoints earlier ones at its target, so chains are one hop long. `resetIds`
  gives an endpoint and its offerings fresh IDs, and `merge` folds one
  endpoint into another of the same kind and place; both leave redirects.
- **Shared redirects** live in `self.db` (`offering_redirects`), and the
  router follows them at once. Each user's lists (presets, columns, thread choices,
  saved workflows, groups) are rewritten the next time their `user.db` is opened,
  which is at their next unlock if they are locked now, with a one-time
  notice (`notice`, `dismissNotice`) naming the old label. A list left
  empty is cleared. `redirect_pending` records who hasn't rewritten yet; a
  redirect nobody still needs is deleted.
- A **personal** endpoint's redirects are applied to its owner's lists at
  once, so they aren't stored.
- `shared_refs` in `self.db` records which shared offerings each user's
  lists name (models and groups), for Clean up and pruning. It holds IDs
  only.
- Existing `{ endpoint, model }` choices were migrated to offerings when a
  `user.db` was first opened, in one transaction with its endpoints; references to models that no longer existed
  were dropped and named in the notice.

Redirects and tombstones apply to group members too: shared groups change
at once, a user's own groups when their lists are rewritten. A group left
empty is listed in Clean up.

A forgotten thread's lists, choices and call records go with it (`forgetThread`).

Tables: `endpoints`, `offerings` and `model_groups` (in both `self.db` and
`user.db`); `offering_redirects`, `redirect_pending`, `shared_refs`,
`shared_refs_indexed` and `legacy_refs` (in `self.db`); `model_presets`,
`model_columns`, `thread_models`, `thread_choices`, `local_only_threads`
and `model_calls` (in `user.db`). See `core/src/models/schema.ts`.

## Model groups

A group is offerings from different endpoints that a user declares the same
model, in their preferred order, with a permanent ID. Administrators make
shared groups, in `self.db`, from shared models only; any user can make
their own from their own and shared models.

- A list can name a group (`ModelRef` is `{ offeringId }` or `{ groupId }`).
  It expands in place into its members, in order.
- `groupDetail` shows the members side by side, with warnings where they
  differ: kind, context window, tools, vision, thinking, or a member that is
  missing, gone or on a stale endpoint.
- `groupSuggestions` proposes groups, never makes them: copies of the same
  kind on different endpoints with the same file checksum (strong, once
  hosts report one) or the same base name (weak).

## Presets and lists

The Tasks table has two columns, **Private threads** and **General
threads**, and each column follows a **preset** — a named map of task to an
ordered list of models or groups, or to another task's list
(`{ same: task }`). A preset has a scope:

- **private:** local models only. Offered in both columns, since a
  local-only table is valid anywhere.
- **general:** local and cloud mixed freely; its lists fall back in order
  across the line, each model marked, as Custom did.

Two built-ins come with every user: **Local** (private) and **Cloud**
(general). They can't be renamed or deleted; their lists can be saved over.
A column follows a preset, or is **Custom** with its own table, remembering
which preset it came from (for **Save to**). Private and local-only threads
always resolve from the Private column, which can follow only a private
preset.

A group in a private or general list needs a member of that kind; its other
members are skipped. A general thread's own choice is a preset (or none:
its column) via `setThreadPreset`; a thread's own lists (`setThreadModel`)
beat the preset.

`same` names a task of the same kind (text, embeddings, images, speech) that doesn't
itself follow another, so it is one level deep. A preset's first entry
brings the defaults: titles, compaction and watching follow cheap
subagents, and the sleep phases follow strong subagents. Watching came
later, so a preset stored without an entry for it reads as following
cheap subagents too, unless cheap subagents themselves follow another task. Only a project chat
has a `watching` list of its own, since only it makes looks: setting one on
any other thread is refused. The compaction entry is stored but
unused, since compaction uses the thread's chat model. A task with no list follows chat,
except embeddings, the image tasks and the speech tasks.

Profiles used to be cloud, local and custom. They became the built-in Local
and Cloud presets, with a non-empty custom profile becoming a general
preset named Mixed, on migration.

## Choosing a model

`resolve(task, ctx, need?)` walks the list that decides the task (the
thread's, else the thread's preset's, else its column's, after `same`, else
chat's), expanding groups and following redirects, and returns the first
model that can answer, with the ones it skipped and why. A model is skipped
when:

- it is gone, or its endpoint is stale;
- its endpoint is known to be down: the health cache holds each probe's
  result and each failed connection (`reportDown`) for 30 seconds;
- it can't handle the call: no tools when tools are needed, a context window
  smaller than the conversation, or, for image and speech tasks, not the
  capability the task needs;
- outside a general column, it is of the other kind than the list (local in
  a private or local-only thread, cloud in the Cloud preset, else the
  list's first model's), so nothing falls back across the local/cloud line.

In a private or local-only context, a group's cloud members are skipped and
a cloud model named directly throws `CloudModelForbidden`, wherever it came
from. The settings refuse a cloud model where it can't be used, and a
replacement or merge never changes a model's kind. A private thread is
always local-only.

**Fallback off.** A thread, a project's new threads, the user's default
and sleep each have a Fallback switch, on by default. With it off
(`ctx.fallback === false`), `resolve` takes only the list's first entry: a
group there still tries its copies, since the user declared them the same
model, but nothing after it answers. So a machine that is away makes the
task `Offline` (the turn waits, a call's fallback stops, Pi's retry is
called off), and a model that can't take the call is a `NoModel` ending
"and Fallback is off". `defaultFallback`, `setDefaultFallback`,
`threadFallback` and `setThreadFallback` (null follows the default) keep it
in `user.db` (`settings.fallback`, `thread_choices.fallback`).
`inheritContext` gives a branch or subagent its parent's switch, whatever the
default becomes.

`resolveLive` first probes the chosen endpoint (2 seconds) when its health
isn't known lately and there is a later model to fall back to (or always,
with `probeLast`, as sleep asks).

**Every model away.** When a task's list is set but every model in it was
skipped because its machine is down or stale, `resolve` throws `Offline`
(a `NoModel`, with the task and what was tried); a list where nothing fits
the call is a plain `NoModel`. Before throwing it, `resolveLive` asks those
machines again, in order, so one that has just come back answers at once.
`callWithFallback` runs a call that isn't a Pi turn (a title, a look at a
project's threads (`watching`, "Watching threads", in the project chat's
context), speech and images) on each model in turn: a machine that can't be
reached or is away (`isUnreachable`) is marked down and the next tries (a
host's `model_unavailable` marks only that model down), any
other failure is the call's own, and when none answers it throws `Offline`
with every model tried.
`resolveModel` returns just the chosen `{ offeringId }`.

`callContext(userId, pool, threadId)` reads a thread's local-only switch,
preset, thinking level, Fallback switch and lists from `user.db`.

## Each turn

`openThreadSession` returns `prepare()`, which `lyricad` runs before every
turn (and delegation once for each subagent): it resolves the chat model
(or `code` in code mode and for coder subagents)
with `resolveLive`, switches the session to it, sets the thinking level,
and records the call. A connection error during a turn, including a reply
cut off mid-stream, marks that endpoint down, and when Pi retries, the chat
model is chosen again first (`prepare({ retry: true })`, probing for at most
a second, inside Pi's two-second pause), so the retry goes to the next model
in the list; when none is left, the retry is called off and the turn ends.
A session opens on its chat model even when that machine is down
(`evenIfDown`), since each turn chooses again. The retry rewrites the turn's call record, so a turn is one
call. `resolveLive`'s probe only asks
whether the endpoint answers; the address check never holds up a turn.
Tools are asked of a model only when the thread has tools.

**Recent calls** (`recentCalls`, `model_calls` in `user.db`) hold the time,
thread, task, the answering model's ID with its label, endpoint and kind,
the fallback taken and why, and a note such as a model that couldn't think.
Never prompt text. The latest 500 per user are kept. Before pruning, a
transaction folds counted turns into `call_totals` (pool, thread, label,
kind, tokens, gpu_ms, calls); forgetting a thread removes its totals too.
User schema step 10 adds this table and nullable `model_calls.read_tokens`.
`endpointUses(userId, pools)` counts each endpoint's calls over these rows in
the given pools; the Models page sends them so the sidebar can rank endpoints
without leaning on the recent-calls preview.

`usage(userId, pool, threadIds)` returns shares by thread, model label and
kind, summing retained calls and folded totals. Tokens are `read_tokens +
output_tokens`, falling back to `prompt_tokens + output_tokens` on older
records. Local GPU time is `ttft_ms + gen_ms`, including queueing and loading;
cloud calls and subagents have none. Subagents contribute their recorded
input and output tokens down every depth, using the offering's kind when it
still exists. Every lookup filters both pool and thread.

Totals count her turns, including `code` turns through pruning, and her subagents' work; titles, images, speech and a project chat's looks at its threads carry no counts and aren't included.
Models Overview shows
only the latest visible call under History; Show all beside its eyebrow
opens Call history with server-side search and numbered pages.

Once a turn ends, `recordPace` adds its counts and times to the record
within the hosted thread's pool (`pace`): the last request's prompt tokens (the context used), total reads across
every request including cached reads (`readTokens`), output tokens,
the window, time to first token and generation time, and the prompt tokens
the server actually read rather than took from its cache. From those come
tokens per second and prompt tokens per second (`speeds`; left out when a
time is under 50 ms). `speedsByOffering` gives each copy's median speeds over
the user's last twenty measured calls; the text library shows them on each
copy (`speed`). Counts and times only, so a "Do not log" thread records them
too. Nothing acts on speed.

## Thinking

Offerings carry `reasoning`, the levels they offer besides off: discovered
from OpenRouter's `supported_parameters`, or set by hand. Threads have a
thinking setting (off, low, medium, high, `setThinking`) with a per-user
default (`setDefaultThinking`, off unless set). `thinkingFor` maps it to
what the model offers: the nearest level it has, with a note, or off with a
note when it can't think. A model host's model with one level (a thinking
switch in its chat template) simply runs at it, with no note, whatever level
was asked; on a plain endpoint, a single level is the nearest level, with the
note. Pi passes it as `reasoning_effort` to OpenAI-compatible
endpoints. Subagent roles keep their own level. Thinking text is stored with
the thread but never made searchable.

Pi handles provider `reasoning_content` and `reasoning` fields. Lyrica's
extension wrapper (`extension/src/inline-thinking.ts`) turns inline `<think>`
tags and split tags into thinking blocks. For an `opensThinking` model that
always thinks, or has its switch on, it holds the reply's start until the
first tag, so a reply that opens mid-thought with only `</think>` is
recognised; every other reply streams live. A server's own reasoning stream
releases the hold. These reach the reasoning marker both live and in stored
messages. An ordinary reply that writes a literal `<think>` tag, such as
code about the tags, is parsed too: an accepted trade-off.

The same streams pass two tool guards (`extension/src/tool-stream.ts`):
every tool's parameters go out as `"type": "object"`, which LM Studio
requires, and a reply streaming more than 32 tool calls ends with an error
and none of them run. Each call shows in the views as soon as the model
starts writing it (daemon.md, "The event stream"), so a runaway reply is
seen while it streams.

## Image calls

`image(ctx, request, { signal?, beforeSend? })` creates, edits or upscales through the
thread's `CallContext`, returning `{ images, resolution }`. Each image has
PNG `bytes`, `type`, `width`, `height` and an optional host `seed`. Everything
stays in memory; the caller stores results and records the call without prompts.
`beforeSend(resolution)` runs before each provider attempt, including fallbacks;
a refusal stops the call. The image tool uses it for portrait-photo permission
against the model that would actually receive the bytes.
The tasks `image.create`, `image.edit` and `image.upscale` have their own
ordered lists and require `image`, `edit` and `upscale` capabilities respectively.
Local endpoints resolve by these capabilities; the cloud provider table does
not restrict them.
Private and local-only threads use local lists only; unavailable endpoints
fall back in order, including from a workstation to a smaller GPU host.
For create, resolution takes the first recipe or cloud offering whose
`useFor` matches the requested tier, skipping models tagged only for the
other tier on every attempt. Absent means both. Cloud offerings store
`useFor`, `image` and `edit` in the existing `offerings.hand` JSON, set
through `addModel` or `setCapabilities`; shared offerings live in self.db,
personal ones in user.db. No schema step. Edit and upscale keep their lists.

A create request has `prompt`, `tier` (`fast` or `quality`), optional
`size: { width, height }`, `count` and `references`. Edit takes `prompt`,
`image`, optional `mask`, `references` and `count`; upscale takes `image`,
optional `scale` and `maxSize`. Inputs are `{ bytes, type }` (PNG, JPEG or WebP).

Hosts are called through their paired fetch at `/host/v1/images/<action>`
with the confirmed recipe's ID. Size and count are sent only when supplied;
all other recipe defaults remain the host's, including for both create tiers.
Calls never name parts, LoRAs or workflows. Discovery includes recipes'
upscale capability. A recipe that isn't confirmed and ready cannot run.

`CLOUD_IMAGE_PROVIDERS` selects an adapter by endpoint API. Each entry
declares create, edit, mask, references, sizes, count and tier mappings.

- **OpenAI-compatible with a key:** any offering marked `image` or `edit`,
  without a model-ID restriction. Creation uses `/images/generations`
  (or multipart `/images/edits` with references); editing uses multipart
  `/images/edits`. Fast asks for low quality, quality for high. GPT Image 1
  models use the nearest supported canvas shape; other models receive the
  requested dimensions.
- **ChatGPT plan:** its one image model, **ChatGPT Images**
  (`PLAN_IMAGE_MODEL`, `chatgpt-images`, named by its `recipe` field), which
  discovery adds to the plan's catalogue; its chat models never make
  images, whatever an older switch set (the catalogue drops their `image`,
  `edit`, `upscale` and `useFor`). OpenAI refuses images over the plan's
  "Sign in with ChatGPT" token, so ChatGPT Images runs the user's own
  unmodified Codex (`codex.ts`, the owner's choice; docs/briefs/codex-images.md):
  one `codex exec` per image with `--json --ephemeral --ignore-user-config`,
  approvals off, `image_generation` on and every other Codex tool off
  (`CODEX_DISABLED`: its shell, browser, computer use, apps, plugins,
  memories and goals,
  each passed when the installed Codex's `codex features list` has it, since
  nixpkgs' version isn't pinned; a Codex that can't list them is refused),
  the instructions and prompt on stdin (never argv), an edit's image and any
  references as `--image` files, and the image read from an event's
  `saved_path` or else the newest image under `generated_images/` (0.146.0
  reports none, saving `<session>/exec-<id>.png`); a user's calls run one at
  a time, so that folder is emptied before each call and removed after it.
  Codex is stopped once a saved image stops growing, so one call spends
  at most one image of the user's plan.
  The journal gets one line a call: the exit code (or "stopped after its image"), how many image files
  Codex saved and its event types, never text. The isolation is structural, not the prompt: Codex runs in
  Lyrica's sandbox (`Workspace.codexBox`, `codexSandbox`) holding only its
  home, at `/workspace`, with the internet on and the machine's services
  off, so it never sees another folder, user or the daemon's state. Its own
  sandbox can't start inside Lyrica's, so it runs as
  `--sandbox danger-full-access` there. Codex's home (`CODEX_HOME`, also its
  `HOME`) is `codex/` in the user's encrypted home workspace
  (`Workspace.codexDir`), so its sign-in and every file it writes stay
  encrypted; each call's inputs, saved images and the databases Codex opens
  (`*.sqlite`, which can hold a prompt; only `auth.json` is kept) are
  removed after it, and a
  user's calls run one at a time, since they share one sign-in. Codex
  picks the image model. Size becomes square, portrait or landscape and the
  tier a quality word in the instructions. A failed run is a fixed line:
  signed out (`invalid`, naming Settings → Claude Code and Codex), its usage limit
  (`unavailable`), a refusal (`image_refusal`), else `unavailable`. A run
  that finishes with a reply in words and no image is Codex declining: an
  `image_refusal` that quotes its reply on one line, at most 300
  characters ("Codex made no image (image_refusal). It said: …"), in the
  tool result only, never the journal. One with neither is "Codex returned
  no image." (`unavailable`). Codex's
  sign-in is its own device sign-in (`codexSignIn`, `codex login
  --device-auth`), from the Codex card in Settings → **Claude Code and Codex** (`/api/u/:userId/codex`). The
  daemon installs the runner with `setCodexImages`. `codex` is among the
  sandbox's tools: nixpkgs' `codex` in `nix/sandbox-tools.nix` on NixOS
  (whatever version nixpkgs has), a pinned `@openai/codex` in `/usr/local`
  from `install.sh`. The first time discovery finds ChatGPT
  Images, image task lists in the user's presets and columns that named one
  of the plan's chat models name it instead, and an empty Image edits list
  in a general preset or the general column gets it (private ones never
  do). The Models page and every image call discover a signed-in plan that
  lacks it (`planImages`), which reads no network. Count runs Codex once per
  image (up to four). Maskless edits are supported; masked edits skip it
  before anything is sent and continue down the list.

Grok images are unsupported; upscale remains host-only. Returned PNGs lose
text, EXIF and other metadata. Provider errors use fixed messages and codes,
never provider prose; the one exception is Codex's reply when it declines,
since Codex is the user's own agent and its reason is what they need.
`image_refusal` identifies a content refusal and stops
fallback; outages and limits still try the next eligible model. The tool
keeps fixed `imageRefusal` details (code, offering ID and endpoint ID) for
the message marker. `nextImageModel` reads the current task list without
probing: after the refused endpoint, it skips that endpoint's other models,
unfit or unavailable models, cloud models in restricted threads, and
cloud models when portrait policy is Never. Resend and Try run the same
image executor with a one-call model override, checking consent again;
saved task lists stay unchanged.

The `image` tool reads workspace paths and `/photos-of-me/<file>`, enforces
the user's portrait policy before each resolved attempt, and stores results in
the encrypted thread folder. Its text result says “Made with <model> on
<host or endpoint name>” for every provider, alongside the saved paths.
After a refusal, the tool runs no more image calls for the rest of her turn
(it resets on Pi's `agent_start`), answering each with
`REFUSED_THIS_TURN`, so a model can't reword the prompt and spend more of
a plan on what was just declined; the message's Resend and Try still work.
The daemon's owner-checked file and portrait
management API is documented in [daemon.md](daemon.md#images-and-portrait-photos);
endpoint setup is in [the operator guide](guides/getting-started.md#image-models).

## Speech

Two tasks, **Dictation** (`speech.transcribe`) and **Read aloud**
(`speech.speak`), with lists of their own (they never follow chat). A model
can do them when it has the capability: `transcribe: true`, or `speak:
{ voices: [{ id, language }] }` (a language tag such as `en` or `zh`). A host
reports both in `/host/v1/models` (`kind` `transcribe` or `speak`); for any
other endpoint they are set by hand (`setCapabilities`).

- `transcribe(ctx, wav, { language?, signal? })` sends a 16 kHz mono WAV
  clip (at most 10 minutes) to `/v1/audio/transcriptions` and gives back
  `{ text, resolution, audioSeconds }`.
- `speak(ctx, text, { voice?, speed?, language?, signal? })` asks
  `/v1/audio/speech` for one piece of text with `response_format: "pcm"`
  and gives back `{ audio, resolution, voice }`: a stream of raw PCM,
  s16le mono at 24 kHz (`SPEECH_FORMAT`). Cancelling the stream, or
  `signal`, cancels the request.
- Both are the only way audio reaches a model, through the router: a
  private or local-only context uses local models only, and a host is
  called through `fetchFor`. The caller records the call
  (`recordCall(…, { audioSeconds })`), never with text.
- **A cloud model hears a voice only when the thread picked it.**
  `transcribe` and `speechModel` run Dictation in `voiceContext(ctx)`: the
  thread's own Dictation list when it has one (a branch inherits it),
  otherwise the context made local-only, so the Private column's list
  answers and a cloud model can't. Read aloud sends message text, so it
  follows the router's rules alone. (`thread_choices.voice_cloud`, the old
  switch, is no longer read.)
- **Fallbacks** go through `callWithFallback`. When a call can't be made
  (the endpoint can't be reached or doesn't answer in time, a host answers
  one of its away codes, or another endpoint answers 5xx or 429), the
  endpoint is marked down and the next model in the list answers, within
  one kind. A host's `model_unavailable` (its speech server is off) marks
  only that model, so the host's chat models keep answering. A refusal (4xx) is passed on plainly. When a list is set but
  nothing in it can answer, `Offline`; with no list, `NoModel`. Neither is
  ever a crash. For Read aloud, the fallback covers the call up to its
  first bytes; a model that fails later ends that piece of audio.
- **Voice and speed** are per-copy settings (Sampling): `voices`, a voice
  per language tag, and `speed` (0.25 to 4). Yours for one language leaves
  the shared one for another; `sources.voices` reads `yours` once any
  language is yours. Without a setting, the model's first voice
  for the language is used, else its first voice.
- `speechModel(task, ctx)` says without calling anything whether a task can
  be used: its model's label and kind, or a reason (`none`,
  `down`) and a plain sentence.

Audio is held in memory and passed straight through: no file, no log. Call
records hold the model and `audioSeconds`.

## The libraries

**Text models** (`textLibrary`, `core/src/models/library.ts`): one entry per
model, holding its copies on every endpoint, the groups they're in, and
whether the user starred it (`star`, per user, starred first).

- A copy shows its raw name: the file under a host's models folder, or the
  endpoint's model ID; search matches raw names too. Filters: kind,
  endpoint, capability (tools, vision, embeddings, images), groups only;
  paged.
- **What counts as the same model:** base name, size and finetune, from a
  host's GGUF metadata, the hub's model card, or the model ID. Only a card's
  `quantized` relation joins a copy to its base; a finetune, merge or
  adapter is an entry of its own linked to its base, the model its file's
  `base_model.*` names when it names one. A copy whose file records no
  finetune but whose name has words its model's name doesn't (versions,
  `instruct`, `chat` and the like aside; `base` counts, so a base model
  isn't filed under its instruct model) is kept apart, flagged for a check,
  and never suggested for its base's group. Weak group suggestions match on
  this identity.
- **Not this model** (`notThisModel`) moves a copy to an entry of its own;
  an administrator decides for a shared endpoint, the owner for a personal
  one.

**Image models** (`imageLibrary`, `recipe`): a host's recipes (with
proposals and missing parts) and parts by role, as the host reports them.
Confirm, ignore, download missing parts (with the hub token for the hub
they come from), change (swap a part within its role
and slot, LoRAs, defaults, rename, or `useFor`), copy or delete; the host keeps every part
another recipe uses. **Starter recipes** (`starters`, `installStarter`):
the host's own, from `GET /host/v1/starters`, each part marked `present`;
making one posts `…/starters/<id>/install` with the hub token when a part
is missing, and the host downloads those and confirms the recipe. A shared
host needs an administrator. Only confirmed recipes become offerings (`recipe/<id>`,
with `image` or `edit`), so a proposal never resolves; a recipe deleted here
leaves a tombstone. The tag is `fast`, `quality` or `both`, stored as an
optional field in the host's `recipes.json`; absent reads as both. The daemon
recipe action `{ do: "change", change: { op: "useFor", useFor } }` forwards
it to the host's PATCH, then refreshes discovery. Offerings cache it in their
existing `found` JSON; there is no database migration. Image models exposes
it as **Use for**, saved at once per host, and a fact in the recipe row.
Cloud model rows in Image models expose Generate and Edit checkboxes and
Use for (Fast | Quality | Both); the Cloud group's "Other cloud models" lists
a keyed endpoint's other models with Generate and Edit. They save through `PATCH …/offerings/:id` to hand JSON, and only the endpoint's
owner or a shared endpoint's administrator can change them.

## Downloads, hub tokens and deleting

All through a paired host's management API (host/API.md); a shared host
needs an administrator.

- `hubFiles` lists a repository's files (present, fitting the free space);
  `startDownload`, `downloads` and `cancelDownload` start, follow and
  cancel. A download is checked as the host would before it's sent: a
  source of `huggingface`, `modelscope` or `url`, a repository and files, or
  a link that is https, at most 1024 characters, with no user name or
  password. A download that finished since the last look is read as an
  offering at once, and the group suggestions pick it up.
- **Hub tokens** for Hugging Face and ModelScope: a user's own in `user.db`,
  or one an administrator shares in `self.db` (`hub_tokens`). The API shows
  only the last four characters (`hubTokens`). A token goes to the host in
  `X-Hub-Token` with each request that needs it, the user's own before the
  shared one, and never into a response, a log or a call record.
- `deleteCopy` first says where a copy is used; confirmed, it deletes only
  files in the host's download record (anything else, such as a shared
  models folder, is refused) and leaves a tombstone, so lists skip it. A
  split GGUF is offered as its first shard, and every shard goes; if the
  host refuses one (say, in use), it stops there, the copy still leaves
  every list, and `left` names the files still there with the reason.

## Host management

`manageHost` passes on the host's own management calls (loading,
unloading, pinning and reloading models, GPU settings and placements,
scanning, usage) as the host defines them; other paths are refused, and a
shared host needs an administrator. Serving settings go only through
`setServingSettings`, which reads the model again after saving.

**Serving** (the Serving tab): `servingSettings`, `setServingSettings` and
`reloadModel` read and save one host model's placement and serving settings
and apply them now. The host
refuses a placement that can't work after accounting for other programs
and kept-free VRAM, with its reason. A refused reload keeps the serving
instance; a failed replacement load reverts the saved settings and attempts
to restore the previous instance, reporting the original load error even
if restoration fails. The context a host
serves a model with is the offering's context window, over one set by hand
or discovered; compaction and group fitting plan by it.

**Stretch and recommended settings.** A text model's settings may carry
`stretch` (YaRN: factor and original context), which raises its context
limit to the trained length times the factor; the host passes the flags to
llama.cpp or vLLM (host/API.md). `servingSettings` also returns the maximum
context, the trained length, the host's KV estimate and `recommended`, what
the model's card says. `lookupRecommended(actor, offeringId, repo?)` asks the
host to read the card again through its fetch service, from the repository
the model came from or `repo` (owner/name, modelscope:owner/name or a
link); the user's hub token goes along, marked with the hub it is for. A
stretch above the card's factor is saved only with `{ anyway: true }` (Save
anyway). Lookups and changes need the host's administrator (shared) or
owner.

**Downloading when asked** (extension/src/downloads-tool.ts):
`model_files { host?, source?, repo }` lists what a repository offers as
the host sees it (sizes, present, fits, and which files are a vision
projector or MTP file), and `download_model { host?, source?, repo, files,
companions? }` starts downloads after the permission card asks, whatever
the thread's mode. Named files get every shard of a split GGUF and, with a
GGUF model, its projector and closest MTP file, as the Download text model
page ticks them. With no host named and more than one, the tool answers
that she should ask which. lyricad registers both only when
`downloadHosts` lists a host the user can manage, and never in a private or
local-only thread or a subagent: the repository's name leaves the host.

**The `models` tool** (extension/src/models-tool.ts). `offering` is
optional: left out, it is the model the thread talks to now (the session's
model, else the router's first pick for chat).

- `lookup { offering?, repo? }` returns a host model's recommended settings
  and the KV estimate as numbers.
- `propose { offering?, contextLength, stretch?, originalContext? }` on the
  thread's own model, unstretched, at or under the context it is served
  with, sets the thread's own limit with no card (`setContextLimit`, below),
  or clears it at the full window.
- Otherwise `propose` changes the copy for every thread. It refuses a
  length over the model's maximum, then shows a card ("Serve Qwen3.8-27B
  on Blackwell with 1,010,000 tokens of context for every thread? It
  reloads, and its KV cache grows to 17 GB.", with "Qwen documents 4." when the factor is above
  the card's). An LM Studio model's card says "It reloads now, and replies
  in progress on it stop.", since LM Studio can't wait for it to be idle.
  On Allow it saves a host model's settings and reloads it if
  it is idle, or loads an LM Studio model again with the new context
  (`loadLocalContext`), and clears the thread's limit. The host's fit check
  runs on save, and LM Studio's on load. A refusal comes back as the result,
  with nothing changed.
- lyricad registers the tool only when `hostCopies` or `localCopies` lists a
  model: chat models on hosts, or LM Studio models, on endpoints the user
  can manage (a shared one only as an administrator). A local server that
  isn't LM Studio adds nothing, so the tool's definition costs those
  threads no tokens. It is never in a private or
  local-only thread, since a lookup is an outside call, and never in a
  subagent.
- After a change, the thread reopens with the new window at the end of its
  turn, and a `settings` event tells the user's tabs (live sync), so the
  Models page reads the copy again.

**A thread's context limit.** `setContextLimit(userId, threadId, tokens |
null)` saves the most context a thread plans for (`thread_choices.context`,
user.db step 13). `callContext` returns it as `contextLimit`, and
`inheritContext` gives it to child threads and branches. The thread's model
runtime gives each model the smaller of its window and the limit, so
compaction, the context meter and the reply cap follow it. The window is
read again before every request, so a copy's new window (set by hand, or
served after a load) reaches an open thread at once, even mid-turn.

**LM Studio.** On a local endpoint that isn't a host, discovery also asks
LM Studio's own API (`GET /api/v1/models` beside `/v1`). When it answers, a
loaded model's `context_length` becomes its served context, which wins over
one set by hand. A model that isn't loaded keeps the hand-set or default
window, since LM Studio loads it on demand at its own default context.
Its `capabilities.vision` becomes the model's vision, since `/v1/models`
doesn't say.
`localContext` reads the loaded context and `max_context_length`, the most
`propose` allows. `loadLocalContext(actor, offeringId, tokens)`
unloads the model's instances and loads it with `context_length`. If LM
Studio refuses, it loads the model again as it was and throws LM Studio's
message. It then discovers again. A shared endpoint needs an administrator.

`hostDashboard` (a shared host's only for an administrator) gives a link to the host's dashboard, at the address
it last answered on, and the dashboard keeps its own password away from the
machine.

## Sampling

Each offering can have saved sampling settings (the Sampling tab): temperature, top-p, top-k, min-p,
repeat, presence and frequency penalties, the longest reply, a seed and up
to four stop strings (`core/src/models/settings.ts`). A speech model's
voice per language and speed are kept the same way (see Speech) and are
never sent with a chat request.

- A shared offering's values live in `self.db` and only an administrator
  sets them (`setOfferingSettings(…, "shared")`). A user's own values live in
  their `user.db` (`offering_settings`): for their own offerings, or over a
  shared one's, for them alone.
- `offeringSettings(userId, offeringId)` gives the values that apply to that
  user, each with its source (shared or yours; anything absent is the
  server's default), and the context window with its source (the host's
  serving settings, by hand, or discovered). Compaction and group fitting use that context window.
- Every request to the offering carries the values that are set, added to
  Pi's request payload; unset values are never sent. The repeat penalty is
  `repeat_penalty` for plain local servers (llama.cpp) and
  `repetition_penalty` for model hosts and cloud endpoints.
- Only what the endpoint's API takes is sent: everything for local servers,
  hosts and OpenRouter; OpenAI's set (temperature, top-p, presence and
  frequency penalties, longest reply, seed, stop) for other cloud endpoints.
  `offeringSettings` lists the saved values that aren't sent (`dropped`).
  The longest reply is capped at the smaller of 32,768 tokens and a quarter
  of the context window (`replyCap` in core, the room Pi leaves), and a saved
  maximum above the cap is clamped to it.
- Settings follow redirects: a replacement, merge or Reset IDs moves them to
  the new ID (shared values at once, each user's when their lists are
  rewritten); a removed model's go.
- Values are checked (ranges, whole numbers; no stop strings clears them).
  Settings of offerings that no longer exist are pruned nightly.

## The Pi runtime

`modelRuntimeFor(models, ctx)` builds a Pi `ModelRuntime` with exactly the
endpoints `ctx` may use, each a Pi provider (named by the endpoint's ID) of
API `openai-completions` holding its offerings; a plan is Pi's OpenAI or
xAI provider instead (below).

- Pi's built-in providers are removed. `auth.json`, `models.json` and
  environment keys are never read. API keys are set as runtime keys, so they
  are never read as `$ENV` or `!command`.
- Before returning, it checks every provider against the allowed endpoints,
  and it seals the runtime, so no extension can add one later.
- Local endpoints are sent `system` rather than `developer`, and `max_tokens`
  rather than `max_completion_tokens`. LM Studio, KoboldCpp and llama-server
  don't all accept the newer fields.
- Compaction uses the thread's chat model: Pi summarises with the session's
  own model. A stored preset may still name a `compaction` list; it's
  accepted and unused, and the pickers don't offer it.
- `openThreadSession` sets Pi's compaction per model: a reserve of 8% of the
  window (1,024 to 16,384 tokens, and at least 5,120 on a window of 20,480 or
  more, since pi-ai keeps 4,096 spare when it sizes a reply and a reply must
  get at least 1,024), so Pi compacts on its own once used plus
  reserve reaches the window, and Lyrica's two lines start 17 and 2 points
  before that edge (at most 75% and 90%); and a kept tail of a quarter of the window (at
  most 20,000). A caller's own compaction settings win.

`openThreadSession` hosts one thread with that runtime and its chat model.

## Subscription plans

A user can add a **ChatGPT plan** or a **Grok plan** (SuperGrok or X
Premium) instead of an API key, so general threads answer from their plan's
included usage. Both providers permit it. Claude and Gemini plans aren't
offered: Anthropic and Google don't permit other apps to use their
sign-in, so those stay on API keys (docs/briefs/subscription-logins.md).
Code: `extension/src/plans.ts`, and `addPlan` and its neighbours in
`core/src/models/`.

- **An endpoint of `api: "chatgpt"` or `"grok"`** (`isPlan`): always cloud,
  always the user's own (no shared plans), base URL from `PLAN_URLS`
  (`https://api.openai.com/v1`, `https://api.x.ai/v1`). Its sign-in (Pi's
  credential: `access`, `refresh`, `expires`, and for ChatGPT `clientId`
  and `scopes`) is kept as JSON in the endpoint's `api_key` column in their
  `user.db`, read through `planCredential` for calls and `planAccount` for
  an explicit account label; `Endpoint.apiKey` is never set for a plan, and it has no URL or key to edit. It merges only with a
  plan of the same kind. No schema change: after a rollback, an older release
  sends the stored JSON (refresh token included) as its bearer key to the
  provider that issued it, whose refusal marks the endpoint down.
- **Signing in** (`startPlanSignIn`, `POST …/plans/sign-in`), with Pi's own
  flows and the agent name "Lyrica":
  - **ChatGPT:** Sign in with ChatGPT, with this installation's ID
    (`installationId`, in `self.db`). Pi listens on `127.0.0.1:1455` for
    OpenAI's redirect, which only a browser on the server reaches, so the
    person pastes the address their browser was sent to; Pi checks its
    state and exchanges the code.
  - **Grok:** xAI's device code: the person opens xAI's page, enters the
    code shown if asked, and approves; Finish waits for xAI to confirm.
  A new plan's name is checked (letters, digits and `-`) before the
  sign-in starts, so a bad name never costs a sign-in.
  A sign-in under way is held in `lyricad`'s memory for 10 minutes, one per
  user, and belongs to the user who started it. When it ends (finished,
  cancelled, started again or timed out) the listener on port 1455 is
  closed, since ChatGPT allows one sign-in at a time on a server. Neither the address nor
  any token is logged. A provider's HTTP refusal reaches the interface as
  one fixed line naming the provider and its status (`planError`), never
  the provider's own text, which may echo what it was sent.
- **Calls.** In the runtime a plan is Pi's `openai` or `xai` provider
  (Responses API) under the endpoint's ID, offering only its listed models
  and signing in only with the plan. The runtime's credential store
  (`PlanCredentials`) reads the sign-in from `user.db` and writes Pi's
  refresh back, one refresh at a time per plan across the process. A
  refresh the provider refuses (400 or 401) signs the plan out:
  `signedOut`, which the router skips ("is signed out") until **Sign in
  again**; a refresh that fails any other way changes nothing. Either
  reaches the thread as `planError`'s fixed line.
- **Models** come from Pi's catalogue for that provider (`planCatalog`,
  given to core with `setPlanCatalog`), not `/v1/models`, with their
  context windows, vision and thinking; a ChatGPT plan adds ChatGPT Images.
  A context window set by hand on a plan model replaces the catalogue's
  from its next request (some plans allow more than they list, at a
  higher rate).
- A plan is up while signed in; nothing is probed. When its usage limit is
  reached (`isPlanLimit`), the turn ends with the provider's message and
  the router skips the plan for an hour (`reportPlanLimit`), so the next
  turn falls back to the next model in the list.
- Removing a plan deletes its sign-in; Lyrica stays connected in the
  provider's account settings until it is disconnected there.

## OpenRouter sign-in

Add endpoint's Kind **OpenRouter** gets the user an OpenRouter API key
without copying one by hand. Code: `extension/src/openrouter.ts`. It is
OpenRouter's PKCE flow in its headless mode, so it needs no callback address
and no registration: `startOpenRouterSignIn` makes a verifier and sends its
S256 challenge to `openrouter.ai/auth`; the person approves there and pastes
the one-time code the page shows; `finish` posts the code and verifier to
`https://openrouter.ai/api/v1/auth/keys`, which returns an ordinary key that
belongs to them. The route (`POST …/openrouter/sign-in`, then
`…/:signInId`) stores that key on a plain cloud endpoint at
`https://openrouter.ai/api/v1` (`api: "openai-compatible"`), exactly as if it had been
typed, so nothing else differs from the plain-endpoint flow: no refresh, no
signed-out state, no schema change. A sign-in under way is held in
`lyricad`'s memory for 10 minutes, one per user. OpenRouter's refusal reaches
the interface as one fixed line with its status, never its text. The user caps
what the key can spend on OpenRouter's own site; Lyrica sets no limit.

## Local servers

For native tool calling, start KoboldCpp with `--jinja --jinja_tools` and
llama-server with `--jinja`. Without them, KoboldCpp picks tools in extra
grammar-constrained passes and llama-server falls back to a generic format.
LM Studio uses a model's own tool format when its template has one. None of
the three reports the context window through `/v1/models` except
llama-server, so enter it with `endpoints model … --context`.

## Child threads

`childContext(parent, childThreadId, { tier } | { model })` gives a child
thread, such as a subagent's, its `CallContext`:
- the parent's local-only switch, preset, thinking level and model choices;
- as its chat list, the parent's `subagent.cheap` or `subagent.strong`
  list, or a named model or group the parent's context allows.

`inheritContext(parent, childThreadId)` gives a branch the same, chat list
included: a branch talks with the model its parent does.

A private or local-only parent can only give its child a local model. A
refusal throws before anything is written. `delegate` itself belongs to the
Delegation thread ([delegation.md](delegation.md)).

Finished downloads use the same History preview and Show all page: active
work stays in Queue, while the latest finished entry sits under History.
The history page searches and pages on lyricad, keeping group actions.
Clear finished clears the full history, including entries outside the preview.

## Commands

```sh
lyrica admin models endpoints add <name> cloud|local <base-url> [--shared | --user <login>]
lyrica admin models endpoints list|remove|probe [<name>] [--shared | --user <login>]
lyrica admin models endpoints model <name> <model-id> [--context <tokens>] [--tools] [--shared | --user <login>]
lyrica admin models preset list --user <login>
lyrica admin models preset show <name> --user <login>
lyrica admin models preset use private|general <name> --user <login>
lyrica admin models preset set private|general <task> <endpoint>/<model>[,<endpoint>/<model>…]|same:<task>|none --user <login>
lyrica admin models preset save private|general <name> --user <login>
lyrica admin models preset add private|general <name> --user <login>
lyrica admin models preset rename <name> <new-name> --user <login>
lyrica admin models preset remove <name> --user <login>
```

Endpoints are named by their label (`<name>`, or `<name>` with `--shared`).

API keys are typed at a hidden prompt. `add` and `probe` re-read the
endpoint's model list and print any address warning. `lyrica dev --private` or `--local-only` starts a bench
thread with local-only enforced, and prints the model and endpoint chosen for
each task.
