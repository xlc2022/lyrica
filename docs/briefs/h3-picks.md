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
- **Scan**: P-H3-Image by its 16-wide timestep table (w6a8 repacks of H3
  carry an 8-wide one); MiniMax-H3-Image's diffusion model (timestep table, no audio
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

## GPU run (2026-11-14)

The run on mystria and lunasa settled what was open; its report is
`h3-gpu-run-2026-11-14.md` in the project files.

- Every int8 starter works on mystria at its defaults; MiniMax-H3-Image
  takes 5 to 10 s for 4 MP. Singularity chains smoothly to 16 and 60 s.
- The realism LoRA is 0.7 on `minimax-h3` and 0.5 on `minimax-h3-ref2va`
  (template slot `strength`): at 1 it smears faces, or haloes the hair.
- Lunasa runs MiniMax-H3-Image w4a8 (9 s warm) and Turbo w6a8 5 s clips;
  a 16 s chain was killed by earlyoom twice, so the w6a8 and w4a8 video
  starters set `longestSeconds` 5.
- P-H3-Image and Krea 2 work on ComfyUI 0.45.3.
- Singularity runs at 6 steps with its speed LoRA at 0.7 (slot `strength`), as
  its repository's renders do: 4 steps at 1 melted a running dog's legs.
- fal's card says strength 1; the 0.7 and 0.5 above stand on these runs.

## Handoff

- 2026-11-14: built on `claude/project-thread-l9wv1m`. Next: PR review
  (host, ComfyUI bump), then the Lunasa GPU run and tuning of defaults.
- 2026-11-15: GPU run done (above); realism strengths and the 5 s cap are
  in. Nothing open.
