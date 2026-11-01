# Brief: Switching a model off in its endpoint's list

**Status:** Merged as #742 (89711b7).

**Thread:** Add per-model enable checkbox. **Branch:** `claude/project-thread-a7u7ff`.

**Read first:** docs/models.md "Endpoints and offerings" (Enabled) and
"Choosing a model", docs/delegation.md (the models she may name), docs/ux.md
"Models, hosts, downloads, clean-up".

## Goal

An endpoint such as OpenRouter lists hundreds of models, and every one of
them was a model Lyrica could pick for a subagent, a fallback or a picker.
The user wants to say, model by model, which ones exist for the rest of
Lyrica: a model switched off stays in its endpoint's own list, acknowledged
as offered, and is seen nowhere else. This serves principle 8 (a small,
knowable set of models the user chose, not a catalogue chosen by a vendor)
and keeps the user in charge of what spends their money.

## In scope

- `Offering.disabled`, kept in the offering's hand-set JSON (no schema change,
  no migration). The catalogue the rest of Lyrica reads leaves disabled
  models out; `offerings(userId, endpointId)` alone returns them, marked.
- `setDisabled(actor, offeringIds, disabled)`: switching off drops the model
  from every task list in the user's presets and columns, as switching off a
  capability does. The router reports a thread's own entry or a named model
  that is off as "switched off in <endpoint>'s list". Rediscovery keeps the
  mark. A shared endpoint's models are an administrator's call.
- `PATCH …/endpoints/:id/models { disabled, offeringIds? }` for one model,
  some or every model of an endpoint.
- Web: an **Enabled** checkbox per model in the "N models" list under a host
  or endpoint row (an "off" pill for someone who can't manage it), a muted
  row when off, a search box above the list once it holds more than twelve
  models, and **Disable all models** and **Enable all models** in the
  endpoint's ⋯ menu.

## Out of scope

- Per-user switches over a shared endpoint's models.
- Hiding a model from the host's own dashboard; the host still serves it.
- The OpenRouter model list's contents and order (the Roadmap thread's).

## Done when

- A disabled model is not in any picker, library, group expansion, task list
  or `textModels`, and `resolve` skips it with the reason above; its
  endpoint's list still shows it and it comes back with its ID.
- Core test in `core/test/models.test.ts`; the admin e2e unticks a model and
  switches every model back on from the ⋯.
- docs/models.md, docs/contracts.md, docs/ux.md and docs/delegation.md say
  the above.

## Handoff notes

- Done: all of the above, merged in #742.
- Next: nothing planned. If the user wants the count beside the row to say
  how many are on ("12 models · 3 on"), that is a one-line change in
  `Models.tsx`.
