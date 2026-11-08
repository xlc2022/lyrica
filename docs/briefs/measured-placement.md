# Brief: Plan a llama.cpp load from llama.cpp's own measurement

**Status:** built, in review.

Owner: the "Run GLM 5.3 Flash on mystria" thread. Tests: the development
deployment's two-card host (two RTX PRO 6000, 95.6 GiB each).

## Why

The host plans where a llama.cpp model goes from an estimate: file size
times 1.05, a cache guess (2 GiB per 32k tokens when the header's attention
layout isn't one the library can size), and 0.5 GiB per GPU for everything
else. GLM 5.3 Flash UD-Q4_K_XL, spilled into system RAM so it just fits two
96 GB cards, loaded its weights to within 9 GiB of GPU 1 and then ran out of
memory: its compute buffers (an attention indexer, a four-wide residual
stream, expert routing) are several GiB per card at a 32k context, which no
flat allowance covers. Raising **Keep free** gets one load through but is a
bandaid: the operator would tune it per model.

llama.cpp's router (b11960, the build the host runs) can measure this
itself. With `--models-memory-margin` on, it spawns a short child per model
that reads the GGUF and the preset and reports, per device, the bytes of
weights, cache and compute buffers at the preset's context, without
allocating anything (`GET /models`, field `memory`; README "Memory-based
unloading"). It honours the preset's devices, tensor split, `n-cpu-moe` and
context, so it is exact for any architecture. DESIGN ("The host manages
each GPU's VRAM") already plans from a measurement where one exists; this
makes one exist before the first load. Principle 1: the operator's model
loads this month; principle 7: one measured number instead of a growing
estimate with special cases.

## What

1. **Measurement on.** The llama.cpp services in `compose.nvidia.yaml`,
   `compose.amd.yaml` and `compose.vulkan.yaml` get
   `--models-memory-margin 1`. The router then also unloads idle models of
   its own accord when a load wouldn't fit its measurement; the host's
   scheduler has made that room already, so the router finds nothing to do,
   and 1 MiB is the smallest margin that turns measurement on.
2. **Measure before loading.** The llama.cpp backend gains
   `measure(model, placement, settings)`: it writes the preset with that
   placement, has the router read it again, waits (at most 60 s) for the
   model's measurement to settle, and answers the bytes per GPU
   (`model + context + compute` of the `min` report, which is at the preset's
   context since the host pins `c`), mapped from device names (`CUDA0`) to
   GPU indexes. Null when the measurement failed or took too long, so the
   estimate stands as today. The router leaves the vision projector out of
   its measurement (its own TODO); the host adds the projector's size, times
   1.1, on the first GPU when vision is on.
3. **Plan from it.** The scheduler, having picked a way to run (unloading
   idle models as now), measures it before loading. The measured need is
   the server's bytes plus the flat 0.5 GiB, which now stands for the
   driver's context and workspace that llama.cpp's breakdown leaves out. If
   every GPU has room for it, the load goes ahead with that need, and the
   measurement is saved under the placement's VRAM key (keeping the larger
   saved value), so later plans start from it. If a GPU is short, each GPU's
   measured cache and compute (plus the 0.5 GiB) becomes the model's
   overhead in the planner, in place of the flat allowance, and the load is
   planned again from the top: the usual plan then unloads idle models or
   moves more experts to RAM, and the new placement is measured. After two
   such rounds a GPU still short refuses the load with `too_big` naming the
   measured need, not the estimate. Reload takes the same path as a queued
   request. A measurement not done within a minute leaves the estimate in
   charge for that load; if the router then unloads an idle model of the
   host's to make its own room, the host notices at that model's next
   request, which fails once with "try again" and loads it again.
4. **Docs.** host/README.md (the VRAM bullet and the llama.cpp line under
   "How it's put together"), DESIGN.md's VRAM bullet, this brief.
5. **Tests.** scheduler.test.ts with a fake backend whose measurement
   exceeds the estimate: the spill grows and the load proceeds with the
   measured need saved; a measurement no spill can satisfy refuses with the
   measured numbers; a failed measurement falls back to the estimate.

## Out of scope

- vLLM and ComfyUI, which have no such measurement.
- Using the router's `max` report to pick the context automatically; the
  host's own `autoContext` stays.
- Keeping llama-server's log lines anywhere: the operator keeps the model
  servers' logs off so prompts and answers never reach disk.
- Noticing a router-side unload before the model's next request.

## Handoff

Done: items 1 to 5. Next: PR review, merge, a host update on the
development deployment, then load GLM 5.3 Flash UD-Q4_K_XL there and record
the measured per-GPU bytes and the context in the GLM brief.
