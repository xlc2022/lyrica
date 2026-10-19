# Brief: Re-read local models' details after a restart

**Status:** Draft. The owner asked for the cause to be found and fixed
(2026-10-19).

**Branch:** `feature/model-facts-refresh`. **Built by:** the Agent loop
thread (it built #360), on Opus.
**Read first:** AGENTS.md, docs/models.md (Discovery, Capabilities),
`core/src/models/index.ts` (`discover`, `refreshServed`),
`daemon/src/lyricad.ts` (`unlocked`), `core/src/users.ts` (`authenticate`).

## Why

In Racing sim 6 the renderer thread decided `qwen3.8-flash-next` couldn't
see images and handed its screenshot check to GLM 4.6V Flash. LM Studio
then loaded GLM next to it. Flash Next is a vision model.

The cause: an offering's details (context, tools, vision) are stored when
its endpoint is read (`Models.discover`). That happens only when someone
adds or edits the endpoint, presses Refresh, or reloads a model. #360
taught discovery to take vision from LM Studio's own API, but endpoints
read before #360 kept their old record, with no vision, until Lunasa
re-read the endpoint by hand. Any later change to what discovery reads
would leave the same gap.

- Principle 1: what she believes about her own models matches the models.
- Principle 8: no new setting and no timer, just two reads that already
  exist, run at the right moments.

## In scope

**A. Re-read local endpoints once per daemon run.** The first time a user's
key is unlocked after lyricad starts (`Users.authenticate`, and the saved
unlock in `lyricad.unlocked` for shared endpoints in self.db), lyricad
calls `discover` on each of that user's local endpoints (LM Studio,
llama.cpp, vLLM, Ollama, Lyrica hosts) in the background:

- Failures are ignored. A server that's down now is read the next time, as
  `routes.ts` already does on create.
- Not awaited by login or by the first request.
- Cloud and plan endpoints aren't re-read: their lists are large, rate
  limited, and change only when the provider changes them.

**B. A request also refreshes vision.** `refreshServed` already asks LM
Studio for its model list before every request to an LM Studio model. It
also stores `vision` from that same reply when it differs, so a model's
own thread is right from its next request even before A runs.

## Docs

- docs/models.md (Discovery): when endpoints are read, including the
  re-read after a restart and the per-request vision refresh.
- docs/contracts.md, if `refreshServed`'s doc comment is quoted there.

## Tests

- In `core/test/models*.test.ts`: an offering stored without `vision` gets
  `vision: true` after A's re-read against a fake LM Studio that reports
  `capabilities.vision: true`.
- `refreshServed` sets `vision` from the same fake when it changed.

## Out of scope

- Automatic vision routing (still needs a DESIGN task, per #372).
- Unloading models she loaded by mistake. The owner declined that for GLM.
