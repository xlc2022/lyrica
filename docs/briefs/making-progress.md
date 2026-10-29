# Brief: Progress while images and clips are made

**Status:** In progress.

**Thread:** Show progress while images and videos generate.

**Read first:** docs/ux.md §6 "An image the agent made" and "A clip the agent
made", host/API.md "Making images" and "Making videos", docs/briefs/video.md
(background clips).

## Goal

An image takes from seconds to a few minutes and a clip several minutes. Today
the chat shows only the marker, "Making an image running", and then nothing
until the result lands, so the person stares at an empty chat. The user asked
for a placeholder like ChatGPT's: a card at the result's shape, a field of
small dots in the accent colour that light up from one corner as the job goes,
and a percent in a pill at its corner. No seasonal decoration.

This serves principle 1 (the person sees she is working, and how far along),
within principle 8 (no new tool, no new setting; one host route).

## In scope

- **Host:** a job a client tags with `X-Lyrica-Job` (a random token) can be
  read with `GET /host/v1/jobs/<token>`: `queued` while it waits for the
  GPU, then `running` with `progress` from 0 to 1, or null when the backend
  reports none. ComfyUI's websocket `progress` messages for the workflow's
  sampler nodes give it: each sampler counts equally, and sampling is 95% of
  the job (the rest is decoding and saving). stable-diffusion.cpp reports
  none. Nothing about the job but its state and fraction is kept, and only
  while it runs.
- **Core:** `imageAt`/`videoAt` take an `onProgress` callback; for a host
  they tag the job and read its progress every 2 s while the call runs. A
  host that never knows the job (one from before this) is left alone after
  five tries. Cloud image providers report none.
- **Extension and daemon:** the image tool passes progress through Pi's tool
  updates; a background clip through its clip job. The thread's stream
  carries `making` (start time, progress, queued) and `made`; `hello`
  carries what is being made now, so a reopened thread shows its cards.
- **Web:** the card. It sits where the image or clip will be, under the
  marker, one per image asked for, and gives way to the result. Its shape is
  the size or aspect ratio asked for, the source image's for an edit,
  upscale or animate (shown blurred under the dots), else square for an
  image and 16:9 for a clip. The pill reads the percent when the host
  reports one, Waiting while the job is queued on the host, else the time
  since it started. A background clip's card stays under its started marker
  until the clip arrives as her message.

## Out of scope

- An ETA from past runs, and step counts.
- stable-diffusion.cpp's own progress (it prints a bar on its console; a
  later change could read it).
- Progress for a cloud model (none of their APIs report it).

## Contract changes

- host/API.md: `X-Lyrica-Job` and `GET /host/v1/jobs/<token>`.
- docs/contracts.md and daemon/src/api.ts: the `making` and `made` stream
  events and `hello.making`.

## Handoff notes

- 2026-10-29: brief written; building on `claude/project-thread-mups5e`.
