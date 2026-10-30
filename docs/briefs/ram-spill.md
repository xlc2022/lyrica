# Brief: System RAM spill

**Status:** Designed; the owner chose the shape (a host allowance, models on
Auto). Not built.

**Thread:** Let models spill into system RAM. **Branch:**
`claude/project-thread-m3z2aj`. **Model:** Opus.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "The host manages each
GPU's VRAM", host/API.md "Placement and serving settings", docs/ux.md (the
Models, Text models and Model host dashboard rows), host/src/placement.ts
and host/src/scheduler.ts.

## Goal

A model host can run a model bigger than its GPUs, or a higher quant, by
keeping part of it in system RAM, slower but working. It is off until the
operator gives the host an allowance, and then it happens only when a model
doesn't fit the GPUs. Today the only lever is a model's **GPU layers**
number, which the fit check ignores, so a model too big for the GPUs is
refused whatever it says.

## Decisions

- **One allowance per host** (the owner, 2026-10-30): **System RAM**, typed
  in GB, "of <max> GB", empty meaning off. The max is the machine's memory
  less llama.cpp's prompt cache (an eighth of memory, at least 8 GiB) and
  8 GiB left for the system; out-of-range values clamp. It lives in Lyrica's
  host drawer (after Models folder) and in the host dashboard (a **Memory**
  section's one field), and saves through `PUT /host/v1/memory`.
- **Models on Auto.** Each model's Serving settings gain **System RAM**,
  Auto or Off, shown while the host has an allowance. Off keeps a model on
  the GPUs only, so a chat model stays fast or is refused as today.
- **Only what doesn't fit spills.** A way of running that fits the GPUs,
  unloading idle models if needed, always wins. Only when no way fits even
  on empty GPUs does the host plan a spilled one: it moves the bytes the
  GPUs lack (plus their buffers) to RAM, never more.
- **Experts first.** For a mixture-of-experts GGUF, llama.cpp keeps the
  expert weights of the first N layers in RAM (`n-cpu-moe = N`), which
  costs least: attention and the shared weights stay on the GPU. A dense
  model, or an MoE model whose experts aren't enough, keeps whole layers in
  RAM (`n-gpu-layers` below its layer count). The host reads the layer
  count and the expert tensors' bytes from the GGUF header.
- **The allowance is shared.** Spilled models together stay within it; a
  model that would pass it unloads idle spilled models first, as GPU memory
  does, or is refused with the reason ("needs 18 GB of system RAM; the
  allowance is 32 GB, 20 GB of it in use by …").
- **GPU layers goes away** from Lyrica's Serving drawer. The API keeps
  `gpuLayers` as a by-hand override (the host dashboard's Other settings),
  and the fit check now counts it: weights and cache of the layers it
  leaves out count against the allowance.
- **llama.cpp only, for now.** vLLM's CPU offload is much slower and
  ComfyUI offloads on its own; both keep ignoring the allowance. The
  setting's tooltip says so.

## What the user sees

- **Serving → Placement's estimate**: "Needs about 59 GB: 41 GB on the GPUs
  and 18 GB in system RAM, so it runs slower." A spill past the allowance is
  the bad estimate, naming both numbers, and blocks Save as today.
- **Host card** (Hosts and endpoints) and **Administration → Status**:
  while the allowance is set, a **System RAM** block under the GPUs, built
  as a GPU block: "System RAM", "18.4 / 32 GB" in mono, the bar (the legend
  gains **In system RAM**), and what is spilled ("GLM 5.3 Flash (18 GB)").
- **Host dashboard Starters**: a starter too big for the GPUs but within
  GPUs plus allowance gets **uses system RAM** (amber pill, tooltip "Runs
  slower: part of it stays in system RAM.") and can download; past both it
  stays **too big for these GPUs**.
- **Speed**: no new number. Text models' tok/s is measured per copy, so the
  cost shows where speed already does.

## In scope

1. host: `systemRam` in the state file (bytes, 0 = off) and
   `PUT /host/v1/memory`; `systemRam: { total, max, allowance, used }` in
   the status, and `ram` (bytes) on each spilled model there.
2. host: GGUF layer count and expert bytes in the library; spilled options
   in placement.ts (`ram`, and `cpuMoe` or `gpuLayers`), counted by the
   scheduler against the allowance; llama.cpp's preset writes them; the
   measurement key includes the spill.
3. `systemRam: false` in a model's settings; the settings answer's
   estimate gains `ram`.
4. Lyrica: the daemon's host calls and contract for the allowance; the
   host drawer field; Serving's System RAM select and estimate; the RAM
   block on host cards and Status; GPU layers removed from the drawer.
5. Host dashboard: the Memory section and the Starters pill.
6. Tests: the fit check picks GPU-only first and spills only what's
   missing, experts before layers; the allowance is shared and refused
   with its reason; the preset lines.
7. Docs: host/API.md, docs/models.md, docs/contracts.md, docs/ux.md (the
   three rows), DESIGN.md's VRAM section, the operator guide for hosts, and
   the Models mockup (`notbuilt` until merged).

## Out of scope

- vLLM `--cpu-offload-gb`, ComfyUI offload settings, KV cache in RAM as a
  separate choice, and spilling a model that fits but would evict others.
- Measuring RAM per model; the expected bytes stand until a later brief.

## Handoff

Done: design chosen, this brief, the mockup. Next: build in the order of
In scope. Open: none.
