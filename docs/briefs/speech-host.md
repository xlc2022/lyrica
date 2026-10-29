# Brief: Model host: speech

**Status:** Merged as #65 (fed3b22); starters in #69, the voice pick in #70.

**Thread:** Model host. **Branch:** `feature/host-speech`. **Model:** Opus.

**Depends on:** nothing. It runs alongside Speech ([speech.md](speech.md)).

**Read first:**
- AGENTS.md and PRINCIPLES.md;
- DESIGN.md: "Voice" and the model host part of "Models and endpoints";
- `host/README.md`, `host/API.md` and docs/briefs/model-host.md.

## Goal

The model hosts serve dictation and her voice locally, in English and
Mandarin, contained like everything else on the host, so private threads
can use voice (principles 1 and 2).

## In scope

1. **A benchmark first**, on the 3090, before anything is wired in.
   - Voices: Kokoro-82M (its ONNX export), Chatterbox multilingual and
     CosyVoice 2. Measure the time to the first audio for one sentence, the
     VRAM used, and the licence. Make the same English, Mandarin and mixed
     sentences with each model, for the owner to listen to in the thread.
   - Dictation: Whisper large-v3-turbo and Voxtral Mini on vLLM, on
     English, Mandarin and mixed recordings. Measure the accuracy you see
     and the time per minute of audio. Try a Mandarin-first model (for
     example SenseVoice) only if both stumble on Mandarin.
   - The owner picks the voice model from the samples. The thread then builds
     with that choice.
2. **Dictation on vLLM:** safetensors models served through vLLM's
   `/v1/audio/transcriptions`, placed and scheduled like other vLLM models.
3. **A speech container** for the chosen voice model:
   - our image, built in CI and pinned by digest;
   - on the internal network only, with no internet;
   - temp files in `tmpfs`, and nothing logged;
   - an OpenAI-compatible `/v1/audio/speech` that streams audio;
   - reached only through `host-api`.
4. **The host API:**
   - `/v1/audio/transcriptions` and `/v1/audio/speech` are passed through
     at `chat` priority, cancelled when the client disconnects;
   - `/host/v1/models` reports `transcribe`, and `speak` with its voices
     and their languages;
   - a GPU's allowed servers gain `speech`;
   - the dashboard shows the speech models like the others.
5. **Downloads accept `.onnx`.** ONNX is a data format and runs no code
   when it loads. The checksum and record rules apply as for other files,
   and a model's voice files are checked the same way. Pickle files stay
   refused.
6. **Starter downloads** for the chosen voice model and for Whisper, and
   placement notes for pinning both on the 3090.

## Out of scope

- Routing, settings and the daemon's routes (Speech).
- The web UI (Web: voice).
- Voice cloning.

## Done when

- CI passes, including the host stack job with the speech container.
- Tests show that:
  - the speech routes pass through and cancel on disconnect;
  - discovery reports the speech capabilities;
  - `.onnx` downloads are accepted and checked, and pickles are still
    refused;
  - the speech container has no route out and writes nothing outside
    `tmpfs`.
- The owner has heard the samples and picked the voice model. The benchmark
  numbers are in this brief's handoff notes.
- `host/README.md` and `host/API.md` describe what exists.

## Handoff notes

- Done (#65): dictation on vLLM, the speech container (Kokoro's ONNX
  export, CPU or CUDA), the host API and dashboard, `.onnx` and voice
  downloads, `model_unavailable` for a dead model server, and the Windows
  benchmark (`host/bench/speech/`).
- Benchmark on the owner's RTX 3090 machine (Windows 11, second run
  2026-10-11; results in /mnt/project-files/audio/bench-results/round2/):
  - Kokoro v1.0 and v1.1-zh (Apache-2.0): first audio in 0.25 to 0.3 s on
    the GPU (about 1 GB of VRAM), 1.1 to 1.6 s on the CPU, for a 4.5 to
    5.8 s sentence.
  - Chatterbox multilingual (MIT): 12 to 20 s to first audio, about 4.5 GB
    of VRAM, and its Mandarin sample ran to 19 s with invented words.
  - CosyVoice 2 still failed to load (a missing package). Its weights are
    pickles the host refuses, so it was dropped.
  - Whisper large-v3-turbo: 4 s per minute of audio, 2.2 GB of VRAM, no
    errors on English and Mandarin, CER 0.03 on Kokoro 1.1 zm_010's mixed
    sentence. Voxtral Mini 3B: 36 s per minute, 8.9 GB, and it translated
    the English words in mixed sentences into Mandarin.
- The owner picked Kokoro v1.1-zh for the voice (2026-10-11), with Whisper
  large-v3-turbo for dictation. Their starters are in host/README.md.
