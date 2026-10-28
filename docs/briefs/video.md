# Videos

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

## Part 1: the host (this PR)

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

## Part 2: Lyrica's side (next PR)

- The task `video` ("Videos") with its own list in each preset (H3 or
  LTX-2.5 on the Blackwell preset, Wan 2.2 5B on the 3090), local only
  for now.
- A `video` tool (`create` from a prompt, `animate` from a workspace
  image), within the tool budget, the same portrait rule as edits, and
  the photos-of-you rule for a first frame.
- Clips stored encrypted like images, with the poster as their
  thumbnail; deleting a clip deletes its poster.
- The chat shows the poster with a play button and plays the clip in the
  browser's own player (DESIGN, "Files"); its home in docs/ux.md.

## Not in scope

- Splitting one clip over two GPUs (Raylight, or ComfyUI's own
  multi-GPU nodes): one job per card first.
- Video upscaling, longer clips by extension, reference-to-video, and
  cloud video providers.
- HunyuanVideo 1.5 (its licence excludes the EU).

## Handoff

- 2026-10-28, part 1 built on `claude/project-thread-105ofj`: the five
  video templates and starters, the scan, the loaders for experts, speed
  LoRAs, audio VAEs and the latent upscaler, `POST /host/v1/videos/create`
  and `SaveVideoWebsocket`. Host tests use a fake ComfyUI. Core leaves
  video recipes out of its offerings until part 2.
- Not yet run on a real GPU: the workflows follow ComfyUI's templates
  node for node, but the first real clip of each starter is the check.
  The starter checksums come from CI's starters job.
- Next: part 2. Open question for the owner: whether H3's licence allows
  their use (see the table).
