# Brief: Models

**Thread:** Models. **Branch:** `feature/models`. **Depends on:** Core and
Memory (merged), and Workspace (#6) for `inheritSettings`. If Workspace hasn't
merged by the time you reach `delegate`, merge it in first.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md ("Models and endpoints"),
docs/contracts.md (`core/models`, `delegate`).

## Goal

Every model call Lyrica makes goes through one router. It picks the model for
each task from the user's profiles and the thread's overrides. It makes
"private or local-only means no cloud model, for any purpose" structural.
Lyrica can hand work to cheap or strong subagents.

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
4. **`delegate`**, as in the contracts:
   - a child thread recorded as a subagent of its parent;
   - `inheritSettings` for the workspace;
   - the tier's model through the same `CallContext`;
   - a worker prompt with read-only memory;
   - depth 1, and a concurrency limit per thread;
   - the result returned as the tool result.

   The tool's guidelines state the rule: cheap for searching, reading,
   summarizing and checking; strong for writing, judgment and changing files.
   - Build it yourself on Pi's SDK. Don't depend on `pi-subagents`.
   - Adapt its MIT-licensed role prompts (`scout`, `researcher`, `reviewer`,
     `worker`, `oracle`, from `agents/` in the npm package) into short role
     prompts, with a credit line in the source.
5. **Admin CLI.**
   - `lyrica admin models endpoints add|list|remove|probe [--shared]`:
     `--shared` signs in as an administrator; otherwise as the user.
   - `lyrica admin models profile show|set`, as the user.
6. **Developer bench.**
   - `lyrica dev` uses the router instead of Pi's default model config.
   - A `--private` / `--local-only` flag starts a bench thread with local-only
     enforced.
   - A debug line shows the model and endpoint chosen for each task.
7. **Local addresses and Tailscale.** Endpoints are declared local or cloud
   by the user.
   - `probe` also checks where a local endpoint resolves.
   - It warns, but doesn't block, if the address isn't loopback, private
     (RFC 1918, `fd00::/8`) or tailnet (`100.64.0.0/10`,
     `fd7a:115c:a1e0::/48`).
   - `*.ts.net` names resolve through the host's normal resolver.

## Out of scope

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
