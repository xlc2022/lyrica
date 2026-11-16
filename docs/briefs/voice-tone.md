# Brief: a tone for each paragraph Read aloud speaks

**Status:** Built (2026-11-16). Owner: the read-aloud thread. What exists
is in docs/daemon.md (Speech, "Tone notes") and docs/memory.md (Storage).

## Why

Qwen3-TTS CustomVoice speakers follow a short instruction ("gently amused",
"quiet and tender"), but Read aloud sends one fixed, calm instruction
(#1185), so a happy reply and a sad one sound alike. The owner wants her
voice to carry what she means, with no delay before it speaks, and wants the
tone notes never shown and never in her memories (principles 1 and 6).

## What

1. **She writes them.** When the user's Read aloud model takes instructions
   (host-api marks a CustomVoice model's `speak` with `instruct: true`), her
   context asks her to open a paragraph whose feeling differs from the last
   with a tag, `<tone>gently amused</tone>`, at most eight English words.
   Without such a model, nothing asks her to, and no tokens are spent.
2. **Taken out as she writes.** The extension lifts each tag out of the
   reply as it streams, the way it lifts inline `<think>` (`inline-thinking.ts`),
   with a hand-written scanner, not a regex over her output. The reply's
   text never holds a tag, live or stored. A tag left half-written at the
   end is dropped.
3. **Kept apart.** The notes, each with the offset where its paragraph
   starts, are stored in the pool's own `tones` table by entry, encrypted
   like the rest of the thread, never in the entry. Context assembly, sleep,
   recall, search, export, the web UI and anything added later read
   entries, so none of them sees a note: it can't reach her memories, her
   later turns or the user's screen. Read aloud is the one reader
   (`PoolStore.tones`), and a test holds it to that.
4. **Spoken with.** `readAloud` gives each piece the note of the paragraph
   it starts in, or the last note before it, and passes it to `Models.speak`
   as `instruct`; host-api passes it to the Qwen3-TTS server, which gives it
   to CustomVoice in place of the calm default. Kokoro and Base ignore it.
   A reply with no notes is read with the default.

## Out of scope

- **Friend.** Base clones a clip and takes no instruction, so Friend keeps
  one tone. Feelings for Friend need a CustomVoice model fine-tuned on
  Friend's voice: a brief of its own.
- Any control or display.
- Notes for replies written before this ships.

## Done when

- On danube, a happy, a sad and a matter-of-fact reply read by Sohee sound
  clearly different, and Read aloud starts as quickly as it does today.
- Tests: a tag, whole or split across stream chunks, never reaches the
  reply's text; the read path leaves the tone part out for every caller
  but Read aloud (one test that guards every consumer); Read aloud sends each
  piece's note; no tag is asked for when the Read aloud model takes no
  instructions.
- docs/memory.md, docs/sleep.md, docs/daemon.md, docs/contracts.md,
  host/API.md, host/README.md and this brief describe what exists.
