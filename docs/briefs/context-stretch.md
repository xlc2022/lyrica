# Brief: context stretching (YaRN) and recommended serving settings

**Thread:** Context stretching (proposal, 2026-10-12). **Branch:** the
build's own `feature/context-stretch`. **Model:** Opus for the host and
core; the Serving tab's two new rows belong to the Models page, which Web
UI 2 builds (Fable). **Depends on:** Model host and Models 2 (merged).

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Models and endpoints"
(Model settings, saved per copy; the model host; Downloads), docs/models.md
"Host management", host/API.md "Placement and serving settings",
`host/src/placement.ts`, `host/src/backends.ts`, `host/src/library.ts`,
`host/src/fetch/`, and docs/ux.md §7 before touching the Serving tab.

## Why

Li's ask: Lyrica should stretch a local model's context with RoPE scaling
(YaRN) the way Qwen documents it, so a model such as Qwen3.8-27B runs at a
million tokens, and she should look up each model's recommended settings
on Hugging Face rather than have someone copy them by hand.

Principle 1 (experience before infrastructure): a thread that reads a
whole repository or a day of logs stops hitting the window. Principle 7:
the guarantee stays one sentence, "a model is served with the context its
publisher recommends, and never with one its memory can't hold". Nothing
new is stored outside the host's `state.json` and the library, which it
already keeps.

## What exists

- A host model's serving settings (`ModelSettings`, host/src/placement.ts)
  carry `contextLength`, capped at the trained length
  (`max_position_embeddings`, or the GGUF's `context_length`). The cap is a
  hard refusal: "This model was trained for 262144 tokens of context at
  most." No key for RoPE scaling exists, and an unknown key is refused.
- llama.cpp gets `c = <context>` in its preset (host/src/backends.ts
  `writePreset`); vLLM gets `--max-model-len`. Neither gets YaRN flags.
- The host's fit check (`sizes`) counts KV cache for every layer. Qwen3.5,
  3.6 and 3.8 are hybrids (three Gated DeltaNet layers per attention layer),
  so it overestimates their cache fourfold and would refuse a placement that
  fits.
- The fetch container is the host's one way to the internet. It lists a
  repository (`huggingFace().list`, host/src/fetch/hubs.ts) and downloads
  files into the `lyrica` folder; it reads the card's `base_model` already,
  and accepts `.json` but not `.md`. There is no "read a small file" call.
- lyricad plans by the offering's context window, which the host's served
  context sets (`servedContext`); compaction thresholds, the context meter,
  the reply cap and group fitting all follow it. Nothing in lyricad needs
  to know about stretching.
- No Models page exists in web/src yet; the host's dashboard edits serving
  settings as raw JSON.

## The facts the design rests on (checked 2026-10-12)

Qwen publishes the same recipe on every recent card: native context
262,144; static YaRN with `factor: 4.0` and
`original_max_position_embeddings: 262144` for 1,010,000 tokens; halve the
factor for about 512k; switch it off for short work, since static YaRN
applies to every request and costs a little quality on short texts.

| Model (Hugging Face) | Native | Stretched | llama.cpp (from Qwen's own GGUF card) | vLLM |
|---|---|---|---|---|
| Qwen/Qwen3.8-27B (64 layers, 16 blocks of 3 DeltaNet + 1 attention; also Qwen3.6-27B, Qwen3.5-27B) | 262,144 | 1,010,000 | `-c 1010000 --rope-scaling yarn --rope-scale 4 --yarn-orig-ctx 262144` | `--hf-overrides` adding `rope_type: yarn, factor: 4.0, original_max_position_embeddings: 262144` to `rope_parameters`, `--max-model-len 1010000`, `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1` |
| Qwen/Qwen3-Next-80B-A3B, Qwen3-30B-A3B-2507, Qwen3-235B-A22B-2507 | 262,144 | 1,010,000 | same | `--rope-scaling '{"rope_type":"yarn","factor":4.0,"original_max_position_embeddings":262144}'` (older transformers key) |
| Qwen/Qwen3-32B, Qwen3-8B (dense, 2504) | 32,768 | 131,072 | `-c 131072 --rope-scaling yarn --rope-scale 4 --yarn-orig-ctx 32768` | factor 4.0, original 32768, `--max-model-len 131072` |

Memory is what decides whether a million tokens is real. A dense Qwen3-32B
holds about 256 KB of KV per token at f16, so a million tokens would need
roughly 250 GB; it is a 131k model in practice. The hybrids keep KV only
in their 16 attention layers: with two KV heads of 256, Qwen3.8-27B needs
about 32 GB at f16 or 17 GB at q8_0 for a million tokens, on top of its
weights. That fits the Blackwell workstation and not the 3090. These are
estimates from the published layer counts; the host computes the real
figure from `config.json` and refuses what doesn't fit, as today.

Known gap: vLLM 0.30 misreads `original_max_position_embeddings` on the
Qwen3.5-style M-RoPE path (vllm-project/vllm#58870). The build pins a vLLM
image where that is fixed, or the host shows the stretched vLLM copy as
untested until it is.

## Decisions (Li, pending)

1. **Stretch is a per-copy Serving setting, not a second model.** One
   `stretch` setting beside `contextLength`, applied at the next load. A
   stretched copy answers short prompts with the same YaRN, as Qwen warns;
   an administrator who wants both keeps the factor at 1 by default and
   raises it for the long work, or (later, llama.cpp only) adds a stretched
   twin as a second preset of the same file. vLLM can't afford a twin: it
   is a second server with its own weights.
2. **Recommended settings come from the model's hub card, through the
   fetch container.** Hugging Face and ModelScope, which fetch already
   speaks to: the two places publishers put the recipe. A general web
   search is not part of this; it waits on the search decision (SearXNG)
   in docs/briefs/design.md's open questions.
3. **Lyrica looks up and proposes; a person applies.** In a general thread
   she can run the lookup and propose a serving change, which an
   administrator (shared host) or the owner (personal host) approves on a
   card, like `add_repository`. A lookup is an outside call, so a private
   or local-only thread has no `models` tool at all: structural, not a
   rule she is told. The lookup carries the repository name and revision,
   never thread text, and the gated-repository token travels as it does
   for downloads.

## In scope

1. **`stretch` in `ModelSettings`** (host/src/placement.ts):
   `{ type: "yarn"; factor: number; originalContext: number }`, factor 1 to
   8 in steps the servers accept (whole numbers for llama.cpp's
   `rope-scale`; vLLM takes any), `originalContext` defaulting to the
   trained length. `contextOf` caps at `trained × factor` instead of
   `trained`; the refusal sentence becomes "This model was trained for
   262144 tokens; with a stretch of 4 it serves 1048576 at most." A
   `stretch` on an embedding, transcribe or speech model is refused, and so
   is one on a model whose trained length the host couldn't read (a GGUF
   without `context_length`): there is nothing to stretch from. A factor
   above the card's recommended one is saved only through **Save anyway**
   on the tab, or an approval card that names it ("Qwen documents 4."),
   since the publisher never tested it.
2. **The servers get the flags.** llama.cpp's preset:
   `rope-scaling = yarn`, `rope-scale = <factor>`,
   `yarn-orig-ctx = <originalContext>`. vLLM's `vllm.json` gets
   `ropeOverride`, which supervisor.py turns into `--hf-overrides` with the
   model's own `rope_parameters` (or `rope_scaling` when the config has
   that key) merged with the YaRN fields, and sets
   `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1` for that process only. Nothing else in
   the override changes, so `rope_theta`, `mrope_section` and
   `partial_rotary_factor` stay the publisher's.
3. **The fit check counts attention layers only.** `kvElements` takes the
   number of layers that hold a KV cache: `layer_types` counted for
   `full_attention` when config.json has it, else `num_hidden_layers`; for
   GGUF, the architecture's layer count less its linear-attention layers
   when the metadata names them, else all. The dashboard and the Serving
   tab show the KV estimate at the chosen context, as the host measures
   today.
4. **`recommended` on a library model.** The host keeps, per model, what
   its card says: `{ native, stretched, factor, originalContext, source:
   { hub, repo, revision, at } }`. It is filled:
   - at download time, from the repository's `config.json` and `README.md`
     (free: the files are listed already);
   - on **Look up**, for a model found in the folder: from the repository
     the GGUF names in `general.base_model.*.repo_url` or
     `general.source.huggingface.repository`, else one the person types;
   - following `base_model` one hop, so a quantization's card yields its
     base model's recipe when its own says nothing.
   Parsing: `max_position_embeddings` for the native length;
   `rope_parameters` or `rope_scaling` in config.json when the publisher
   ships YaRN on; in the card, the first JSON block whose `rope_type` or
   `type` is `yarn`, and the first `-c N … --yarn-orig-ctx M` line, taken
   as `stretched = N`, `factor = N / M` rounded to the server's step. A
   card with no recipe leaves `recommended` at the native length only.
5. **Fetch reads a file without saving it.** `POST /read` on the fetch
   service: a repository, revision and one of `config.json`,
   `generation_config.json`, `README.md`, at most 1 MB, returned as text,
   never written to disk; the same guard, redirect limit and token rule as
   downloads; `.md` is readable this way and still not downloadable.
6. **Core and the daemon pass it through.** `servingSettings` returns
   `recommended` with the settings; `GET /host/v1/models/settings` carries
   it; `lookupRecommended(offeringId, repo?)` triggers a Look up
   (administrator for a shared host, owner for a personal one) through the
   host's management API and `manageHost`'s allowed paths.
7. **One model-facing tool, `models`** (principle 8's budget is thirty;
   with `models` she has about 25, counting Pi's four, the memory three,
   `delegate` and `ask_parent`, `threads`, `react`, `image`, the sleep
   five, `propose_plan`, `proxmox`, `add_repository` and the planned
   calendar and sort; the build adds `proxmox`, `add_repository` and
   `models` to docs/contracts.md's Tools list, which misses the first two
   today):
   `lookup { offering, repo? }` returns the recommended settings and the
   host's fit estimate as numbers; `propose { offering, stretch,
   contextLength }` posts an approval card in the thread ("Serve Qwen3.8-27B
   with 1,010,000 tokens of context? It reloads, and its KV cache grows to
   17 GB.", Allow primary), which applies through `setServingSettings` and
   `reloadModel` when the host is idle. Absent in private and local-only
   threads, and for users who aren't the copy's administrator or owner;
   its result in her turn is numbers and the card, never the card's prose.
8. **The Serving tab** (Web UI 2 builds it with the Models page; docs/ux.md
   rules): two rows after Context length, **Stretch** (a number field with
   its maximum, "of 8", unit ×) and **Original context** (tokens, placeholder
   the trained length); Context length's maximum becomes the stretched one
   ("of 1,048,576"). A recommended value shows as the field's placeholder
   with the one small word **recommended** after its label, and a **Look up**
   link in the section's eyebrow line fills them (a popover with one field,
   Repository, when the host has none to go on). One **Reset** per section
   as the rules say; Save, or Save and reload, at the foot. The tooltip on
   Stretch: "YaRN. Applies to every request; Qwen suggests it only when
   long contexts are needed." The Models area mockup gets the two rows (UI
   review).
9. **Docs**, in the same PR: docs/models.md "Host management", host/API.md,
   docs/contracts.md (`ModelSettings`, `servingSettings`, the `models`
   tool), docs/ux.md
   §4 names (Stretch, Original context, Look up, recommended) and §6 (Serving
   tab rows), and the tests: `validate` accepts and caps `stretch`, presets
   and `argv()` carry the flags, a hybrid config.json counts 16 layers, the
   card parser against three fixture cards written for the test (not copied
   from real data: fixtures that quote the recipe's shape), `/read` refuses
   a 2 MB file and a `.py`.

DESIGN.md's Serving bullet (the `stretch` setting, the recommended
settings and the `models` tool) and the contracts entries are the design
thread's: this proposal thread opens their docs PR, as #143 did, and the
build starts after it is approved.

## Out of scope

- Dynamic YaRN or any scaling the servers don't take on the command line.
- A stretched twin of a model (noted above as a later llama.cpp-only step).
- Searching the web for settings; Hugging Face and ModelScope cards only.
- Stretching cloud or plain OpenAI-compatible endpoints: their window is
  theirs.
- Changing how lyricad plans context: it already follows the served window.

## Overlaps

- **Models 2** owns tasks and the router: untouched. The `models` tool reads
  the library and writes serving settings only.
- **Web UI 2** owns the Models page: the two rows and Look up land in its
  Serving tab when that page is built; the back end doesn't wait for it.
- **Feature comparison / Watching threads** adds a model task: no overlap.

## Checks

`npm run typecheck`, `npm test` (host tests included), `npm run evals`.
On the real host: Qwen3.8-27B GGUF at a stretch of 4 answers a 600k-token
prompt on the workstation, and the 3090 refuses it with the memory reason.
