# Clips that move like another clip

**Status:** Part 1 (the host) merged as #646; part 2 in review.

The owner asked (2026-10-29) for better human movement in generated
clips. Wan 2.2 makes a person move vaguely and often weakly from a prompt
alone. A pose-driven model fixes that: given an image of someone and a
clip of someone moving, it makes a new clip of the first person doing
exactly what the second does. This serves principle 1: she can show the
user a dance, a wave or a gesture as it really moves, on the operator's
own hardware. It builds on [video.md](video.md), with the same host,
templates and background clips.

## What was tried

- **NVlabs MotionBricks** was the starting idea: a real-time motion
  controller for game characters and robots (poses in, a 3D skeleton
  out, through TensorRT and a game-engine stack). It makes no video, so
  it is not used.
- **The bake-off** (lunasa's 3090, ComfyUI 0.38.2, 2026-10-29): SCAIL-2
  against Wan Animate 2 on the same made-up reference person, the same
  driving clip (a Wan 2.2 14B Q5 dance) and seed, 1280×704, 81 frames,
  6 steps with the lightx2v LoRA, cfg 1.
  - **SCAIL-2** (zai-org, on Wan 2.1 14B, MIT): 817 s, 21.0 GB of VRAM,
    system memory fine. It kept the choreography frame for frame and the
    reference's face, hair, clothes and framing.
  - **Wan Animate 2** (Apache 2.0): 692 s, 22.3 GB, but 29.6 of 30 GB of
    system memory, and only with its cache in system memory at 4 bits
    (it ran out of GPU memory, then system memory, first). It zoomed in
    so raised hands left the frame, took on the driver's smile and
    blurred hands in fast moves.
  - Both kept a steady background without flicker. The outputs are in
    the project files (`pose-video-side-by-side.mp4`,
    `pose-video-contact-sheet.png`).
- So: **SCAIL-2**. Both are native in ComfyUI 0.38.2 (`WanSCAILToVideo`,
  `SCAIL2ColoredMask` and `SAM3_VideoTrack` in `nodes_scail.py`), and
  SCAIL-2 reads the driving clip itself, with SAM 3.1 masks, so there is
  no separate pose step.

## Part 1: the host

1. **A template** `host/workflows/scail2.json` following ComfyUI's own
   `video_wan21_scail2_character_replacement_int8`, with its speed LoRA
   and DPO LoRA on. Its `does` holds a new action, `motion`: a reference
   image and a driving clip in, a clip out. Its `video` block: 16 fps, a
   4k + 1 frame grid, 5 s longest on 24 GB.
2. **Parts:** Comfy-Org/SCAIL-2's int8 model (16.65 GB) and DPO LoRA,
   the lightx2v Wan 2.1 I2V 480p LoRA, `clip_vision_h`, the Wan 2.1 VAE
   and UMT5 fp8 (both already there for the 14B), and SAM 3.1 as a new
   part role, `segmenter`, so no image recipe picks it up. One starter
   for both the 3090 and the workstation. Pin each file's checksum from
   the hub's listing, as for the other starters.
3. **`POST /host/v1/videos/create` takes `drive`**, a base64 MP4. With
   `image` and `drive` the recipe must do `motion`. The host decodes the
   clip, keeps its first `duration` seconds (at most the recipe's
   longest), resamples it to the recipe's frame rate (lunasa's 32 fps
   driver became 16 fps), and fits it to the output size, which is the
   reference image's shape unless one is asked for. It answers as for
   any clip.
4. **On disk:** ComfyUI reads the driving clip from its input folder,
   which is in memory (tmpfs), as it reads an uploaded image. The host
   writes over it after the job as it does an image, with the same 1×1
   PNG under the clip's name, so nothing a user gave stays.
5. **Docs:** host/API.md, host/README.md, docs/models.md, docs/contracts.md
   if the video request's shape is written there, and this brief.

## Part 2: Lyrica's side

- **The `image` tool gets the action `motion`**, with `image` (who moves:
  a workspace image or a photo of you) and `video` (how: a workspace
  clip, one she made or one the person attached), an optional size or
  ratio, and seconds. There is no new tool (principle 8). It goes
  through the Videos task: the first recipe in its list that does
  `motion` answers, otherwise she is told no model can do it. Like
  `animate`, it runs in the background and is local only: the image and
  the clip never leave the operator's hosts, so the photos-of-you consent
  never asks.
- **Her guideline:** use it when the person wants someone to move like a
  given clip, or when a prompt-only clip of a person would move badly
  and she can make a driving clip first (a `video` of a plain figure
  doing the moves, then `motion`). The prompt says the scene and light,
  not the moves.
- **The interface:** nothing new to press. The marker reads **Copying a
  clip's moves** (beside Making a clip and Animating an image), and the clip
  shows as any clip does. docs/ux.md gets the label in its word list and
  in "A clip the agent made"; UI review judges it.

## Not in scope

- Replacing a person inside the driving clip while keeping its scene
  (SCAIL-2 can; ask the owner after part 2).
- Text-to-motion (NVIDIA's Kimodo) as a driving-clip source, and
  several people in one clip.
- Wan Animate 2 as a second recipe: it needs more system memory than
  lunasa has and lost the bake-off.

## Open questions

- SAM 3.1's licence, read by lunasa: Meta's SAM License (2025-11-19)
  allows commercial use; it asks that publications acknowledge SAM, that
  use follows the law and trade controls, and no reverse engineering. The
  host README says so.
- Whether a Q5 GGUF of SCAIL-2 should be a second starter for a 24 GB
  card with little system memory. The int8 one ran fine on lunasa.

## Handoff

- 2026-10-29: brief written after the bake-off. The test ComfyUI is
  stopped and its files are kept on lunasa in `/srv/posebake`, so part 1
  can check its template against a real run there.
- 2026-10-29, part 1 built on `claude/project-thread-mzp6un`, from the
  workflow lunasa ran (ComfyUI's own template, animation mode) and the
  files' headers and checksums lunasa read:
  - `host/workflows/scail2.json` and the starter `host/recipes/scail-2.json`
    (the lightx2v LoRA and CLIP vision from Comfy-Org/Wan-Animate-2, the
    VAE and UMT5 the 14B starters already use).
  - The scan tells SCAIL-2 by `patch_embedding_pose`, CLIP ViT-H's image
    half (`clip_vision`) and SAM 3.1 (`segmenter`) apart, and the DPO LoRA
    by name (`dpo`). A template's named LoRA has its own strength.
  - `drive` on `POST /host/v1/videos/create`: an MP4 or QuickTime clip of
    at most 64 MB, whose length is read from its movie header. The clip is
    no longer than that; a new pinned node, `comfyui/video_frames.py`,
    picks its frames at 16 fps, so the moves keep their speed.
  - SAM 3.1 looks for "person" in both the image and the clip.
  - Core leaves out a recipe that does only `motion`, so it never shows as
    a chat model before part 2.
- 2026-10-29: part 1 merged as #646 (886926c). Lunasa ran the host's
  filled template from the host image (ComfyUI 0.43.1) with a 32 fps
  driver: 556 s for 5 s at 1280×704, 21.4 GB of VRAM and 29.6 of 30 GB of
  system memory (tight), at real speed.
- 2026-10-29, part 2 built on `claude/project-thread-mzp6un`: the `motion`
  capability and offering, `drive` on `VideoRequest` (an MP4 of at most
  64 MB, with `image`), routing to a recipe that does `motion`,
  `ThreadImages.readClip`, the `image` tool's `motion` action and
  guideline, and the marker **Copying a clip's moves** (ux-copy kept the
  "<verb>ing a <thing>" pattern of the other markers).
- Next: PR review and UI review, then a clip through Lyrica on lunasa.
