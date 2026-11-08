# Editing a clip (MiniMax H3 VFX Edit)

**Status:** built, in review.

The owner asked (2026-11-08) for "the MiniMax H3 editor". MiniMax has
released no edit checkpoint of its own. The editor the H3 community uses
is the **VFX Edit LoRA** (Alissonerdx, `Alissonerdx/Minimax-H3-ComfyUI`),
trained on H3's ref2va checkpoint: given a clip and one sentence, it
changes the clip (night for day, a red coat, snow falling, another style)
and keeps its motion, timing, camera and sound. This serves principle 1:
she can change a clip the user gave or one she made, on the operator's own
hardware. It builds on [video.md](video.md) and
[long-videos.md](long-videos.md), with the same host, Videos list and
background clips. The other reading, the H3Studio timeline node
(`shootthesound/ComfyUI-H3Studio`), is an editor for a person in
ComfyUI's own interface, which the host doesn't serve, so it isn't used.

## The host

- **A template** `host/workflows/minimax-h3-edit.json`, arch
  `minimax-h3-ref2va`, doing a new action `edit_video`. Its graph uses
  only ComfyUI's own H3 nodes, as the community's graphs do: the prompt
  after the LoRA's `vfx_edit: ` trigger (`StringConcatenate`),
  `MiniMaxH3ReferenceToVideo` with no references, and
  `MiniMaxH3AddGuide` anchoring the clip's frames and sound from frame 0.
  The clip goes in only as that guide, never as a reference video, which
  the LoRA wasn't trained on. Its `video` block is H3's: 24 fps, 17k + 5
  frames, 15 s longest, with sound. No continuation: an edit is one clip.
- **The clip** is read by a new node, `LyricaSourceFrames` in
  `host/comfyui/video_frames.py`: the driving-clip reader's frames at
  24 fps, plus the sound of those frames.
- **Parts and the scan:** ref2va and fl2va have the same tensors, so a
  diffusion file named `ref2va` (or a LoRA named `ref2v`) is
  `minimax-h3-ref2va`, and a LoRA named `vfx_edit` gets the slot `edit`.
  The starter `host/recipes/minimax-h3-edit.json`: Comfy-Org's ref2va
  int8 (21 GB) and ref2v 4-step turbo LoRA, the VFX Edit LoRA r128
  (1.2 GB), and H3 Turbo's text encoder and VAEs. 4 steps, euler, simple,
  cfg 1. Checksums came from another project's manifest (HF is blocked
  here); the CI starters job checks them against the hub.
- **`POST /host/v1/videos/create` takes `source`**, a base64 MP4 of at
  most 64 MB, alone (no image, drive, extend, size or ratio). The clip
  keeps its shape at the recipe's area and its length up to 15 s (or its
  first `duration` seconds), in the most of H3's frame counts the clip
  holds, so the guide never runs past its last frame. Under 0.9 s is
  refused. It is written over after the job like any upload.

## Lyrica's side

- Core: `VideoRequest.source`, the capability `videoEdit` (recipes that
  do `edit_video`), the need `videoEdit` and the skip reason "it doesn't
  edit clips". The Videos list takes edit recipes as it takes motion ones.
- The `image` tool's action **`edit_video`**: `video` (a workspace clip)
  and `instruction` (one English sentence: the change, then what stays),
  no size, ratio or LoRAs; in the background like every clip. Her
  guideline: use it when a clip should change but keep its motion; one
  change per edit.
- The interface: nothing new to press. The marker reads **Editing a
  clip**; the clip shows as any clip does. docs/ux.md has the word.

## Not in scope

- The FFP variant (an edited first frame propagated through the clip),
  Character Swap, Head Swap and Style Transfer LoRAs from the same pack:
  each needs a reference image and its own prompt rules. Ask the owner.
- Edits past 15 s (chaining edits), and a size other than the clip's.

## Open questions

- Not yet run on a GPU. The first run, on the workstation (96 GB), should
  check that the turbo LoRA and the VFX Edit LoRA together keep the clip's
  motion at 4 steps, how long a 5 s edit takes, and that the sound comes
  through.
- Licence: the VFX Edit LoRA is an experimental research release made on
  H3, under H3's licence, which excludes the US, the EU, the UK and South
  Korea, as for H3 Turbo, which the owner already chose to use.

## Handoff

- 2026-11-08: built on `claude/project-thread-k2qybw` (host, core, tool,
  web marker, docs). Host, core and extension tests cover the template,
  scan, request checks, routing and the tool. Next: PR review (host), UI
  review (the marker), a GPU run on the workstation after the host update.
