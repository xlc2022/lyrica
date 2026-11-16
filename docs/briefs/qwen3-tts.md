# Brief: Qwen3-TTS voices for Read aloud

**Status:** Built (2026-11-16), waiting on its tests on danube and lunasa. Owner: the read-aloud thread.

## Why

Kokoro reads quickly but sounds flat, and it has no way to show emotion.
The owner tested Qwen3-TTS against it on danube's unlocked CMP 100-210 and
chose it for her voice, asking for a choice of voices: Friend, Sohee,
Vivian and Ryan. Per principles 1 and 2, the voice stays local and private,
like Kokoro.

Measured on danube (sm_70, fp16, sdpa attention, faster-qwen3-tts 0.5.4
with CUDA graphs, streaming 8 steps a chunk):

| Model | First audio | Time per second of audio | GPU memory | Load |
|---|---|---|---|---|
| 1.7B CustomVoice | 0.43 s | 0.6 s | 4.9 GB | 16 s + 12 s warm-up |
| 1.7B Base (clone) | 0.45 s | 0.6 s | 5.6 GB | about the same |
| Kokoro v1.1-zh | | 0.06 s | 2.4 GB | 7 s |

Rejected on the same run: the official `qwen-tts` package (2.5 s per
second of audio), and llama.cpp's `llama-tts` with the Base GGUF (7.5 GB,
no streaming, no instructions, a reload on every call). Samples:
the danube thread's listening page; working builds and BUILD.md are kept on
danube in `qwen3-tts-test/`.

## What

1. **A second speech server, `host/speech-qwen/`.** Python 3.12 with
   PyTorch 2.14.1 and faster-qwen3-tts 0.5.4 (MIT), every package pinned
   with its hash, as `host/speech/` does. It speaks the same small API as
   the Kokoro server (`/health`, `/load`, `/unload`, `/reset` and a
   streaming `/v1/audio/speech` of 16-bit mono PCM at 24 kHz), runs as
   10001 on the models network only, logs nothing, writes only to its
   tmpfs and exits when it lets go of its GPU. Two flavours:
   - `cu126`: PyTorch's last CUDA 12.6 wheels, which still carry Volta
     kernels. It covers a CMP (sm_70) through Hopper, the 3090 included.
   - `cu130`: Turing and newer, Blackwell included.
   `install.sh` picks `cu130` when the host has a Blackwell card and
   `cu126` otherwise. Like Kokoro's Volta build, one host can't serve both
   a CMP and a Blackwell card with it. Models load in fp16 on Volta (it has
   no bf16) and in bf16 elsewhere, with PyTorch's own attention (sdpa).
   Torchaudio has no 2.14 build, so 2.11.0 is installed without its
   dependencies, as on danube. CUDA graphs are captured at load (the
   warm-up), so a load takes about 30 s.
2. **Prebuilt images.** CI builds and publishes both flavours with
   `host/prebuilt.sh`, as it does the CMP images, so an install or update
   pulls them instead of downloading 3 GB of wheels to build. A host
   builds locally only when the pull fails.
3. **The models.** host-api lists two kinds of Qwen3-TTS folders
   (`config.json` with `model_type` `qwen3_tts`, safetensors weights and a
   `speech_tokenizer/`) as `speak` models on the `speech` server:
   - **CustomVoice**: its voices are the speakers in its config (Vivian,
     Serena, Uncle_Fu, Dylan, Eric, Ryan, Aiden, Ono_Anna, Sohee).
   - **Base**: its voices are the clips built into the image,
     `host/speech-qwen/voices/<name>.wav` with `<name>.txt` holding its
     transcript. The first is **Friend**, a voice designed with Qwen's
     VoiceDesign model on danube (synthetic, no real person's voice).
   Every Qwen voice reads Mandarin and English, so each is listed under
   both `en` and `zh`, and the existing per-language voice selects offer
   them all. The server reads a piece as Chinese when it has Han
   characters and as English otherwise, and leaves mixed text to the
   model.
   The Speech backend sends a Qwen model's load and requests to the new
   server, and Kokoro's to the old one; placement, GPU settings and the
   scheduler are unchanged (`server: "speech"`).
4. **Starters.** Qwen3-TTS 1.7B CustomVoice and Qwen3-TTS 1.7B Base, from
   `Qwen/…` at pinned revisions, beside Kokoro. Both are Apache 2.0 and
   safetensors.
5. **Speed.** Qwen3-TTS has no speed input. The server stretches its audio
   to the asked speed without changing the pitch (overlap-add), so the
   voice's Speed setting keeps working.

## Out of scope

- Emotion instructions per message. CustomVoice takes them, but choosing
  one needs a design of its own (who writes it, and where it is shown).
- Adding or recording new clone voices in the UI. A new built-in voice is
  a clip and transcript in `host/speech-qwen/voices/`.
- VoiceDesign as a starter.
- vLLM-Omni. It can't run on a CMP without our own Volta build of vLLM.

## UI

At first no new control: the model's Settings drawer has a Voice select per
language. Since then the thread drawer has a **Voice** select under Read
aloud, listing Friend and the CustomVoice speakers together, picking the
model with the voice (docs/ux.md, Thread settings).

## Done when

- Read aloud with each Qwen model on lunasa (3090) and danube (CMP) streams
  audio in each voice, in English, Mandarin and mixed text, at speeds 0.8,
  1 and 1.25.
- Tests cover discovery of both Qwen folder kinds, the backend's routing
  by model, the server's refusals, and that nothing is logged or written.
- host/README.md, host/API.md, docs/models.md, docs/guides/model-hosts.md
  and this brief describe what exists.

## Handoff notes

- Built in one PR: the server, both images and their publishing,
  discovery, routing and the starters. The size placement uses is the
  files' size plus a buffer per kind (0.3 GiB CustomVoice, 1 GiB Base),
  set from danube's numbers, not measured on load.
- The image build was checked only by installing its locked packages;
  the first CI run of `cmp-images.yml` builds it for real.
