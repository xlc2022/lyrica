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
     resolves outside Li's network.
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
4. **Ordered fallbacks** (the contract change already planned):
   - A profile entry and a thread override become `ModelRef[]`. Migrate
     existing single entries in place.
   - `resolveModel` returns the first model whose endpoint is up, using a
     short-lived health cache fed by probes and by failed calls.
   - A list can never mix cloud and local. Saving one that does is refused.
   - Record which model answered on the call, so the thread and Recent calls
     can show it, along with a fallback that was used and why.
5. **Models page API** in `daemon/src/api.ts`, per the mockup
   (https://claude.ai/artifact/U3xANiSAFje8cuinWpHo7V):
   - endpoints and hosts with live status;
   - each host's GPUs, roles, pins, VRAM and queue, plus pause, resume and a
     dashboard link, proxied through the paired connection with
     administrator checks for shared hosts;
   - the ordered list for each task in each profile, with reorder, add and
     remove;
   - recent calls for the user: time, thread, task, answering model,
     fallback note. Never prompt text.
6. **Plain endpoints stay as they are.** Mark a local endpoint served over
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

(The thread fills this in if it stops before it's done.)
