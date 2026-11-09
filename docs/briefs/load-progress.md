# Brief: Show how far a model's load has got

**Status:** planned (the owner asked for it 2026-11-09).

**Thread:** Run GLM 5.3 Flash on mystria. **Branch:**
`claude/project-thread-tgy8sd`.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "The host manages each
GPU's VRAM", host/API.md "Status", docs/ux.md (the Models and Model host
dashboard rows), docs/briefs/measured-placement.md, host/src/scheduler.ts
(`status`, `placement`), host/src/dashboard/dashboard.js (the model row),
web/src/Models.tsx (the hosts summary).

## Why

A 200 GB model takes minutes to load, and all the operator sees is the word
"loading" on the host dashboard and on the Models page. During the GLM 5.3
Flash loads on the development deployment's two-card host the operator
could not tell a slow load from a stuck one, and a stuck one from a crash.
Principle 1: the operator's model loads this month, and they can see it
loading.

## What the host can and can't see

- llama.cpp's router reports a model as `loading` and nothing more; its
  progress callback never reaches the HTTP API, and the model servers' logs
  are off on purpose.
- GPU memory is no gauge: llama.cpp allocates each weight buffer whole and
  then fills it, so the figure jumps to the end at once.
- What the host can measure is reading. A model larger than system RAM is
  read straight from disk (`load-mode = dio`, #857), every byte once; a
  smaller one is mapped and read once too, unless the page cache already
  holds it. `/proc/diskstats` is readable from host-api's container and
  counts sectors read per block device, host-wide.

## What

1. **Progress in the status.** While a model loads, the scheduler notes
   the sectors read from the models folder's block device (the device of
   the folder's `st_dev` in `/proc/diskstats`; when that device isn't
   listed, as on a multi-device filesystem, the sum of all whole disks)
   when the load begins, and `status()` reports for a loading model
   `loading: { read, of }`: bytes read since then, capped at `of`, and the
   bytes to read (the model's files, its vision projector and its MTP
   draft where those are on). A model already in the page cache reads
   nothing, so its bar reaches the end at once and waits for the upload;
   the docs say so. Nothing is reported for vLLM, image recipes and voices.
2. **Host dashboard.** The model row's state word gains a thin bar and
   "128 of 200 GB read" in mono while loading, refreshed with the status.
3. **Models page.** The hosts summary's "(loading)" becomes "(loading, 64%)"
   from the same field, which the daemon already relays in `HostStatus`.
4. **Docs.** host/API.md (the `models[]` entry in Status), host/README.md
   (one sentence under Queues or VRAM), docs/ux.md (both rows), this brief.
5. **Tests.** scheduler.test.ts with a fake disk reader: a loading model
   reports read/of and a loaded one reports nothing; the Models page test
   shows the percent.

## Out of scope

- A real progress figure from llama.cpp itself (an upstream change).
- Time estimates.
- Progress for vLLM or ComfyUI loads.

## Handoff

Not started. Next: build once the GLM 5.3 Flash Q4 load on the development
deployment is confirmed working after #857.
