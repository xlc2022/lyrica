# Brief: GLM 5.3 Flash NVFP4 on SGLang

**Status:** built on branch `claude/project-thread-q9ev6m`; a trial, to be
removed if it serves worse than the Q4.

Owner: the "Run GLM 5.3 Flash NVFP4 on SGLang" thread. Tests: the two-card
Blackwell host (two RTX PRO 6000, 96 GB each).

## Why

The GLM 5.3 Flash Q4 starter (UD-Q4_K_XL, 199.7 GB) doesn't fit two 96 GB
cards: about 28 GB of its experts stay in system RAM, and it generates at
about 28 tok/s (the "GLM 5.3 Flash as a starter" brief). A 4-bit NVFP4 build
made for exactly these cards fits them whole. Its author measured about
192 tok/s generating, with MTP drafting, and about 6,100 tok/s reading a
prompt, on two RTX PRO 6000 Max-Q cards
([BENCHMARKS.md](https://github.com/ormandj/sglang-glm53-flash-sm120/blob/v0.6.1/BENCHMARKS.md)).
Principle 1: a model she talks with this month, faster on the same host.

## The model and its server

- **Model:** `ormandj/GLM-5.3-Flash-W4A16-NVFP4-K32-Experts-FP8-WO` at
  `ee0989a944b0e213589191d7fca63af825a0741e`, 177,995,252,856 bytes in
  90 shards. Routed experts are NVFP4 weights with BF16 activations;
  attention and shared experts are FP8 weights; the MTP layer and the vision
  tower stay at the source's precision. Its config says
  `quantization_config.quant_method` `modelopt_mixed`, which no released
  vLLM or SGLang loads (its card).
- **Server:** SGLang, as the image
  `ghcr.io/ormandj/sglang-glm53-flash-sm120:v0.6.1`
  (`sha256:10d3a79629420d9c1953cbc2e25a8395364fe7a40a77d039444bb8a3e4b10dd9`,
  17.5 GB, built from the repository's commit 0e1d1e86, which differs from
  the v0.6.1 tag only in docs and the launchers' image tag). It pins an
  SGLang nightly of 2026-10-10 with about 25,000 lines of the author's
  patches, compiled for sm_120 only. Its flags are those of the author's
  `examples/serve-glm53-flash.sh` at v0.6.1 (the TP2 profile).
- **Safety review (2026-11-18):** the launcher is a plain `docker run`, the
  patches are kernels, scheduler changes and tests, and nothing in them
  reaches out beyond the server calling its own `/freeze_gc` at start. The
  image isn't signed. Here it runs like every model server: on the models
  network with no route out, its output dropped once it answers, no logs, no
  core dumps.

## What

1. **`install.sh --sglang`** (`--no-sglang` to take it out again), kept in
   `.env` as `SGLANG=1`. On an NVIDIA host with an sm_120 GPU it adds
   `compose.sglang.yaml` (and `compose.sglang.cdi.yaml` with CDI): the
   `sglang` service, the `sglang-status` and `sglang-cache` volumes (its
   compiled kernels, which take 10 to 20 minutes the first time), and
   `SGLANG=on` for host-api. Elsewhere it says why and leaves it out.
2. **The supervisor** (`host/vllm/supervisor.py`) also runs SGLang, chosen
   by `ENGINE=sglang`: the same file protocol, `/serving/sglang.json` in and
   `/status/sglang.json` out, with the TP2 profile's arguments.
3. **The backend.** `Vllm` takes a name and a state file, and the host makes
   a second one for SGLang. A safetensors model whose quantization method is
   `modelopt_mixed` is served by SGLang (`engine: "sglang"`); a host
   without SGLang leaves it out of its lists. It is otherwise a vLLM model:
   GPUs that allow vLLM allow it and it has a memory share. Lyrica and the
   host dashboard name its server "GLM-SGLang" (`engine` on the models
   list, the starters and the serving settings). Its placement is tensor parallel across its GPUs whatever their
   names, with a share of 0.99 unless set, as the profile was measured.
4. **The starter.** "GLM 5.3 Flash NVFP4", listed only on a host with
   SGLang, needing 180 GiB across the GPUs that allow vLLM.

## Out of scope

- Any other model on SGLang: the image is built for this one.
- A NixOS module option: on NixOS, run `host/install.sh --sglang` once, as
  for the other flags.

## Open

- Whether the profile fits mystria's mixed pair (one Workstation card, one
  Max-Q) at the context Lyrica asks for, and its speed there over PCIe x8.
- Quality against the Q4 on the same prompts.

## Handoff

Done: this brief, the flag, the service, the supervisor, the backend, the
starter and their docs. Next: merge, install on the two-card host with
`--sglang`, load, compare with the Q4. If it's worse, remove it all.
