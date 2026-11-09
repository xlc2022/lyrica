# SeedVR2 upscaling in the read-only ComfyUI container

Principle 8 (budgets: nothing new, one line in an image) and the thesis:
upscaling that the UI offers has to work.

## The bug

Every `upscale` and `upscale_video` job failed with `ComfyUI failed to make
the image (SeedVR2VideoUpscaler: OSError)`, on every host alike, the first
time one was run on a GPU (2026-11-08). The pinned SeedVR2 node loads its
models inside `SeedVR2VideoUpscaler.execute`; its first step,
`download_weight`, begins with `os.makedirs(<models dir>/SEEDVR2,
exist_ok=True)`, uncaught. ComfyUI's models folder in our image is
`/opt/comfyui/models`, with no `SEEDVR2` in it, and the container runs
`read_only` with only `/tmp` and `/triton` writable, so the call raises
`Errno 30` before any model file is read. The host's links in
`/serving/seedvr2` were never the problem: the node searches every path
registered for the `seedvr2` type (our `extra_model_paths.yaml`) first.

## The change

`host/comfyui/Dockerfile` makes `/opt/comfyui/models/SEEDVR2` a link to
`/serving/seedvr2`, so `makedirs` finds it and the node's fallback folder
holds the same files. The node's validation-cache write into that folder
is inside its own try/except and fails silently, so nothing else needs to
be writable. `host/README.md` says so in the ComfyUI paragraph.

Hosts pick it up with their next update (`Update…` on the host's card, or
`git pull && host/install.sh`), which rebuilds the ComfyUI image.

## Memory

The first run after that fix (2026-11-09, a 4x upscale of a ~1 MP image)
ran out of GPU memory on every SeedVR2 recipe, 3B and 7B alike. The host
turns `scale` into a target short side of min(short × scale, 4096), so 4x
of a 1 MP image is a 16 MP output, and `workflows/seedvr2.json` ran the
whole frame through the VAE untiled with every model on the GPU, unlike
`seedvr2-clip.json`, which already tiled the VAE and offloaded between
phases. The host budgets a recipe's file sizes (`recipeSize`), not a job's
activations, so the scheduler placed it and ComfyUI failed mid-job.

The host's status for that run showed why it was placed at all: the 7B
recipe had a saved measurement of 0.69 GiB on a GPU already 74 GiB full.
The scheduler measures an image recipe as the GPU's use after its first
job minus before, but the SeedVR2 node drops its models at the end of
every job (`cache_model` is off), so the reading is the CUDA context
alone, and from then on the scheduler placed SeedVR2 next to anything.

Changes: a template whose workflow loads its own parts (`loaders:
"template"`, SeedVR2) is never measured and its estimate, the file sizes,
stands; a host drops such saved measurements when it starts. The
still-image workflow takes the clip workflow's memory settings
(tiled VAE encode at 1024 and decode at 768 with 128 overlap, CPU offload
for the DiT, VAE and intermediate tensors; the node's own options, harmless
on big cards); a ComfyUI `OutOfMemoryError` answers "ComfyUI ran out of GPU
memory making the image (<node>). A smaller size, scale or maxSize fits."
instead of only the error type, still `model_unavailable`, so Lyrica's
fallback and model-down window are unchanged. 2x is the recipe default and
the right first ask; 4x of a 1 MP image won't fit a 24 GB card.

## Handoff

Done: the Dockerfile line and README sentence (PR #842, merged 2026-11-08);
the memory settings and the out-of-memory message (PR, 2026-11-09).
Next: a 2x run on a 24 GB host after the hosts rebuild, and the peak the
torch message reports, to decide whether `blocks_to_swap` is needed there
and whether the host should cap `resolution` by the GPU's room.
Open: clip upscaling and the seed-range fix from PR #712 still have no GPU
run.
