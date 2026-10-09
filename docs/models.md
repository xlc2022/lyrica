# Models

Every model call goes through one router, which picks the model for each task
from the user's profiles and the thread's own choices. Code:
`core/src/models/` (no Pi), `extension/src/models.ts` and `session.ts`.

## Guarantee

A private or local-only thread's Pi session holds only local endpoints, so
nothing in it can call a cloud model: not the conversation, not a child
thread, not Pi's compaction or retries. Anything sent to a cloud endpoint from a
general thread is outside this.

## Endpoints

An endpoint is a name, a kind (`cloud` or `local`, declared by whoever adds
it, never inferred), an OpenAI-compatible base URL and an optional API key.

- **Shared** endpoints live in `self.db`, IDs `shared.<name>`. Only an
  administrator can add, change or remove them. Every user can use them.
- A user's **own** endpoints live in their `user.db`, IDs `<name>`.
- Each endpoint records its models: from `GET /v1/models` (`discover`), or
  entered by hand. A model records its context window and whether it takes
  tools, when known. OpenRouter reports both; llama-server reports the
  context (`meta.n_ctx`); LM Studio and KoboldCpp report neither, so enter
  them by hand.
- `probe(userId, endpointId)` is `up` when `/v1/models` answers within 5
  seconds. For a local endpoint it also warns, without blocking, when the
  host resolves outside Li's own network: loopback, RFC 1918, `fd00::/8`, or
  the Tailscale tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). `*.ts.net`
  names resolve through the host's resolver.

Tables: `endpoints` and `endpoint_models` (in both `self.db` and `user.db`);
`model_profiles`, `thread_models` and `local_only_threads` (in `user.db`).
See `core/src/models/schema.ts`.

## Choosing a model

`resolveModel(task, ctx)`:
1. The thread's own choice for the task (`ctx.overrides`), else
2. the profile's: the **local** profile for a private or local-only thread,
   the **cloud** profile otherwise. The cloud profile may name local models
   too.
3. A task with neither uses the chat model by the same rule, except
   `embedding`, which must be set.

In a private or local-only context a cloud model throws
`CloudModelForbidden`, wherever it came from. Nothing falls back across the
line: with no local model set, the call fails. The settings refuse a cloud
model where it can't be used (the local profile, a private or local-only
thread). A private thread is always local-only.

`callContext(userId, pool, threadId)` reads a thread's local-only switch and
overrides from `user.db`.

## The Pi runtime

`modelRuntimeFor(models, ctx)` builds a Pi `ModelRuntime` with exactly the
endpoints `ctx` may use, each a Pi provider of API `openai-completions`
holding its recorded models.

- Pi's 42 built-in providers are removed. `auth.json`, `models.json` and
  environment keys are never read. API keys are set as runtime keys, so they
  are never read as `$ENV` or `!command`.
- Before returning, it checks every provider against the allowed endpoints,
  and it seals the runtime, so no extension can add one later.
- Local endpoints are sent `system` rather than `developer`, and `max_tokens`
  rather than `max_completion_tokens`. LM Studio, KoboldCpp and llama-server
  don't all accept the newer fields.
- Pi compacts with the session's own model, so in practice the `compaction`
  task is the chat model.

`openThreadSession` hosts one thread with that runtime and its chat model.

## Child threads

`childContext(parent, childThreadId, { tier } | { model })` gives a child
thread, such as a subagent's, its `CallContext`:
- the parent's local-only switch and model choices;
- as its chat model, the parent's `subagent.cheap` or `subagent.strong`
  model, or a named model the parent's context allows.

A private or local-only parent can only give its child a local model. A
refusal throws before anything is written. `delegate` itself belongs to the
Delegation thread ([delegation.md](delegation.md)).

## Commands

```sh
lyrica admin models endpoints add <name> cloud|local <base-url> [--shared | --user <login>]
lyrica admin models endpoints list|remove|probe [<name>] [--shared | --user <login>]
lyrica admin models endpoints model <name> <model-id> [--context <tokens>] [--tools] [--shared | --user <login>]
lyrica admin models profile show --user <login>
lyrica admin models profile set cloud|local <task> <endpoint>/<model>|none --user <login>
```

API keys are typed at a hidden prompt. `add` and `probe` re-read the
endpoint's model list and print any address warning. `lyrica dev --private` or `--local-only` starts a bench
thread with local-only enforced, and prints the model and endpoint chosen for
each task.
