# Brief: Models

**Status:** Merged as #11 (f6dfe7c). Profiles became presets in #283.

**Thread:** Models. **Branch:** `feature/models`. **Depends on:** Core and
Memory (merged).
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md ("Models and endpoints"),
docs/contracts.md (`core/models`, `delegate`).

## Goal

Every model call Lyrica makes goes through one router. It picks the model for
each task from the user's profiles and the thread's overrides. It makes
"private or local-only means no cloud model, for any purpose" structural.

The cloud boundary is the main failure to test against.

## In scope

1. **Endpoints.** Shared endpoints live in `self.db`, administrator only (for
   example OpenRouter and the GPU machine, set up once for every user). A
   user's own endpoints live in their `user.db`.
   - Each endpoint has a name, a kind (`cloud` or `local`, declared, never
     inferred), a base URL, and an API key held encrypted in `user.db`.
   - Initial targets, all OpenAI-compatible: OpenRouter (cloud), LM Studio
     and KoboldCpp (local), and `llama-server` (local).
   - Model discovery through `/v1/models`, plus manual entries. Per model,
     record its context window and whether it supports tool calls.
   - `probe(endpointId)`.
2. **Profiles and overrides.**
   - A cloud profile and a local profile, mapping each task to a `ModelRef`.
   - Per-thread overrides, and the local-only flag (always on for private).
     Use your own tables in `user.db`, separate from Workspace's.
3. **The router.**
   - `resolveModel(task, ctx)` and `modelRuntimeFor(ctx)`.
   - For private or local-only, the Pi `ModelRuntime` contains only local
     models, so Pi's compaction and retries can't reach a cloud model.
   - A cloud request there throws `CloudModelForbidden`, and nothing ever
     falls back across the line.
   - Use Pi's custom-provider support (`docs/custom-provider.md` and
     `docs/models.md` in the Pi package) rather than writing a client.
4. **Admin CLI.**
   - `lyrica admin models endpoints add|list|remove|probe [--shared]`:
     `--shared` signs in as an administrator; otherwise as the user.
   - `lyrica admin models preset list|show|use|set|save|add|rename|remove`, as the user (profiles became presets in #283).
5. **Developer bench.**
   - `lyrica dev` uses the router instead of Pi's default model config.
   - A `--private` / `--local-only` flag starts a bench thread with local-only
     enforced.
   - A debug line shows the model and endpoint chosen for each task.
6. **Local addresses and Tailscale.** Endpoints are declared local or cloud
   by the user.
   - `probe` also checks where a local endpoint resolves.
   - It warns, but doesn't block, if the address isn't loopback, private
     (RFC 1918, `fd00::/8`) or tailnet (`100.64.0.0/10`,
     `fd7a:115c:a1e0::/48`).
   - `*.ts.net` names resolve through the host's normal resolver.

## Out of scope

- `delegate`. It now has its own Delegation thread and
  [docs/delegation.md](../delegation.md). Make sure the router can resolve a
  model for a child thread's `CallContext` (tier, or an explicitly named model
  if the thread allows it). Delegation builds on that.

- The control panel, the model badge, and the nested subagent UI (Web
  thread). Do record what that UI needs: subagent threads must be listable
  under their parent.
- Lyrica managing her own models, which comes later: a model host on each GPU
  machine wrapping vLLM or llama.cpp, with a management API. Keep `Endpoint`
  simple enough that a managed endpoint can be added later as a local
  endpoint with extra controls.
- Sleep.
- Embeddings beyond resolving the `embedding` task.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests, against a fake OpenAI-compatible server (no real keys), show that:
  - a private or local-only runtime contains no cloud model;
  - a cloud request there throws, and compaction and retries stay local;
  - a subagent in a private thread can only get a local model;
  - overrides beat profiles;
  - `probe` reports up and down;
  - a tool-call round trip works through the router;
  - a subagent's thread is created under its parent and inherits "Do not
    log";
  - a subagent can't delegate.
- Note in the pull request how tool calls behave with LM Studio and KoboldCpp,
  checked against their documentation if there's no live server to try.
- `docs/models.md` (new, short) describes what exists. Any contract change is
  listed in the pull request description.

## Handoff notes

(The Models thread fills this in if it stops before it's done.)
