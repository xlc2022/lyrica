# Videos

**Status:** Merged: part 1 as #609, part 2 as #612 and #616, part 3 as #618 to #621. Handoff notes below are history.

The owner asked (2026-10-28) for local video generation on the model
hosts, with MiniMax H3, Wan 2.2 and LTX-2.5, aimed mostly at a future
workstation with two RTX 6000 Pro Blackwell cards (2 × 96 GB) and also a
single RTX 3090 (24 GB). This serves principle 1: she can show the user
things in motion, and animate her own images, on hardware the operator
owns.

The pinned ComfyUI (0.38.2) already has native nodes for all three, so
video is a new kind of recipe on the same ComfyUI stack, not a new
server. Built in two pull requests: the host first, then Lyrica's side.

## The models

| Starter | Parts | Fits | Licence |
|---|---|---|---|
| Wan 2.2 TI2V 5B | fp16 5B, UMT5 fp8, Wan 2.2 VAE (Comfy-Org repackaged) | the 3090: 1280×704, 24 fps, about 5 s | Apache 2.0 |
| Wan 2.2 T2V 14B and I2V 14B | two fp8 experts (high and low noise), their lightx2v 4-step LoRAs, UMT5 fp8, Wan 2.1 VAE | the 3090 at 480 to 720p, both on the workstation; 16 fps, about 5 s | Apache 2.0 |
| Wan 2.2 T2V 14B Q5 and I2V 14B Q5 | the same, with QuantStack's Q5_K_M GGUF experts (10.8 GB each) | a 24 GB card with less system memory; 16 fps, about 5 s | Apache 2.0 |
| LTX-2.5 distilled | int8 22B, Gemma 4 12B int8, video and audio VAEs, the 2× latent upscaler (Lightricks/LTX-2.5, gated) | the workstation; video **with audio**, 24 fps, up to about 10 s | LTX-2.x Community License: free under $10M yearly revenue |
| MiniMax H3 | pruned int8 33B, Qwen3-VL 32B NVFP4, video and audio VAEs, the lightx2v 8-step turbo LoRA (Comfy-Org/MiniMax-H3) | the workstation; video **with audio**, 768p, 24 fps, 5 to 15 s | MiniMax community licence: forbids use in the US, EU, UK and South Korea |

The workflows follow ComfyUI's own templates (Comfy-Org/workflow_templates:
`video_wan2_2_5B_ti2v`, `video_wan2_2_14B_t2v`, `video_wan2_2_14B_i2v`,
`video_ltx2_5_t2v`, `video_ltx2_5_i2v`, `video_minimax_h3_t2v`,
`video_minimax_h3_i2v`), with their speed LoRAs and distilled steps on
and their prompt enhancers off. As with Krea 2, the host ships the
starters and says what each licence asks; the operator decides whether
their use is allowed. H3 needs the owner's own check of where the host
and its users are.

## Part 1: the host (#609, merged)

1. **Video templates** in `host/workflows/`, one per model and mode:
   `does` holds `video` (from a prompt) and/or `animate` (from a first
   frame). Each template has a `video` block: its frame rate, its frame
   grid (frames = step × k + 1, or H3's 17k + 5), its longest clip and
   whether it makes audio. The host turns seconds into frames.
2. **Parts with slots for video:** two diffusion experts (`high`,
   `low`), the speed LoRAs a template loads itself (role `lora` with a
   slot), a second VAE for audio (`audio`) and LTX's latent upscaler (new
   role `latent_upscaler`). The scan tells Wan, LTX and H3 diffusion
   models, UMT5, Gemma 4 and Qwen3-VL 32B apart so no image recipe picks
   them up. A recipe's peak memory counts one expert at a time.
3. **`POST /host/v1/videos/create`:** a recipe, a prompt, an optional
   first frame, width and height, seconds, steps, CFG and seed. Without
   an image it needs `video`, with one `animate`. One clip per request.
   It answers with an H.264 MP4 (AAC audio when the model makes it), a
   PNG poster (the first frame), the size, frames, fps and seed.
4. **Nothing reaches disk:** a small pinned node in our ComfyUI image,
   `SaveVideoWebsocket`, encodes the clip in memory and sends it, and the
   poster, over the websocket, as `SaveImageWebsocket` does for images.
5. **Long jobs:** a video may run for up to two hours (images: 30
   minutes). It holds ComfyUI's GPU while it runs, as an image does; on
   the workstation that is one card, and the other serves chat.
6. **Docs:** host/API.md, host/README.md, DESIGN.md (video moves into
   scope), docs/models.md and this brief.
7. **Core** lists no video recipe as an offering until part 2, so a video
   recipe never shows as a chat or image model.

## Part 2: Lyrica's side (#612, #616, merged)

- The task `video` ("Videos") with its own list in each preset; the
  operator puts H3 or LTX-2.5 there on the Blackwell host and Wan 2.2 5B
  on the 3090. Only a model host's recipe answers, so it is local only,
  and it is not a thread task.
- The `image` tool's `video` (from a prompt) and `animate` (from a
  workspace image or a photo of you) actions, with an optional size or
  ratio and seconds: no new tool (principle 8). A first frame never
  leaves the operator's hosts, so the photos-of-you consent never asks.
  She gets the clip's facts and its poster, so she sees its first frame.
- Clips stored in the encrypted home as `videos/<uuid>.mp4`, with the
  poster as their Files thumbnail; deleting a clip deletes its poster,
  and renaming it moves the poster along. The thread's file route answers
  byte ranges so the player can seek.
- The chat shows the poster with a play button and plays the clip in the
  browser's own player; its home in docs/ux.md, "A clip the agent made".

## Part 3: chat goes on while a clip is made, and better clips (#618 to #621, merged)

The first run through Lyrica (lunasa's 3090) showed that a Wan clip holds
22 of 24 GB for about 6 minutes: her turn waited on the tool call, and a
chat request waited 2 minutes in the host's queue, then failed as busy.
The owner chose, in order:

- **Clips in the background** (built): the tool call reads the first frame,
  hands the job to lyricad's `ClipJobs` and returns, so her turn ends. The
  clip comes into the thread as her message and wakes an idle thread to
  say it's ready; a failure is a notice that wakes it too; Lock and a
  shutdown stop it. Her marker reads started.
- **Detailed clip prompts** (built, a guideline): she writes the prompt as
  a detailed shot (subject and action, motion, camera move and lens, light
  and mood, about 80 to 120 words) even from a few words.
- **A quality option** (dropped): lunasa's same-seed test showed more
  steps double the time and don't help; the prompt matters more.
- **Wan 2.2 A14B on a 24 GB card** (built): starters with QuantStack's
  Q5_K_M GGUF experts beside the fp8 ones, the same lightx2v 4-step LoRAs,
  UMT5 and VAE, on the existing 14B templates (a `.gguf` expert loads
  through ComfyUI-GGUF). The host reads a Wan GGUF's tensor list, so its
  experts classify as the safetensors do. Lunasa's run: 430 s for 5 s at
  1280×720, 22.7 GB peak, clearly sharper than the 5B.
- **Smoother 14B clips** (built): Comfy-Org's RIFE 4.26 (MIT, 22 MB) as an
  optional `interpolator` part of the 14B templates and starters, run by
  ComfyUI's own FrameInterpolate after decoding: 16 fps becomes 32.
- Not chosen yet: chat passing over a host whose GPU a clip holds, for the
  next fallback in her preset, instead of waiting and failing.

## Not in scope

- Splitting one clip over two GPUs (Raylight, or ComfyUI's own
  multi-GPU nodes): one job per card first.
- Video upscaling, longer clips by extension, reference-to-video, and
  cloud video providers.
- HunyuanVideo 1.5 (its licence excludes the EU).
- Clips that move like another clip: their own brief,
  [motion-video.md](motion-video.md).

## Handoff

- 2026-10-28, part 1 built on `claude/project-thread-105ofj`: the five
  video templates and starters, the scan, the loaders for experts, speed
  LoRAs, audio VAEs and the latent upscaler, `POST /host/v1/videos/create`
  and `SaveVideoWebsocket`. Host tests use a fake ComfyUI. Core leaves
  video recipes out of its offerings until part 2.
- Not yet run on a real GPU: the workflows follow ComfyUI's templates
  node for node, but the first real clip of each starter is the check.
  The starter checksums come from CI's starters job; LTX-2.5's gated
  repository hides them, so its starter has none pinned.
- The owner keeps the H3 starter and decided its licence question.
- 2026-10-28, first real run on the 3090 (Wan 2.2 5B, from main): 5 s at
  1280×704, 121 frames, in 354 s at 22.0 GB peak; animating a 768² image
  took its shape (960×960) in 372 s. The motion from a flat test image was
  weak and its first frame darker than the rest.
- 2026-10-28, part 2 built on `claude/project-thread-105ofj` (see above).
- 2026-10-28, part 2 ran end to end on lunasa (#612, then #616 for ranges
  on Files and the model's name).
- 2026-10-28, part 3's background clips and prompt guideline built on
  `claude/project-thread-105ofj`.
- 2026-10-28, lunasa's same-seed test on the 5B (1280×704, 121 frames):
  an expanded prompt at 20 steps (349 s) beat a short one at 20 or 40;
  40 steps took 660 s and overexposed the expanded prompt. About 17 s a
  step.
- 2026-10-28, the Q5 GGUF 14B starters built on
  `claude/project-thread-105ofj`, pinned from the hub's listing.
- 2026-10-28, the owner dropped the quality option. Lunasa found her
  default 16:9 clip refused (core's 1360×768 isn't a multiple of Wan
  5B's 32); an aspect ratio now goes to the host, which keeps the
  recipe's area in that shape and snaps sizes to its step.
- 2026-10-30, first real run of the H3 Turbo starter, on the Blackwell
  workstation (RTX PRO 6000, 102 GB): a default clip (1344×768, 5 s,
  8 steps) in about 2 minutes. Quality not yet judged.
- 2026-10-30, videos past one clip and extending a clip:
  [long-videos.md](long-videos.md).
- Next: the 14B (fp8 and Q5) and LTX-2.5 starters on a real GPU; H3's
  quality against more steps.
