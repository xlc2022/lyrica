# Brief: Changing model settings by asking

**Status:** merged (Part 1 #339, Part 2 #343). **Branch:** `claude/agent-loop-reliability-661bmo`.
**Built by:** the Agent loop thread (Opus).
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Models and endpoints"
(Model settings, saved per copy), docs/briefs/context-stretch.md,
host/API.md (Placement and serving settings), `extension/src/models-tool.ts`,
docs/briefs/live-sync.md.

## Goal

In a general thread the user asked "Set our context to 262144". Lyrica knew
to use `models propose`, but she couldn't find her own model's offering ID,
so she tried bash six times and gave up. The user wants settings like this to
change when asked in plain words, with the scope made clear, and the Models
page showing the new value without a refresh. They also said 32k is too
small as a host's default context. The default should be the largest that
fits, up to what the model supports.

Principles 1 (a failure seen in use) and 3 (Pi's tools and hooks, not more
prompt text).

## Part 1: a host model's default context is the largest that fits

What exists: a host model with no saved `contextLength` is served at 32768
(`DEFAULT_CONTEXT`, host/src/placement.ts `contextOf`), whatever its card
and its GPUs allow.

Change: with no saved `contextLength`, the host serves a text model at the
largest context that fits, capped at its maximum (`maxContextOf`, the trained
length times any stretch).

- "Fits" means that some way the model may run (`options`) passes
  `neverFits` with its GPUs empty, under its other settings (KV cache type,
  placement, vLLM share). Evicting idle models when it loads is the
  scheduler's job, as now.
- The search runs in steps of 1024 tokens, from 4096 up to the maximum. If
  nothing fits, the model stays at 32768 (or its maximum, if lower), so the
  load fails with today's "lower the context length" reason.
- A model whose trained length the host couldn't read, with no stretch, has
  no maximum. It stays at 32768.
- Embedding models keep their 8192 cap, and image and voice models are
  unchanged.
- A saved `contextLength` still wins. The settings the host reports keep
  `contextLength` unset, so the editor shows the automatic value as a
  placeholder. `contextLength` in the model list and serving entry is the
  value in effect.
- Pinned models stay counted, since they are never unloaded; other
  programs' memory stays counted too.
- The value follows the GPUs: it is computed whenever settings are read, so
  changing a GPU's keep-free amount or its allowed servers changes it at the
  next load. A load's VRAM measurement is kept under its automatic context,
  so a new context is measured again.
- The trade: an unconfigured chat model now claims its whole GPU, so two of
  them on one GPU (the thread's model and a fast one) unload each other on
  every switch. A saved, smaller context keeps both loaded.

## Part 2: asking Lyrica to change the context

### 2.1 "Our" model needs no ID

`models` takes `offering` as optional. When it is left out, `lookup` and
`propose` use the model this thread is talking to now (the session's current
model, else the first one the router would pick for chat). The error for an
unknown offering keeps listing the ones she may name.

### 2.2 Scope follows the direction of the change

One loaded copy of a model serves every thread and user. So:

- **Raising** the context above what the copy is served with changes it for
  everyone. It reloads the model, and the card says so: "Serve **X** on **its host** with
  **N** tokens of context for every thread? It reloads…". A shared host or
  endpoint still needs an administrator. This is `propose` as now.
- **Lowering** it, or setting it to what is already served, applies to this
  thread alone: "use at most N tokens here". There's no card and no reload.
  It is saved with the thread's other choices (`thread_choices.context`,
  user.db step 13, expand only), and child threads and branches inherit it
  (`inheritContext`). The thread plans by the smaller of the copy's window
  and this limit, so compaction, the context meter and the reply cap follow
  it, and the session reopens with it at the next turn. Asking for the copy's
  full context (or more) clears the limit. The tool result says which scope
  applied.

### 2.3 Local endpoints that aren't hosts (LM Studio)

`models` reaches LM Studio as well as model hosts. LM Studio's REST API
(`/api/v1/models`, `/api/v1/models/load`, `/api/v1/models/unload`) reads a
model's loaded instances with their context, and loads one with
`context_length`.

- Discovery on a local endpoint that answers `GET /api/v1/models` records a
  loaded model's context as its served context (like a host's), so Lyrica
  plans by what is loaded rather than by `max_context_length`. A model
  that isn't loaded keeps the hand-set or default window, since LM Studio
  loads it on demand at its own default context.
- Raising a model's context through `propose` shows the same card. On Allow,
  lyricad unloads the model's instances, loads it with the new
  `context_length`, and discovers again. LM Studio refuses a load that
  won't fit, and its error comes back to her as the tool result.
- The limit is the model's `max_context_length`. There's no KV estimate, so
  the card leaves out the cache size. LM Studio reloads at once rather than
  when idle, so the card ends "It reloads now, and replies in progress on
  it stop."
- `lookup` (the card on Hugging Face) stays host only.
- The reason for loading rather than hand-setting a context window: a
  hand-set window above what LM Studio loaded would make every long request
  fail.

### 2.4 Guardrails kept

- The confirm card for anything that affects other threads.
- No `models` tool in private, local-only or subagent threads (a lookup is an
  outside call). Its copies come from `hostCopies`, extended to LM Studio
  models on endpoints the user may manage.
- A size over the model's maximum is refused before the card. Whether it
  fits is checked on Allow, by the host's save (`neverFits`) or LM Studio's
  load, and a refusal comes back with its reason and nothing changed.

### 2.5 The Models page updates itself

When the tool applies a change, the thread publishes a `settings` event,
which marks the user's lists changed (live sync, #336). The shell counts
`changed` events in `ShellContext.changed`, and the Models page, the text
library and an open copy's settings reload on it.

## Later (not in this brief)

The same pattern can carry other settings, each as a typed action with a
card where it affects others: sampling, the thread's preset, web search.

## Tests

- host: with no saved context, a model gets the largest that fits on its
  GPU, capped at its trained length; a saved one wins; one that can't fit
  even at 4096 keeps 32768 and the 413 reason.
- extension: `propose` with no offering uses the thread's model; lowering
  sets the thread's limit with no card; raising shows the card.
- core: the thread limit round-trips, is inherited, and caps the window
  the session plans by; user.db migrates from every earlier step to 13.
- LM Studio, against a fake server: discovery reads the loaded context, and
  Allow unloads and loads with `context_length`.

## Docs

host/API.md (`contextLength` default), DESIGN.md (Model settings, the host
section's default), docs/guides/model-hosts.md, docs/models.md and
docs/contracts.md for Part 2, and this brief's handoff.

## Handoff

- **Part 1** (host default context): merged as #339.
- **Part 2:** merged as #343: the tool (extension/src/models-tool.ts),
  `localCopies`, `localContext`, `loadLocalContext` and the discovery
  change (core/src/models), the thread limit (user.db step 13,
  `contextLimit`), the wiring in daemon/src/hosted.ts, and
  `ShellContext.changed`.
- **Checked against a real LM Studio** (2026-10-19, one Qwen model):
  `/api/v1/models` matches the shape the code reads. Unloading, then
  loading with only `context_length` took about a minute and kept every
  other saved load setting (batch sizes, parallel, flash attention, KV
  offload, speculative decoding); loading back at the old context restored
  the config exactly. A chat at the new context answered normally. If a real server answers differently, discovery falls
  back to today's behaviour and the tool says the server isn't LM Studio.
