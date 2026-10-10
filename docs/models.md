# Models

Every model call goes through one router, which picks the model for each task
from the user's profiles and the thread's own choices. Code:
`core/src/models/` (no Pi), `extension/src/models.ts` and `session.ts`.

## Guarantee

A private or local-only thread's Pi session holds only local endpoints, so
nothing in it can call a cloud model: not the conversation, not a child
thread, not Pi's compaction or retries. Anything sent to a cloud endpoint from a
general thread is outside this.

## Endpoints and offerings

An endpoint is a name, a kind (`cloud` or `local`, declared by whoever adds
it, never inferred), an OpenAI-compatible base URL and an optional API key.

- **Permanent IDs.** Every endpoint has a UUID, and its name is a label that
  can change. Every model it offers is an **offering** with its own UUID, so
  the same model on two endpoints is two offerings. Profiles and thread
  choices name offerings (`ModelRef` is `{ offeringId }`). Renaming an
  endpoint, or changing its URL or key (`editEndpoint`), keeps every ID.
- **Labels.** People and Lyrica name a model as `<endpoint>/<model>`, with
  `shared.` before a shared endpoint's name, so the two never collide.
  `find(userId, idOrLabel)` takes either form. A saved workflow's models are
  stored by offering ID (`workflowSpec`), so renaming breaks nothing.
- **Shared** endpoints live in `self.db`. Only an administrator can add,
  change or remove them. Every user can use them. A user's **own**
  endpoints live in their `user.db`.
- `discover` reads `GET /v1/models`. A new model gets an offering; one the
  endpoint stops listing keeps its offering, marked `missing`, and gets it
  back if it returns. Models can be added by hand (`addModel`) and are never
  marked missing.
- **Capabilities:** context window, tools, vision, embedding, image, edit
  and thinking levels. OpenRouter reports the context, tools, thinking and
  modalities; llama-server reports the context
  (`meta.n_ctx`); LM Studio and KoboldCpp report neither. Anything can be
  set by hand (`setCapabilities`), which wins over discovery.
- `probe(userId, endpointId)` is `up` when `/v1/models` answers within 5
  seconds. For a local endpoint it also warns, without blocking, when the
  host resolves outside Li's own network: loopback, RFC 1918, `fd00::/8`, or
  the Tailscale tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). `*.ts.net`
  names resolve through the host's resolver.
- A local endpoint over plain HTTP whose host isn't loopback or the tailnet
  is marked `unencrypted`.
- `sameModel` finds the same model on other endpoints of the same kind by
  name, ignoring an organisation prefix, a file extension and quantisation
  words (`baseName`), for a suggested fallback or replacement.

## Cleaning up

- An endpoint whose probes, discovery and calls have all failed for 14 days
  is **stale**: any reply that comes back clears it (`reportUp`, from every
  Pi session); an offering missing for 30 days is **gone**. The router skips
  both.
- `prune` runs nightly. It removes gone offerings no list names: a shared one
  only once every user's lists have been indexed and none names it, a
  user's own while they are unlocked.
- `cleanup(userId)` lists the stale endpoints, gone models and empty groups
  the user can see, where they are used (the user's profiles, threads, saved
  workflows and groups, and shared groups), how many other users' lists name it, and the same model on
  another endpoint, if there is one.
- `replace(actor, from, to)` deletes an offering and leaves a **redirect** to
  another of the same kind (a shared one for a shared one).
  `removeOffering` and `removeEndpoint` leave **tombstones**. A new redirect
  repoints earlier ones at its target, so chains are one hop long. `resetIds`
  gives an endpoint and its offerings fresh IDs, and `merge` folds one
  endpoint into another of the same kind and place; both leave redirects.
- **Shared redirects** live in `self.db` (`offering_redirects`), and the
  router follows them at once. Each user's lists (profiles, thread choices,
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
`shared_refs_indexed` and `legacy_refs` (in `self.db`); `model_profiles`,
`thread_models`, `thread_choices`, `local_only_threads` and `model_calls`
(in `user.db`). See `core/src/models/schema.ts`.

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

## Profiles and lists

Each user has three profiles, each mapping a task to an ordered list of
models or groups, or to another task's list (`{ same: task }`):

- **local:** local models only. Private and local-only threads always use it.
- **cloud:** cloud models only.
- **custom:** local and cloud mixed. Only general threads that aren't
  local-only use it.

A group in a local or cloud list needs a member of that kind; its other
members are skipped. General threads use the user's default
(`setDefaultProfile`: cloud, unless set to custom) or their own choice
(`setThreadProfile`). A thread's own lists (`setThreadModel`) beat the
profile, and outside Custom they keep to one kind.

`same` names a task of the same kind (text, embeddings, images) that doesn't
itself follow another, so it is one level deep. A profile's first entry
brings the defaults: titles and compaction follow cheap subagents, and the
sleep phases follow strong subagents. A task with no list follows chat,
except embeddings and the image tasks.

Profiles used to be cloud and local, with local models allowed in the cloud
profile. A cloud profile that named a local model was copied to Custom,
which became that user's default, with a notice.

## Choosing a model

`resolve(task, ctx, need?)` walks the list that decides the task (the
thread's, else the profile's after `same`, else chat's), expanding groups
and following redirects, and returns the first model that can answer, with
the ones it skipped and why. A model is skipped when:

- it is gone, or its endpoint is stale;
- its endpoint is known to be down: the health cache holds each probe's
  result and each failed connection (`reportDown`) for 30 seconds;
- it can't handle the call: no tools when tools are needed, a context window
  smaller than the conversation, or, for image tasks, no image capability;
- outside Custom, it is of the other kind than the list (local in a private
  or local-only thread, cloud in the cloud profile, else the list's first
  model's), so nothing falls back across the local/cloud line.

In a private or local-only context, a group's cloud members are skipped and
a cloud model named directly throws `CloudModelForbidden`, wherever it came
from. The settings refuse a cloud model where it can't be used, and a
replacement or merge never changes a model's kind. A private thread is
always local-only.

`resolveLive` first probes the chosen endpoint (2 seconds) when its health
isn't known lately and there is a later model to fall back to.
`resolveModel` returns just the chosen `{ offeringId }`.

`callContext(userId, pool, threadId)` reads a thread's local-only switch,
profile, thinking level and lists from `user.db`.

## Each turn

`openThreadSession` returns `prepare()`, which `lyricad` runs before every
turn (and delegation once for each subagent): it resolves the chat model
with `resolveLive`, switches the session to it, sets the thinking level,
and records the call. A connection error during a turn marks that endpoint
down, and when Pi retries, the chat model is chosen again first, so the
retry goes to the next model in the list. `resolveLive`'s probe only asks
whether the endpoint answers; the address check never holds up a turn.
Tools are asked of a model only when the thread has tools.

**Recent calls** (`recentCalls`, `model_calls` in `user.db`) hold the time,
thread, task, the answering model's ID with its label, endpoint and kind,
the fallback taken and why, and a note such as a model that couldn't think.
Never prompt text. The latest 500 per user are kept.

## Thinking

Offerings carry `reasoning`, the levels they offer besides off: discovered
from OpenRouter's `supported_parameters`, or set by hand. Threads have a
thinking setting (off, low, medium, high, `setThinking`) with a per-user
default (`setDefaultThinking`, off unless set). `thinkingFor` maps it to
what the model offers: the nearest level it has, or off with a note when it
can't think. Pi passes it as `reasoning_effort` to OpenAI-compatible
endpoints. Subagent roles keep their own level. Thinking text is stored with
the thread but never made searchable.

## The Pi runtime

`modelRuntimeFor(models, ctx)` builds a Pi `ModelRuntime` with exactly the
endpoints `ctx` may use, each a Pi provider (named by the endpoint's ID) of
API `openai-completions` holding its offerings.

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
- the parent's local-only switch, profile, thinking level and model choices;
- as its chat list, the parent's `subagent.cheap` or `subagent.strong`
  list, or a named model or group the parent's context allows.

A private or local-only parent can only give its child a local model. A
refusal throws before anything is written. `delegate` itself belongs to the
Delegation thread ([delegation.md](delegation.md)).

## Commands

```sh
lyrica admin models endpoints add <name> cloud|local <base-url> [--shared | --user <login>]
lyrica admin models endpoints list|remove|probe [<name>] [--shared | --user <login>]
lyrica admin models endpoints model <name> <model-id> [--context <tokens>] [--tools] [--shared | --user <login>]
lyrica admin models profile show --user <login>
lyrica admin models profile set local|cloud|custom <task> <endpoint>/<model>[,…]|same:<task>|none --user <login>
lyrica admin models profile default cloud|custom --user <login>
```

Endpoints are named by their label (`<name>`, or `<name>` with `--shared`).

API keys are typed at a hidden prompt. `add` and `probe` re-read the
endpoint's model list and print any address warning. `lyrica dev --private` or `--local-only` starts a bench
thread with local-only enforced, and prints the model and endpoint chosen for
each task.
