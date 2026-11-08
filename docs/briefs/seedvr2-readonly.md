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

## Handoff

Done: the Dockerfile line and README sentence; PR opened 2026-11-08.
Next: the first GPU run of an image upscale on a host with a SeedVR2 recipe
installed (lunasa fits the 3B), which also tests the seed-range fix from
PR #712 and clip upscaling, neither run on a GPU yet.
Open: none.
