# Image model speed in Status

**Principle:** 1 (what she shows is a fact she measured), 8 (no new control,
no new column). Asked for on 2026-11-09: the Model calls table in
Administration → Status showed **—** in Speed and Prompt for every image
model, since only text turns record a pace.

## What

An image or video model's Speed cell shows its median **seconds per image**
(or per clip), measured on the host from ComfyUI's own sampler events, in the
place the dash was. No new column; it/s, steps and size live in the tooltip,
since it/s alone depends on resolution, step count and batch and says little
across models.

- **Host** (`host/src/comfy.ts`, `samplingTime`): a sampler runs from its
  `executing` event to its last `progress`; the job's `sampling` is the sum
  over the samplers that lead to the output, with their steps in all. Waiting,
  model loading, encoding and decoding stay out. Image and video answers carry
  `sampling: { seconds, steps }` (host/API.md); a chain sums its clips. Nothing
  for stable-diffusion.cpp or a workflow without a sampler.
- **Lyrica** (`core/src/models`): `imageAt`/`videoAt` read `sampling`;
  the image tool calls `recordSampling` with the id `recordCall` returns, which writes
  `sampling_ms`, `steps`, `images`, `pixels` on the call row (user schema
  step 23, nullable columns, expand only). Never the prompt or the picture,
  and no `pace`, so it enters no tok/s and no GPU time.
- **Daemon** (`model-facts.ts`): per offering, medians over the measured rows
  of seconds per image, steps per image, steps per second and pixels, with
  the sample count and the unit (clip when most rows are video). Rows under
  50 ms say nothing.
- **Web** (`ModelCallFacts.tsx`): Speed shows "17.3 s/image" where no tok/s
  was measured; the tooltip names the measurement, "8 steps · 1 MP · 0.5
  it/s", and the sample count; Prompt stays **—**, "An image model reads no
  prompt tokens."

A host without this change reports no `sampling`, so its models keep **—**
until it is updated; Lyrica needs the rebuild for the schema step.

## Out of scope

The "Speed per call · tok/s" chart stays a text chart. (The Output column
later showed the images or clips an image model made in place of 0 tokens:
`made` on `ModelCallFacts`, from each call's recorded `images`.) Cloud image providers report no timing.

## Status

Built in this brief's PR (host, core, daemon, web, docs). Needs PR review
(host and migration) and UI review (the Speed cell). After merge: Lyrica
rebuild, then Update… on each host; the first measured image fills the cell.
