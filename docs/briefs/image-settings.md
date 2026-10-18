# Brief: Image settings and recipes

**Thread:** Image settings and recipes. **Branch:** `claude/image-settings-recipes-bpk70s`.
**Model:** Opus. **Depends on:** images (`images.md`), image providers
(`image-providers.md`), the first fix PR (#305: recipe names, list pruning,
streamed plan calls).

**Read first:** AGENTS.md, PRINCIPLES.md (6 and 8), docs/ux.md §6 ("Image
models, recipes and parts"), docs/models.md and the mockup, version 3
(https://claude.ai/artifact/5UBwvzWoH17JncEb7UCwFS), which the owner approved.

## Goal

The owner's first image tests found cloud and local image models handled in
two places, and neither was easy to follow. Principle 6: one place to see and
set every image model. Principle 8: no new page and no new control kinds.

1. **One list.** The Image models tab lists local recipes and cloud image
   models together, in a group per architecture (Z-Image, FLUX, Qwen-Image,
   SDXL, SeedVR2, …) and a Cloud group last. The architecture chips go; the
   group headings take their place.
2. **Role and Where.** At the upper right, a Role segmented control (All,
   Generate, Edit, Upscale) narrows the list to models that do that. Beside
   the search, Where (All, Local, Cloud).
3. **Parts under each architecture.** Each group ends with a collapsed
   "Parts for <architecture>" listing its LoRAs, VAEs, text encoders and
   other files. The Parts view stays for clean-up across every file.
4. **Parts in an open model.** Each part is a row: role, file, size, and at
   the right a link: Change on the text encoder and VAE, Remove on an added
   part (a LoRA), nothing on the base file. Below: **Add part**, Use for, and
   a **Delete model…** link that opens the existing confirm.
5. **Add part is a drawer** (dialogs only confirm): Part (LoRA, VAE, Text
   encoder), the files that fit this architecture with what uses each and its
   size, Download another…, and for a LoRA Strength (0 to 1.5) and "Save as a
   new model, keeping <name> as it is", checked. For a VAE or text encoder
   the drawer says it replaces the current one, and its button is Replace.
6. **ChatGPT Images.** A signed-in ChatGPT plan offers one image model,
   ChatGPT Images, instead of an image switch on each chat model: the plan's
   image tool picks its own image model. Its row has Generate and Edit
   checkboxes and Use for. The request goes through the plan's newest GPT
   model. Image task lists that named a plan chat model move to ChatGPT
   Images the first time it is found. At that time, an empty Image edits list in a
   general preset or the general column gets it too (the owner chose this,
   2026-10-18).
7. **Hosts and endpoints** loses the Image generation and Image editing
   switches. Keyed endpoints keep Generate and Edit, now only on Image models.
8. **Thread settings** gains Images, Image edits and Image upscaling, under
   the text models, the same words as the Tasks table. Each works like the
   rows above it, and recipes show by name.
9. **Starter recipes** (added by the owner, 2026-10-18): Download image
   model starts on the host's starter recipes. Picking one and **Add model**
   makes it; when parts are missing a dialog names them and their size, and
   nothing downloads until the user confirms.

Defaults picked: the Cloud group is last; masked edits on ChatGPT Images fall
through to the next model in the list, as before; the plan's driver model is
chosen by version number, not stored.

Fixtures, docs and examples use made-up host names (box, gpu, router).

## Out of scope

The image tool's error reporting and the Qwen tool failures (Lyrica's agent
loop thread); reorganizing download folders (the owner said not needed).

## Handoff

Done: built and merged in #318 (a8087f3), starters included; empty Image
edits lists filled in a follow-up PR.
Next: nothing here. The 400 and 413 image tool errors went back to the
coordinator; they are not this brief's.
