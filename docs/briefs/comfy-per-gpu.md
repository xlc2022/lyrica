# Images and videos on every image GPU

**Status:** Merged as #697 (21a9bf53); not yet run on a real two-GPU host.

The owner asked (2026-10-30) whether a host with two GPUs can run two
MiniMax H3 clips at once, one per GPU, and the same for images. It
couldn't: the host ran one ComfyUI on one GPU (`COMFY_GPU`), one job at a
time, so a second clip waited behind the first while the other GPU sat
idle. This serves principle 1: clips and images come back sooner on the
operator's own hardware.

## What changes

1. **`COMFY_GPU` takes a list** (`COMFY_GPU=0,1`). One stays the default.
2. **One ComfyUI per listed GPU, in the one `comfyui` container.**
   gate.py starts and stops each on its own, as host-api asks: GPU `g`'s
   ComfyUI reads `serving/comfyui-<g>.json`, writes
   `status/comfyui-<g>.json`, listens on port 8188 plus its place in the
   list, and has its own input, output, temp and user folders. Each checks
   its own GPU's kernels, so one GPU it can't run on doesn't stop the other.
3. **host-api has a ComfyUI per GPU.** Each runs one job at a time, as
   before. A job goes to the image GPU with the fewest jobs; on a tie, to
   one that already has its recipe loaded, then the first listed. A
   chained video stays on its GPU from the first clip to the last. With
   several image GPUs, a recipe is a separate scheduler model per GPU
   (`recipe:<id>@gpu<g>`), so the scheduler accounts for each copy's
   memory on its own GPU; with one, its ID stays `recipe:<id>`.
4. **A recipe is too big** only when it fits on none of the image GPUs.
5. **stable-diffusion.cpp** (the CMP 100-210 path) keeps one GPU: the
   first listed.

Out of scope: two copies of one text model (llama.cpp's parallel slots
already serve several requests at once); moving a queued job to the other
GPU when that one frees first.

## Memory

Each ComfyUI holds its recipe's parts on its own GPU (H3 Turbo is about
42 GB, so one copy fits on each 102 GB card). Both read the same files, and
the page cache keeps one copy of them. A running clip's decoded frames are
the larger cost in system RAM: about 5 GB for 16 s at 1344×768, about
18 GB for 60 s. Two clips fit in 96 GB beside a modest System RAM
allowance; this is an estimate until measured on the host.

## Handoff note

Done: gate.py runs a ComfyUI per GPU (checked by hand with two fake
servers: ports, per-GPU env, folders emptied on stop); host-api's
`ComfyGpus` backend and job placement in `Images.pick`; a host test with
two GPUs running two jobs at once; README, API, DESIGN, the model-hosts
guide. Next: the operator sets `COMFY_GPU=0,1` on the two-GPU host and runs
`host/install.sh`, then runs two H3 clips at once and checks peak system
RAM. Open: a queued job doesn't move to the other GPU when that one frees
first.
