# Making and editing pictures with P-H3-Image

**Status:** built, in review.

The owner asked (2026-11-08) for "the MiniMax H3 editor", then added that
they also meant the H3 image editor: **P-H3-Image** (PrunaAI), a fine-tune
of MiniMax H3 for still pictures that creates and edits, published for
ComfyUI as `PrunaAI/P-H3-Image-Comfy`. This serves principle 1: another
local model she can make and change pictures with on the operator's own
hardware. The clip editor from the same ask is [video-edit.md](video-edit.md).

## The host

- **ComfyUI 0.44.2** in `host/comfyui/Dockerfile` (was 0.43.1), the first
  with P-H3-Image's nodes (`PH3ImageConditioning`); its frontend,
  templates and docs packages move with it in `requirements.in`. The rest
  of the change between them is additive.
- **A template** `host/workflows/p-h3-image.json`, arch `p-h3-image`,
  doing `create` and `edit` with up to 3 references, ComfyUI's own nodes
  only, as Pruna's example graphs: `PH3ImageConditioning` (which writes
  "Edit <Picture 1>." before an edit's prompt itself), H3's sigma shift at
  1/1, `ManualSigmas` with Pruna's 8 sigmas from the recipe's defaults,
  euler, `BasicGuider` (no CFG, no negative prompt). An edit scales the
  picture to `editMegapixels` (4) first and keeps its shape.
- **One image per request:** its latent can't be batched, so the template
  has no `$count` and the host refuses `count` above 1 for any template
  without one.
- **Scan:** an H3-shaped diffusion file with `adaln_t_table` is
  `p-h3-image`; a Qwen3-VL 4B with `text_connector.proj.weight` is the
  text encoder slot `ph3` (so it isn't offered to Krea 2); a VAE whose
  `decoder.proj_out` has 768 rows is `p-h3-image`'s.
- **Starters:** `p-h3-image` (int8 diffusion and text encoder, about
  29.5 GB, about 31 GB of VRAM at its peak) and `p-h3-image-w4a8` (about
  20 GB, about 21 GB), both with the int8 VAE. HF is blocked from the
  sandbox, so their checksums are pinned from the CI starters job.

## Lyrica's side

Nothing new: they are image recipes like Qwen-Image 2.1, in the Images and
Image edits lists.

## Open questions

- Not yet run on a GPU. The first run should check an edit and a create
  on the w4a8 starter on a 24 GB card and the int8 one on the workstation,
  and the time per image.
- Licence: the MiniMax H3 Community License, as for H3 Turbo, which the
  owner already chose to use.

## Handoff

- 2026-11-08: built on `claude/project-thread-k2qybw` with the clip
  editor, in the same PR; checksums pinned from CI. Next: PR review (the
  ComfyUI bump), a GPU run after the host update.
