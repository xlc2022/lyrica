# Better local image edits

The owner's report (2026-10-26): her image edits are very poor, with bad
anatomy and either poor prompt adherence or poor prompting. A read-only
check of the dev deployment found that private and local-only threads
send edits to the **Qwen-Image-Edit 2509** starter on a ComfyUI host
(general threads use ChatGPT Images). That model dates from September
2025, and our workflow for it differs from ComfyUI's own template.

## What changes

1. **The 2509 workflow follows ComfyUI's template**
   (`image_qwen_image_edit_2509` in Comfy-Org/workflow_templates). It adds
   the `CFGNorm` step (strength 1) between the shift and the sampler, sizes
   the image with `FluxKontextImageScale` (the resolutions the model was
   trained on) instead of `ImageScaleToTotalPixels`, and gives references
   to both the positive and negative encoders at their own size (the
   encoder scales them). Its starter's settings stay as they are: 20 steps,
   CFG 2.5.
2. **A Qwen-Image 2.1 Turbo edit starter.** Qwen-Image 2.1 (September
   2026) edits from one checkpoint with better anatomy and prompt
   adherence; Turbo is its 8-step version. The new `qwen-image-2.1-edit`
   template follows ComfyUI's `image_qwen_image_2_1_turbo_image_edit`
   with its prompt enhancer off: `TextEncodeQwenImage21` (the image, up to
   three references, a 1024-pixel budget), `QwenImage21Cache`, a CFG 1
   guider and the Turbo's fixed 8-step sigmas, which live in the starter's
   defaults. The starter takes the bf16 diffusion model (14.2 GB), the
   int8 Qwen3-VL 8B encoder (9.4 GB) and the 2.1 VAE, from
   Comfy-Org/Qwen-Image-2.1. Scanning tells the 2.1 diffusion model,
   its VAE (Wan 2.2 layout, 64 latent channels) and the 8B encoder
   (`qwen3vl_8b` slot, apart from Krea 2's 4B) from the older ones. It
   edits only; sd.cpp hosts can't run it.
3. **Her edit instructions.** The tool tells her to give the one change
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
- Open: the edit size stays one megapixel; 2.1 can go to 2048 if the owner
  wants larger edits and the time it costs.
