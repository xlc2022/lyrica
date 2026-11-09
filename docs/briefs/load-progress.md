# Brief: Show how far a model's load has got

**Status:** merged as #860.

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
   nothing, so it shows no percent; the docs say so. Nothing is reported
   for vLLM, image recipes and voices.
   **The load's time runs from its progress.** The llama.cpp backend is
   given the same figure: its 10 minutes run from the last time the read
   count grew (and once more from when all of it is read), so a 200 GB
   model on a SATA SSD (about 8 minutes of reading) loads, while a stuck
   server still fails, with the error saying how much was read. Other
   reading from the same disk can only stretch the wait by the model's own
   size, since the count is capped at it.
2. **Host dashboard.** The model row's state word reads "Loading 64%"
   while loading, with "128.0 GB of 200.0 GB read from disk" as its
   tooltip, refreshed with the page; the same shape as a download's
   "Downloading 64%".
3. **Models page.** The hosts summary's "(loading)" becomes "(loading, 64%)"
   from the same field, which the daemon already relays in `HostStatus`.
4. **Docs.** host/API.md (the `models[]` entry in Status), host/README.md
   (one sentence under Queues or VRAM), docs/ux.md (both rows), this brief.
5. **Tests.** scheduler.test.ts with a fake disk reader: a loading model
   reports read/of and a loaded one reports nothing; routing.test.ts: a
   llama.cpp load that keeps reading outlives the fixed time, one that
   stops fails naming the bytes read.

## Out of scope

- A real progress figure from llama.cpp itself (an upstream change).
- Time estimates.
- Progress for vLLM or ComfyUI loads.

## Handoff

Done: items 1 to 5 (host/src/disk.ts, backends.ts, scheduler.ts,
runtime.ts, dashboard.js, daemon/src/api.ts, web/src/Models.tsx), merged.
Built before the Q4 load was confirmed, because that load (200 GB from a
SATA SSD at 437 MB/s) cannot finish inside the fixed 10 minutes. With it on
the development deployment's host the Q4 load ran to the end on 2026-11-09
(the GLM brief has the figures). Nothing next.
