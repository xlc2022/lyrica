# Better local image edits and images

**Status:** Merged as #597, #606, #607 and #615. Handoff notes below are history, except the open size question at the end.

The owner's report (2026-10-26): her image edits are very poor, with bad
anatomy and either poor prompt adherence or poor prompting. A read-only
check of the dev deployment found that private and local-only threads
send edits to the **Qwen-Image-Edit 2509** starter on a ComfyUI host
(general threads use ChatGPT Images). That model dates from September
2025, and our workflow for it differs from ComfyUI's own template. The
owner then asked for every image workflow to be compared with best
practice: the graphs for Z-Image, Krea 2, FLUX schnell and SeedVR2 match
ComfyUI's templates; her create prompts get no guidance, though ComfyUI's
Krea 2 template expands a prompt into a detailed paragraph first; and the
Qwen-Image and SDXL starters send an empty negative prompt.

## What changes

1. **The 2509 workflow follows ComfyUI's template**
   (`image_qwen_image_edit_2509` in Comfy-Org/workflow_templates). It adds
   the `CFGNorm` step (strength 1) between the shift and the sampler, sizes
   the image with `FluxKontextImageScale` (the resolutions the model was
   trained on) instead of `ImageScaleToTotalPixels`, and gives references
   to both the positive and negative encoders at their own size (the
   encoder scales them). Its starter's settings stay as they are: 20 steps,
   CFG 2.5.
2. **A Qwen-Image 2.1 Turbo starter.** Qwen-Image 2.1 (September
   2026) creates and edits from one checkpoint with better anatomy and
   prompt adherence; Turbo is its 8-step version. The new `qwen-image-2.1`
   template does both, following ComfyUI's
   `image_qwen_image_2_1_turbo_t2i` and `…_turbo_image_edit` with their
   prompt enhancers off: an edit's canvas comes from the image, a create's
   from width and height; `TextEncodeQwenImage21` (the image, up to
   three references, a 1024-pixel budget), `QwenImage21Cache`, a CFG 1
   guider and the Turbo's fixed 8-step sigmas, which live in the starter's
   defaults. The starter takes the bf16 diffusion model (14.2 GB), the
   int8 Qwen3-VL 8B encoder (9.4 GB) and the 2.1 VAE, from
   Comfy-Org/Qwen-Image-2.1. Scanning tells the 2.1 diffusion model,
   its VAE (Wan 2.2 layout, 64 latent channels) and the 8B encoder
   (`qwen3vl_8b` slot, apart from Krea 2's 4B) from the older ones. It
   doesn't run on sd.cpp hosts. Its weights are under the Qwen
   Research License (non-commercial: research and evaluation only); the
   guides say so, and the operator who installs it takes that on.
   It first took no mask; masked edits now run through the pinned LanPaint
   node (see the Handoff). A host's recipe listing says `mask` (from its
   template) and the router skips a recipe without one for a masked edit,
   going on down the Image edits list.
3. **Starter settings from ComfyUI's templates.** Qwen-Image takes CFG 4
   and the template's negative prompt (low resolution, deformed limbs and
   fingers, oversaturation, a waxy look); SDXL takes the template's
   negative (blur, bad anatomy, extra limbs, watermark). Recipes already
   installed keep their own defaults.
4. **Her create prompts.** The tool asks for one detailed paragraph:
   subject and action, then setting, light, framing and medium, keeping to
   what was asked, with text in the image only when wanted.
5. **Her edit instructions.** The tool tells her to give the one change
   and what must stay the same (face, body, pose, framing, light), to call
   the edited image image 1 and references image 2 and so on, and to check
   faces, hands and limbs against the source before showing a result.

## What stays

ChatGPT Images and cloud edits are unchanged. No new control: the
starter shows in the Image models starter list like the others.
Principles: 1 (a companion that helps well) and 8 (local first, within the
host's budget: the Turbo starter's largest stage is 14.9 GB on a 24 GB
card).

## Handoff

- Done: the brief, the two workflows, the starter, detection, the tool's
  wording and the docs, on `claude/project-thread-w6uyq4`.
- Done: the parts' checksums, pinned from CI's starters job.
- Next: after merge, the dev deployment's host needs an update and the starter
  installed, with the owner's yes, then her Image edits list in the
  Private column switched to it.
- Trial (owner's ask, 2026-10-28): masked edits on Qwen-Image 2.1 through
  the LanPaint ComfyUI node (2.2.0, pinned), following LanPaint's own
  Qwen-Image 2.1 masked-edit example on the Turbo's sigmas. The dev
  deployment compared it with 2509 on four masked edits: about 53 s
  against 115 s, the same quality inside the mask, and the rest of the
  image kept exactly (2509 redraws the whole frame). The owner chose to
  keep it. The mask now grows by 24 pixels, as a faint frame was left at
  an old outline on the mask's edge, and the result blends into the
  original over 31 pixels (LanPaint's default 9 left a visible seam).
- Done (2026-10-28): edit guidance from the deployment's tests. Saying
  what goes fixed a leftover object; one big change per edit kept a
  person's identity where a whole-scene change redrew faces; passing the
  edited image as a reference too changed nothing.
- Done (owner's ask, 2026-10-28): a masked edit could leave a lighter
  panel where the mask was. The dev deployment showed it is the model
  redrawing the old object's outline, more strongly with more steps,
  thinking or Lambda, because the encoder sees the original. Prompt First
  and a softer mask edge changed nothing. Leaving the image out of the
  encoder removed the panel and, with the instruction written as the
  finished scene, gave the best result, but it redraws a thing being
  recoloured (a coat's cut, the clothes beside it). So it's a choice per
  edit: `replace` for a new object, off for changing one.
- Done (owner's ask, 2026-10-28): likeness work, as hosted image models do
  it (other angles, outfits, builds, a relative), tested on the dev
  deployment with a made-up person on 2.1 Turbo. Naming "the person from
  the reference images" kept identity better than an image number; one
  new angle per edit kept it; a turnaround as one wide create gave front,
  profile and back. A garment's own photo reproduced it exactly, where
  words gave a generic one. "More muscular" barely changed the build, so
  build changes need strong wording. A relative made with the person's
  photo came out as the same person, so a relative gets no photo, only the
  shared traits and the differences. This became one tool guideline.
- Next: a personal LoRA for a closer likeness (DESIGN, photos-of-me,
  "Later"). ai-toolkit trains Qwen-Image 2.1 LoRAs. No face-ID adapter
  exists for 2.1; its own multi-image encoder does that job.
- Open: the edit size stays one megapixel; 2.1 can go to 2048 if the owner
  wants larger edits and the time it costs.
