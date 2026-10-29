# Brief: Speech (dictation and Read aloud, back end)

**Status:** Merged as #64 (fde3727); the host side as #65 (fed3b22).

**Thread:** Speech. **Branch:** `feature/speech`. **Model:** Opus.

**Depends on:** nothing. It can run alongside Model host: speech
([speech-host.md](speech-host.md)). Build and test against a fake
OpenAI-compatible speech endpoint, and by hand against a cloud endpoint or a
local speech server started by hand and added with Add endpoint.

**Read first:**
- AGENTS.md and PRINCIPLES.md;
- DESIGN.md: "Voice", "Models and endpoints" and "Memory pools";
- docs/contracts.md: `core/models` (with its Planned (Speech) entry) and
  `daemon`;
- docs/models.md and docs/daemon.md.

## Goal

A user can dictate a message and hear any of her replies, in English and
Mandarin, with speech held to the same local/cloud boundary as every other
model call. This serves principle 1 (talking to her from the phone) and
principle 2 (the boundary stays structural).

## In scope

1. **Two tasks** in `core/models`: `speech.transcribe` and `speech.speak`.
   - Own list only, so neither follows Chat.
   - Capabilities `transcribe` and `speak` (with voices and their
     languages), from a host's discovery or set by hand. Pickers offer only
     suitable models.
   - The router's rules apply unchanged: a restricted context uses the Local
     profile, and a cloud model throws `CloudModelForbidden`.
2. **`Models.transcribe` and `Models.speak`**, the only way audio reaches a
   model:
   - OpenAI's `/v1/audio/transcriptions` and `/v1/audio/speech` shapes;
   - through `fetchFor` for a host, so its pinned key is checked;
   - a fallback when the first model is down, never across the local/cloud
     line;
   - closing the stream cancels the call.
3. **Per-copy settings** for speak models: a voice for each language, and a
   speed. A shared value is set by an administrator; a user's own is shown
   as "yours". Both use the existing `offeringSettings` layering.
4. **Voice to cloud** (`voiceCloud`): a per-user default (off), and a
   per-thread override in `ThreadSettings`, like `internet`. The transcribe
   route checks it before the router is asked. When it is off and the
   resolved model is cloud, the route refuses with `VoiceCloudOff`, and no
   byte leaves.
5. **Daemon routes:**
   - `POST …/threads/:id/transcribe`, and `POST …/transcribe?pool=` for the
     welcome page, where no thread exists yet. The body is `audio/wav`
     (16 kHz mono), at most 10 minutes; `{ text }` comes back.
   - `GET …/threads/:id/messages/:n/speech`: reads the message from the
     store, drops code blocks, tables, links and markdown, splits it into
     sentences, and asks for one sentence at a time while keeping one
     ahead. It streams audio as it arrives. For a message still streaming,
     it follows the message to its end.
6. **Records.** A call record per transcription and per Read aloud, with
   the task, the model and `audioSeconds`. Audio is held in memory only:
   nothing touches disk, and no log holds audio or text.

## Out of scope

- The host's speech server and models (Model host: speech).
- Everything a user sees (Web: voice).
- Voice conversation (see below) and voice cloning.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests, with a fake speech endpoint, show that:
  - a private or local-only thread never reaches a cloud speech model, for
    either task;
  - with Voice to cloud off, a cloud transcription is refused before any
    request is made, and a thread's override beats the user's default;
  - Read aloud reads the stored message, skips code, streams sentence by
    sentence, and stops the upstream call when the client disconnects;
  - fallbacks work within one kind;
  - no temp file is written, and call records hold no text.
- docs/models.md and docs/daemon.md describe what exists, and the
  contracts' Planned (Speech) entry becomes current.

## Later: voice conversation

DESIGN.md's "Voice" describes voice conversation: a state of the message
box in any thread, turned on by the wave button and off by End or Escape.
Typing mixes in freely; spoken messages are stored as text with a `spoken`
flag; while it is on, her turn context says the user is listening; and
speaking over her stops her turn. It reuses this brief's routes, plus voice
activity detection in the browser and the `spoken` flag. It gets its own
brief once dictation and Read aloud have been used for a while.

## Handoff notes

(The thread fills this in if it stops before it's done.)
