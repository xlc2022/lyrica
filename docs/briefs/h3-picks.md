# More MiniMax H3: its own picture model, community models, LoRAs

**Status:** built, awaiting review and a GPU run.

The operator picked (2026-11-14) from a survey of H3 finetunes and quants:
MiniMax-H3-Image, H3 LoRAs recognised by their tensors, a 24 GB-sized H3
Turbo starter, and support for two community models (Cobijada H3 Hybrid,
Singularity v2). This serves principle 1: more local models she can make
pictures and clips with on the operator's own hardware.

## What changed

- **ComfyUI 0.45.3** (was 0.44.2), the first with
  `MiniMaxH3ImageConditioning`; its frontend, templates and comfy-kitchen
  move with it in `requirements.in`.
- **`minimax-h3-image` template**: P-H3-Image's graph on MiniMax's node,
  H3's 32B text encoder, no sigma shift, 6 steps on a scheduler (Comfy-Org's
  official graphs: euler, simple, CFG 1, about 4 MP). The prompt expander
  in those graphs is left out.
- **`minimax-h3-ref2va` template**: video and animate on a ref2va
  checkpoint; the image is a guide at frame 0 (`MiniMaxH3AddGuide`), as the
  clip editor anchors its clip. Its continuation
  (`minimax-h3-ref2va-continue.json`) is H3 Turbo's with the reference
  node in place of the first-frame one, so it chains to 60 s.
- **Scan**: MiniMax-H3-Image's diffusion model (timestep table, no audio
  stream) and VAE (decoder 1024 wide inside); H3 LoRAs by `qkv_proj` plus
  `token_refiner` keys; an fl2va LoRA fits ref2va recipes.
- **Proposals**: where an arch has two templates, the one whose LoRA slots
  the scanned files fill most wins (VFX Edit LoRA present: editor).
- **Starters**: `minimax-h3-image` (int8), `minimax-h3-image-w4a8`,
  `minimax-h3-turbo-w6a8`, `cobijada-h3-hybrid` (+ `-w4a8`),
  `singularity-h3-v2` (+ `-w4a8`), and a `-realism` twin of each video one
  with fal's Realism People LoRA as a `realism` slot part. Pins from the
  Hugging Face API.
- **Trigger words**: a template LoRA slot may name a `trigger`; the host
  starts every prompt with it when the recipe has that LoRA (r34l1sm).
- **Proposals**: a scanned model takes the defaults of the starter that has
  its file (several H3 starters share a template); only a missing *speed*
  LoRA is listed as needed.

## Open questions

- Nothing here has run on a GPU, and the ComfyUI bump is untested on the
  older templates. The Lunasa run should cover MiniMax-H3-Image (create,
  edit), Turbo w6a8 on the 3090 (does it fit at 1344×768 with 30 GB RAM?),
  Cobijada, Singularity (text and animate), a P-H3-Image and Krea 2 image,
  and an H3 Turbo clip.
- Singularity's chaining (16 s join, 60 s, extend) needs tuning on
  mystria, as H3 Turbo's was (#695, #700, #711).
- The realism LoRA's strength (fal says 1, or 0.6 to 0.8 lighter) is for
  the GPU run to settle.
- Large models (int8 starters, Singularity chaining) run on mystria; w4a8
  and w6a8 on lunasa.

## Handoff

- 2026-11-14: built on `claude/project-thread-l9wv1m`. Next: PR review
  (host, ComfyUI bump), then the Lunasa GPU run and tuning of defaults.
