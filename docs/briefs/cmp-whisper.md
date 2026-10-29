# Brief: dictation through whisper.cpp on a CMP 100-210

**Status:** Merged as #477 (5563b85); danube retested in #483.

Owner: the Agent loop thread. Tests: the danube thread, on danube.

## Why

Dictation runs Whisper on vLLM, whose PyTorch has no kernels for the CMP
100-210's sm_70 ("no kernel image is available"), so a host whose GPUs
are all CMPs can't dictate at all. whisper.cpp is ggml, like llama.cpp and
sd.cpp, and builds for sm_70 with `GGML_CUDA_FORCE_MMQ`. On danube
(v1.9.5, flash attention on, the large-v3-turbo models from
`ggerganov/whisper.cpp`):

| Model | 36 s English | 180 s English | 16 s Mandarin | Load |
|---|---|---|---|---|
| fp16 | 2.3 s | 10.2 s | 1.3 s | 8.7 s |
| q8_0 | 1.7 s | 6.1 s (29x real time) | 1.0 s | 4.8 s |
| q5_0 | 1.7 s | 6.4 s | 1.0 s | 3.2 s |

Transcripts were accurate in both languages. Flash attention off was
5-15% slower.

## What

1. **The server.** `host/whispercpp/Dockerfile` builds `whisper-server` at
   a pinned commit (v1.9.5, `d1be6fde`), static ggml, with
   `GGML_CUDA_FORCE_MMQ=ON`, into the CUDA runtime image. It is a third
   prebuilt image, built for the same CUDA list as llama.cpp's since it may
   run on any GPU of the host
   (`host/prebuilt.sh`, `cmp-images.yml`). `install.sh` adds
   `compose.whisper.yaml` on a host with a CMP. Like sd-server, it runs as
   10001, on the models network only, logs nothing and saves nothing.
2. **One model at a time.** whisper-server takes its model at start-up,
   so a small supervisor (`whispercpp/gate.sh`, as `sdcpp/gate.sh`)
   starts it for the model and GPU host-api names in
   `serving/whisper.json`, with `--flash-attn` and `--inference-path
   /v1/audio/transcriptions`, and stops it when the model unloads.
3. **The model.** host-api lists a whisper.cpp model file (`ggml-*.bin`
   whose first four bytes are ggml's magic) as a dictation model on the
   `whispercpp` server, placed on one GPU like a voice and under the GPUs'
   speech setting. Only the host's own dictation server's models are
   listed, and the status says which it is (`dictation`). fetch accepts
   such a `.bin` after checking the magic (today every `.bin` but a
   voice is refused as a possible pickle). The starter download is
   large-v3-turbo q8_0.
4. **Routing.** `/v1/audio/transcriptions` goes to whisper-server for its
   models, as it goes to vLLM for Whisper safetensors; the daemon sees
   one more dictation model and needs no change.

## Out of scope

whisper.cpp on hosts without a CMP (vLLM stays), streaming dictation,
voice activity detection, and translation.

## Checks

- host tests: the library lists a whisper.cpp file and refuses one with
  the wrong magic; fetch keeps refusing other `.bin`; the backend writes
  `whisper.json` and fails a load whose server exits; a transcription
  reaches the right server.
- On danube: install from the published image, download the starter,
  dictate English and Mandarin, and compare with the table above.
