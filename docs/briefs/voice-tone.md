# Brief: a tone for each piece Read aloud speaks

**Status:** Planned (2026-11-16). Owner: the read-aloud thread.

## Why

Qwen3-TTS CustomVoice speakers follow a short instruction ("gently amused",
"quiet and tender"), but Read aloud sends one fixed, calm instruction
(#1185), so a happy reply and a sad one sound alike. The owner wants her
voice to carry the feeling of what she says, and wants the tone notes never
shown (principles 1 and 6).

## What

1. **The note.** Before a piece is spoken, a model reads it, with the piece
   before it, and answers a tone note of at most eight English words. The
   call goes through `core/models` on the thread's own task list (a new
   task, `speech.tone`, defaulting to the Titles model), so a private or
   local-only thread keeps its text on its own machines. A note that fails
   or is late falls back to the calm default; the reading never waits more
   than 1 s for one.
2. **Ahead of time.** Read aloud already fetches the next piece while one
   plays; it asks for the next note then too, so only the first piece waits.
3. **Passed down, never shown.** `Models.speak` takes an optional
   `instruct`; host-api's `/v1/audio/speech` passes it to the Qwen3-TTS
   server, which gives it to CustomVoice in place of the default. Kokoro and
   Base ignore it. The note isn't stored, logged or sent to the web UI: it
   lives only for the request (no plaintext memory).
4. **Her replies are unchanged.** She doesn't write the note herself, so
   nothing hidden ever sits in a reply's text.

## Out of scope

- **Friend.** Base clones a clip and takes no instruction, so Friend keeps
  one tone. Giving Friend feelings means fine-tuning a CustomVoice model on
  Friend's voice (Qwen publishes the scripts); that would be a brief of its
  own, with a recording set to make first.
- Any control or display. The tone task appears in the task lists like the
  others only if the owner asks.

## Done when

- On danube, a happy, a sad and a matter-of-fact reply read by Sohee sound
  clearly different, and the pieces within each stay consistent.
- Tests: the note goes through the thread's task list (a private thread
  never reaches a cloud model), a slow or failed note falls back, and no
  note reaches a log, the database or the web UI.
- docs/daemon.md, host/API.md, host/README.md, docs/contracts.md and this
  brief describe what exists.
