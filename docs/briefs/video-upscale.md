# Upscaling clips with SeedVR2

**Status:** built on `claude/project-thread-g9646h`; not yet run on a GPU.

The owner asked (2026-10-31) for SeedVR2 7B video upscaling. Her `image`
tool already upscaled images with SeedVR2 (3B and 7B starters), but nothing
could upscale a finished clip; the only video upscaling was inside
generation (LTX-2.5's latent upscaler; RIFE raises Wan's frame rate, not its
size). SeedVR2 is a video upscaler, and its node is already pinned in the
host's ComfyUI image, so no new download or node is needed. This serves
principle 1: sharper clips on the operator's own hardware, with no clip
going to a cloud model.

## What changes

1. **Host.** `workflows/seedvr2-clip.json` (`upscalesClipsFor: "seedvr2"`) is
   the SeedVR2 template's clip workflow: LoadVideo, GetVideoComponents, the
   upscaler in batches of 33 frames with 3 frames of temporal overlap and a
   padded last batch, tiled VAE encode and decode, the DiT offloaded to
   system memory between stages, then CreateVideo with the clip's own frame
   rate and sound, and SaveVideoWebsocket. A recipe of that template lists
   `upscale_video` too (worked out when listed, so existing recipes gain it).
   `POST /host/v1/videos/upscale` takes `recipe`, `video` (MP4, 64 MB),
   `scale`, `maxSize`, `colorMatch` and `seed`, refuses a clip whose upscaled
   frames times pixels pass 1.5 billion (system memory: ComfyUI holds every
   frame at 12 bytes a pixel), and answers as `videos/create` does.
2. **Seeds.** SeedVR2's seed input stops at 2^32 - 1, but image upscale sent
   seeds up to 2^47, which ComfyUI would refuse; both upscales now pick
   seeds in SeedVR2's range.
3. **Core.** Offerings from such recipes carry `upscalesClips`.
   `Models.upscaleVideo` uses the `image.upscale` list with need `clip`, so
   an image-only upscaler (an older host) or any cloud model is passed over.
4. **Tool.** The `image` tool's `upscale_video` action takes a workspace
   clip, optional `scale`, `maxSize` and `model`, runs in the background
   like other clips, saves a new clip in `videos/` and records the call as
   `image.upscale`. The chat's marker reads "Upscaling a clip"; the recipe
   facts line says "upscale clips".

## Out of scope

No new task list or thread drawer row: clips use the Image upscaling list.
No per-call batch size; `batchSize` and `temporalOverlap` can be set in a
recipe's defaults. No frame interpolation.

## Handoff

- Done: host route and workflow, core router call, tool action, chat
  marker, docs, tests (fake ComfyUI only).
- Next: run on mystria after the host updates (no rebuild of the ComfyUI
  image needed: the workflow is a host-api file): a 5 s 720p H3 or Wan clip
  at scale 2 on SeedVR2 7B, checking VRAM, system memory peak, time, the
  sound track and seams between batches. Then a short clip on lunasa's 3090
  with SeedVR2 3B, where batch 33 may need lowering in that recipe's
  defaults. Also confirm an image upscale now runs (the seed fix).
- Open: the scheduler sizes the recipe by its files, not its activations at
  batch 33; watch whether a clip upscale and another job collide on one GPU.
