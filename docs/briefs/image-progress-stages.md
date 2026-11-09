# Image progress past sampling

**Principle:** 1 (the placeholder says where the job really is), 8 (no new
control, no new route; one field on the job read). Asked for on 2026-11-09:
the image placeholder often sat at 95% for minutes, most of all on Krea 2.

**Status:** Merged as #874 (5eefd536), 2026-11-09.

## Why it sat at 95%

The host counted only samplers from a fixed list. Krea 2's refine pass is
RES4LYF's `ClownsharKSampler_Beta`, which wasn't on it, so the bar reached
95% at the end of the first pass and stayed there through the upscale, the
refine and the decode. Even with every sampler counted, decoding and
upscaling report no sampler steps, so the last 5% gave no sign of life.

## What

- **Host** (`host/src/comfy.ts`, `samplingProgress`): a sampler is one of
  ComfyUI's own or a custom node named a sampler that takes a latent (not a
  picker such as `KSamplerSelect` or `ClownSampler_Beta`). Samplers count by
  their `steps` input; a cached one counts as done (`execution_cached`).
  After sampling, a node that reports steps (tiled decode, model upscale)
  fills 95% to 99%. While a decode, upscale or video node runs after sampling
  began, the job read says `stage`: `decoding`, `upscaling` or `encoding`
  (host/API.md, "Job progress"). The same sampler test feeds `samplingTime`,
  so Status's image speed now counts Krea 2's refine pass too.
- **Core:** `JobProgress.stage`, only those three words.
- **Daemon:** `Making.stage`, passed through (`progressOf` in clips.ts).
- **Web:** the pill reads "95% · Decoding" (Upscaling, Encoding); the card's
  value text "95%, decoding". No new chrome.

## Out of scope

- A stage before sampling (model loading, prompt encoding, Krea's
  image-to-prompt step): the pill shows the elapsed time then, as before.
- Weighting stages by measured time per recipe.
- stable-diffusion.cpp progress.

## After merge

Every host needs **Update…**, and Lyrica a rebuild. A host without this
keeps reporting as before; Lyrica shows the percent alone.
