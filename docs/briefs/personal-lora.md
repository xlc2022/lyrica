# Brief: Personal LoRA from portrait photos

**Status:** Shelved by the owner (2026-10-30) after step 1's trial; see
Trial results. Nothing built.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md (Images: Portrait
photos and the personal LoRA; the model host), `image-edit-quality.md`
(the likeness tests), docs/ux.md before any screen.

## Goal

Reference photos get a person roughly right: in the dev deployment's tests
on Qwen-Image 2.1 Turbo, identity scored about 4 of 5 for a new angle or a
new scene. A LoRA trained on the user's own `photos-of-me/` should get
closer and stay consistent across images, without any photo or result
leaving the user's machines. It trains on one of the user's model hosts,
only from that user's portrait photos, and only when they start it.

Principles: 1 (a likeness the user can see is better), 2 (the boundary is
structural: the trainer has no route out and photos exist on the host only
in memory) and 8 (no new tool or page: a parameter on `image` and a section
in Settings → Portrait photos).

## What changes

1. **A trainer on the model host.** A `trainer` service, built in CI from
   a pinned ai-toolkit commit (MIT) like our ComfyUI image: GPU, no route
   out, no logs of captions, its working folders in memory (`tmpfs`), and
   the models folder read-only. The host API takes
   `POST /host/v1/loras/train` with the photos, their captions, the base
   recipe, a trigger word and the settings. It answers with the LoRA's
   safetensors, then forgets photos and LoRA. Training holds the image GPU
   like a video job (an hour or more); Pause and the dashboard's cancel stop
   it.
2. **Captions stay local.** lyricad captions each photo with a local vision
   model (never a cloud one, whatever the portrait setting says) as the
   trigger word plus what changes between photos (clothes, setting, light),
   which is how a character LoRA learns the face and not the shirt.
3. **Stored encrypted, loaded only for a job.** The LoRA goes in the user's
   encrypted home beside `photos-of-me/`. An image job that uses it sends it
   with the request; the host keeps it in ComfyUI's memory-only folders for
   that job and removes it after, as it does with uploaded images.
4. **Choosing it.** Settings → Portrait photos shows **Train likeness**, its
   progress and the result (a name, trigger word, date, the photos it used,
   Delete). The `image` tool offers the user's enabled LoRAs with their
   trigger words, for recipes that declare a LoRA slot; the first version
   covers Qwen-Image 2.1 only.
5. **Deleting.** A LoRA is derived from the photos, so deleting a photo it
   was trained on deletes the LoRA too (the owner's rule for derived
   images), after the delete dialog says so. Images made with it follow the
   portrait rule for cloud sends, like any image made from those photos.

## Order

1. A trial on the dev deployment with a made-up person's photos: does the
   pinned ai-toolkit train a working Qwen-Image 2.1 LoRA on a 24 GB GPU,
   in how long, and does it beat reference photos on the same sheet? A
   converted LoRA that does nothing in ComfyUI is a known failure with
   another trainer, so the trial checks the result loads and changes the
   output. If it doesn't fit or doesn't help, stop and report.
2. The host trainer and API (PR review; CODEOWNERS `/host/`).
3. lyricad storage, captions, the Settings screen and the tool choice (PR
   review and UI review, with a docs/ux.md home for each new control).

## Trial results (2026-10-29)

On the dev deployment's 3090, with 18 images of a made-up woman generated
on 2.1 Turbo from two references, captioned `ohwx woman, …`:

- ai-toolkit b69b9831 (arch `qwen_image_2`) trains a 2.1 LoRA: rank 16,
  1024 px, 1500 steps, qfloat8, low VRAM; 92 minutes, 12.4 GB VRAM peak,
  80 MB out. It runs offline only after a one-time fetch of the diffusers
  layout of Qwen/Qwen-Image-2.1 (configs, processor, the 17 GB text
  encoder and the VAE); it can't use our int8 encoder. It fails on the
  diffusers base ("meta tensor") but trains on the Comfy single-file base.
- No official Turbo training adapter exists. Trained on Turbo directly
  (A) and on the base applied to Turbo (C); neither harmed scenes without
  people.
- Identity out of 5 over five prompts: reference photos about 4, A about
  2, C about 2.5, a LoRA plus references about the same as references. At
  strength 0.7 both went generic.
- ComfyUI loads the LoRA, but the host's scan has no LoRA rule for
  qwen-image-2.1 (keys `diffusion_model.transformer_blocks.N.attn.to_*`,
  metadata `ss_base_model_version` `qwen_image_2`), so `addLora` refuses it.
- The made-up dataset is the likely weak point. The next trial, when the
  owner picks this up again, uses her own photos with rank 32 and 2500
  steps, kept in memory on the host, never seen by a cloud model, scored
  by her. ai-toolkit and the base stay in /srv/lora-trial on the dev
  deployment for it.

## Out of scope

- Training on anyone's photos but the user's own `photos-of-me/`.
- Cloud training, and LoRAs for other architectures until the first works.
- Style LoRAs chosen per image (DESIGN keeps them with the personal LoRA as
  Later; this brief adds only the likeness LoRA).

## Open questions

- Which GPU trains when a user has more than one host: the one with the
  base recipe and the most memory, or the user's pick.
- Rank, steps and resolution defaults: from the trial, not set now.
