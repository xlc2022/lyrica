# Brief: Krea 2 workflow and Civitai downloads

**Status:** Done (#802). **Thread:** Add Krea 2 to starter image models.
**Branch:** `claude/project-thread-vpx06a` (after #794, the Krea 2 Raw starter).

**Read first:** AGENTS.md, `host/README.md` (Images, Starters, Downloads),
`host/API.md` (recipes, downloads), docs/ux.md §6 ("Downloads and hub accounts").

## Goal

The operator picked a community Krea 2 Turbo workflow (published on Civitai as
"Krea2 Uncensored: Image-to-Prompt + Prompt Enhancer + 4K Upscaler") as the way
Krea 2 images should be made. The host's Krea 2 template gets the parts of it
that change the image, and the host learns to download from Civitai, where
that workflow's text encoder lives. Serves principle 1 (better images, the
same tool) through the host's known-good recipes.

## What the workflow does, and what the host takes

| Workflow part | Host |
|---|---|
| Krea2T-Enhancer model patch (prompt adherence, strength 1.5) | Taken: pinned custom node, recipe value `enhance` |
| `res_2s` sampler, `bong_tangent` scheduler, eta 0.7 (RES4LYF's ClownsharKSampler) | Taken: pinned RES4LYF, recipe values `sampler`, `scheduler`, `eta` |
| Second pass: 8 steps, denoise 0.2, same size | Taken: recipe value `refine` (the second pass's denoise; absent = no second pass) |
| Abliterated Qwen3-VL 4B text encoder (Civitai only) | Taken: a starter whose encoder comes from Civitai |
| Prompt enhancer, image to prompt (an LLM in ComfyUI) | Not taken: Lyrica writes the prompt herself and can look at images |
| SeedVR2 4K upscale | Already the host's `upscale` |
| Grain, colour, sharpen, Civitai metadata | Not taken: cosmetic |

## In scope

1. ComfyUI image: RES4LYF and ComfyUI-Krea2T-Enhancer at pinned commits,
   whitelisted, their Python dependencies locked. RES4LYF's sampler names
   without folders (its config written at build).
2. `host/workflows/krea2.json`: the enhancer between the model and the
   sampler when `enhance` is set; ClownsharKSampler when `eta` is set, else
   KSampler; a second sampler over the first latent when `refine` is set.
   Templates gain `_unless` (the node is left out when the value is set).
3. Civitai as a download source (`civitai`): a "repository" is a model id, a
   revision its version id, a path a file name; SHA-256 from Civitai's API;
   a Civitai token under Downloads → Accounts, sent only to civitai.com.
   Starter installs send each hub's token for its own parts.
4. A starter, Krea 2 Turbo Uncensored, with the workflow's defaults and its
   encoder from Civitai. Starter adoption checks every part, since it shares
   Turbo's diffusion file.
5. Docs: host/README.md, host/API.md, docs/guides/model-hosts.md, docs/ux.md
   (the Accounts row), DESIGN.md if it lists the hubs.

## Out of scope

The workflow's prompt enhancer and image-to-prompt; a Civitai browser in the
Download sheet beyond a link; Civitai LoRAs as starters.

## Handoff note

Done: everything in scope landed in #802. Hosts get the new nodes with a
ComfyUI image update.

Not yet checked: a real image on a GPU host with the Uncensored starter, the
enhancer and the second pass. If the second pass looks wrong, tune `refine`,
`refineSteps` and `refineEta` in the starter's defaults first.

Open: #799 adds Upload as a sixth Source option on Download image model; UI
review asked for a 390-wide screenshot of the six once both are in.

Shift: until this fix the template had no model-sampling node, so a recipe's
or a job's `shift` did nothing (images at every shift were identical). It now
patches the model with `ModelSamplingFlux` (Flux's shift, `max_shift` and
`base_shift` both the value, so it doesn't vary with size), after the enhancer
and before every sampler, and sd.cpp gets it as its flow shift. The template's
own default is 1.15, the model's, so a recipe that sets none makes the same
images as before. Other templates that take no shift (SDXL, FLUX, LTX-2.5,
MiniMax H3, Qwen-Image 2.1, P-H3-Image) name it in the job's `unused` instead.
