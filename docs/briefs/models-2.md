# Brief: Models 2 (hosts, fallbacks and the Models page API)

**Thread:** Models 2. **Branch:** `feature/models-2`.

**Depends on:** Models, Daemon and Web access (merged). It is built in parallel
with the Model host thread, against `host/PAIRING.md` and the host API, which
that thread publishes early. Until they land, test against a fake host made
from those documents.

**Read first:**
- AGENTS.md and PRINCIPLES.md;
- DESIGN.md: "Models and endpoints", including Fallbacks, the Models page,
  the model host bullets and Pairing;
- docs/models.md and docs/daemon.md;
- docs/contracts.md: `core/models` (including the planned fallback lists) and
  `daemon`;
- `docs/briefs/model-host.md`.

## Goal

Lyrica uses paired model hosts as easily as plain endpoints. Each task falls
back to the next model when the first is away, and one API gives the Web UI
everything the Models page needs. This serves principle 1: the workstation
can be off, paused or busy gaming without Lyrica going dark.

## In scope

1. **Model hosts as endpoints.**
   - A new endpoint kind, `host`, stored like other endpoints: shared hosts
     in `self.db` (administrators only), personal ones in the user's
     `user.db`.
   - Each host has a name, an ordered list of addresses, the pinned host
     certificate, and Lyrica's own key and certificate, which is one per
     `lyricad`, kept in `self.db`.
   - Hosts are always local. The existing warning applies when an address
     resolves outside the owner's network.
2. **The pairing client**, exactly as `host/PAIRING.md` specifies:
   - add a host from its addresses and a pairing code, then pin;
   - edit addresses without pairing again;
   - unpair;
   - "this host's identity changed" when the pinned certificate doesn't
     match, which refuses the connection.
3. **Calling a host.**
   - Mutual TLS with the pins, trying the addresses in order.
   - Chat, tools, streaming and embeddings go through the host's
     OpenAI-compatible `/v1`. Pi's `openai-completions` client keeps working,
     with the TLS agent supplied by the router.
   - Map the host's "paused" and "busy" errors to plain reasons.
4. **Permanent IDs.**
   - Endpoints get a UUID, with the name as a label.
   - Each model an endpoint offers gets its own UUID (an *offering*), and
     profiles, overrides and recent calls refer to it. Migrate existing
     `{ endpointId, modelId }` references.
   - A model the endpoint stops listing keeps its offering, marked
     `missing`.
   - Editing an endpoint (URL, address, key, re-pairing) never changes its
     IDs.
   - **Cleanup**, as in DESIGN:
     - `stale` endpoints (14 days unreachable) and `gone` offerings (30 days
       missing);
     - automatic pruning of gone offerings nothing refers to;
     - a Clean up API listing where each one is used, with **Replace with…**
       (suggesting the same model on another endpoint) and **Remove**.
   - **Redirects and tombstones** (`offering_redirects`) in `self.db` or
     `user.db`, followed by the router at once.
     - Each user's profiles, overrides and saved workflows are rewritten when
       that user unlocks, with a one-time notice.
     - A redirect is deleted once no user still refers to it, which is
       tracked per user.
   - **Reset IDs** and **merge endpoints**, both through redirects.
   - Call records keep the name and endpoint label with the ID.
   - **Tests:**
     - removing a shared endpoint while another user is locked: that user's
       next unlock rewrites their lists and shows the notice, and their calls
       already skipped it before that;
     - a replacement routes at once;
     - Reset IDs breaks nothing;
     - history still shows the old label.
   - Offerings carry capabilities (tools, vision, embedding, image, edit),
     from discovery or set by hand. Offer "the same model" on another
     endpoint as a suggested fallback, matching on the model's name or
     digest.
5. **Model groups**, as in DESIGN:
   - Groups of offerings from different endpoints that the user declares the
     same model, ordered, with a permanent ID, shared (administrators) or
     personal.
   - Lists can name a group, which expands in place into its members in order.
   - Members are filtered by the thread's allowed kinds, and skipped when
     unfit for the call (no tool support when needed, a context window
     smaller than the conversation).
   - An API showing how members differ.
   - Suggestions, never automatic: the same file checksum on two hosts
     (strong), or a matching name (weak).
   - Cleanup applies inside groups, and an empty group is flagged.
   - Tests:
     - a private thread never uses a group's cloud member;
     - failover runs through a group in order;
     - an unfit member is skipped;
     - a member removed while another user is locked is gone from that user's
       group after they unlock.
6. **The Custom profile.**
   - A third profile, `custom`, mixes local and cloud. Only general threads
     that aren't local-only use it.
   - A per-user default ("general threads use Cloud or Custom") plus a
     per-thread switch.
   - Tests must show that a private or local-only thread never resolves
     through Custom, even when it is the user's default.
7. **The model library API**, as two libraries: text models, and image
   models. The image library lists recipes (with their parts, proposals and
   missing parts) and parts by type, through the host's recipe API: confirm
   or ignore a proposal, fill missing parts, swap a part within its role and
   slot, delete. Pickers for image tasks offer only confirmed recipes.
   Tests: a proposed recipe never resolves; deleting a recipe keeps every
   part another recipe uses.

   The text library: one entry per model with its copies on every
   endpoint, and the group they're in, if any. Each copy carries its raw
   name and whether Lyrica downloaded it.
   - **Identity**, as in DESIGN: base name, size and finetune, from the
     host's metadata, the model card or the model ID. Only `quantized` joins
     a copy to its base; a finetune, merge or adapter is its own entry with a
     link to its base. Flag a copy whose file name has words its model's
     name doesn't. **Not this model** moves a copy to an entry of its own;
     an administrator decides for shared endpoints, the owner for personal
     ones.
   - Tests: a finetune is never in its base's entry or suggested for its
     group, even when its file records no finetune and a user hasn't
     separated it yet; it is flagged instead. Search and filter by kind,
   endpoint, capability and groups only, with paging for hundreds of models,
   plus starring (per user).
   - **Download model:** list a repository's files on a chosen host (marking
     files already there and those too big for its free space), start a
     download, follow its progress, cancel. It goes through the host's
     management API. Shared hosts need an administrator.
   - **Hub tokens** for Hugging Face and ModelScope: add, replace, remove.
     A user's own is encrypted in `user.db`; an administrator can share one
     in `self.db`. The API returns only the last four characters. The token
     is sent with each request that needs it.
   - **Delete** only a copy the host's download record lists, through its
     management API,
     returning first where it's used. It leaves a `removed` redirect. Shared
     hosts need an administrator.
   - Tests: a token never appears in an API response, a log or a call
     record; deleting a shared-folder file is refused; deleting a copy in
     use leaves every list working.
   - A finished download is discovered as a new offering at once, with a
     suggestion to add it to a group of the same model.
8. **Ordered fallbacks** (the contract change already planned):
   - A profile entry and a thread override become `ModelRef[]`, or
     `{ same: Task }` for a task that uses another task's list (one level
     deep, same capability). Migrate existing single entries in place. New
     profiles start with titles and compaction following cheap subagents,
     and sleep following strong.
   - `resolveModel` returns the first model whose endpoint is up, using a
     short-lived health cache fed by probes and by failed calls.
   - Local and cloud lists can never mix kinds, and saving one that does is
     refused. Custom may mix them.
   - Record which model answered on the call, so the thread and Recent calls
     can show it, along with a fallback that was used and why.
9. **Models page API** in `daemon/src/api.ts`, per the mockup
   (https://claude.ai/artifact/U3xANiSAFje8cuinWpHo7V):
   - endpoints and hosts with live status;
   - each host's GPUs (allowed servers, free margin), each model's
     placement and pin, VRAM and queue, plus pause, resume and a
     link to the host's own dashboard (at the address last reached; the
     host keeps its own password check), the rest proxied through the
     paired connection with administrator checks for shared hosts;
   - the ordered list for each task in each profile, with reorder, add and
     remove;
   - recent calls for the user: time, thread, task, answering model,
     fallback note. Never prompt text.
9a. **Reasoning level.**
   - The `reasoning` capability with its levels on offerings: discovered
     where the endpoint says so (OpenAI-compatible model metadata, a host's
     report for llama.cpp and vLLM models with a thinking switch), else set
     by hand.
   - A per-thread `thinking` setting (off, low, medium, high) with a
     per-user default, passed through Pi's thinking level; mapped to
     `reasoning_effort` for OpenAI-compatible endpoints and to the chat
     template's thinking switch for host models that use one.
   - The thread API reports the levels the current model offers, and a call
     record notes when a fallback couldn't think.
   - Thinking text is never indexed for recall and never logged.
   - Tests: the level reaches the request for a model that offers it; a
     model without it gets no thinking parameter and the call notes it;
     thinking text isn't in search results.
9b. **Model settings**, as in DESIGN:
   - per offering, "how it answers" (temperature, top-p, top-k, min-p,
     repeat, presence and frequency penalties, maximum reply length, seed,
     stop strings), stored in `self.db` for shared endpoints
     (administrators) and `user.db` for personal ones, with a per-user
     override of a shared offering's values in `user.db`;
   - sent with every call to that offering through `core/models`, mapped to
     each API's names; unset values aren't sent;
   - the context window per offering, from the host's serving settings,
     discovery or set by hand, used by compaction and group fitting;
   - for host offerings, the API reads and writes the host's serving
     settings through the management API (administrators for shared hosts)
     and offers Reload now;
   - the library API returns each value with its source (endpoint default,
     shared, yours).
   - Tests: the values reach the request; a user's override wins for that
     user only; unset values are absent; another user's override never
     applies.
10. **Plain endpoints stay as they are.** Mark a local endpoint served over
   plain HTTP, outside this machine and the tailnet, as `unencrypted` in the
   API.

## Out of scope

- The host package (Model host thread).
- The Models page UI (Web UI thread).
- The `image` tool and image tasks (Images thread). Keep `image.create` and
  `image.edit` resolvable, though.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests, with a fake host that speaks the pairing and API documents, show
  that:
  - pairing pins both sides;
  - a changed host key is refused with the plain reason;
  - an edited address keeps trust;
  - a fallback is used when the first host is paused or down, the thread
    records which model answered, and a list never crosses between local and
    cloud;
  - existing profiles migrate to lists;
  - a personal host is invisible to other users;
  - shared host management needs an administrator;
  - recent calls carry no prompt text;
  - private and local-only threads still never get a cloud model.
- docs/models.md describes what exists, and the PR lists the contract changes.

## Handoff notes

**Done** (PRs #30, #34, #36, #37 and #40, stacked in that order): items
1–10, with 9 as the API only (no UI).

**Next:**
- Send `X-Lyrica-Priority: background` for sleep and cheap subagents. Pi's
  request preparation (where hosts get their fetch) would need the task.

**Open questions:** none blocking. Decisions taken are listed in each PR.
