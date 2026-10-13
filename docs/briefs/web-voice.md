# Brief: Web: voice (dictation and Read aloud)

**Status:** Built; on main. Item 4 was built as a consent dialog on a cloud Dictation pick ("Send your voice to the cloud?"), with no separate switch (docs/ux.md, Dictation and Read aloud models).

**Thread:** Web UI. **Branch:** `feature/web-voice`. **Model:** Fable.

**Depends on:** Speech ([speech.md](speech.md)) merged. Review by the UI
review thread and the PR review thread.

**Read first, every time:** docs/ux.md. A PR that touches the interface
follows its checklist.

**Read first:** DESIGN.md "Voice", docs/web.md, the Speech routes in
`daemon/src/api.ts`, and the app mockup
(https://claude.ai/artifact/96BoPXPoxL2LDBg8eLxjHx). The mockup's message
box is the agreed design; its voice buttons are placeholders.

## Goal

Dictating to her and hearing her are one press each, on a phone as on a
desktop, in the message box the user already knows (principle 1).

## In scope

1. **Dictate**: the mic in the quiet row under the message box, right of
   "+", a borderless 16 px icon like "+".
   - Recording: the icon itself turns accent and pulses (the existing
     pulse, never a filled circle). The box's placeholder reads
     "Listening…", and the elapsed time sits beside the icon, mono, 12 px,
     muted.
   - Pressing again, or Enter, stops and transcribes; Escape throws the clip
     away. While transcribing, the icon pulses in muted. The text goes in
     at the caret.
   - Audio is 16 kHz mono PCM from an AudioWorklet, sent as WAV. Nothing is
     kept in browser storage.
   - With no speech model allowed in this thread, the mic is disabled, and
     its tooltip says why.
2. **Read aloud** in her message actions, with a speaker icon, turning into
   **Stop reading** while it plays. The mic, sending, another Read aloud or
   leaving the thread also stops it, and only one thing plays at a time.
   Playback starts from the press, which iPhone requires.
3. **Errors** ("Allow the microphone in your browser", "The speech model
   can't be reached") show as a plain sentence in the conversation's error
   line above the message box. They never show as a toast or in the
   placeholder.
4. **Voice to cloud**: a switch in the thread's Privacy and network
   section, under Local-only and Internet. It follows the user's default
   the same way, and the default is set beside the user's other defaults.
5. **Models:**
   - Tasks gains two rows, **Dictation** and **Read aloud**;
   - a speech model's Settings drawer gets **Voice**, a select per
     language, and **Speed**, a number field with its maximum shown, with
     the usual source word and Reset.
6. The wave button for voice conversation stays hidden.

## Out of scope

- Voice conversation (later brief).
- The back end and the host.

## Done when

- typecheck, tests, build and Playwright pass in CI. Playwright uses a fake
  microphone and a fake speech endpoint.
- Screenshots at 1280 and 390 wide, light and dark, of: recording,
  transcribing, Read aloud playing, the disabled mic, and the Voice to
  cloud switch.
- The PR says which ux.md rule each new control follows, and docs/web.md
  describes what changed.

## Handoff notes

(The thread fills this in if it stops before it's done.)
