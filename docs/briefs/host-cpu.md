# Brief: Host CPU

**Status:** In review.

**Thread:** Show host CPU and core count. **Branch:**
`claude/project-thread-2r1st9`. **Model:** Opus.

**Read first:** AGENTS.md, docs/briefs/ram-spill.md, host/API.md
`GET /host/v1/status`, docs/ux.md (the Models, Status and Model host
dashboard rows).

## Goal

A model host says what CPU it has. Since a model can spill into system RAM
(#663), the CPU and its cores decide how fast that part runs, and neither
Lyrica nor the host dashboard named them; the host read only total memory.

## Decisions

- **One status field.** `machine: { cpu, cores, threads, memory }`, read
  once at start: the CPU's model name with trademarks, core count and clock
  dropped ("AMD Ryzen 7 7800X3D"), physical cores from `/proc/cpuinfo`
  (distinct physical and core ids; the threads where it lists none, as on
  most ARM kernels), logical CPUs, and the machine's memory.
- **No thread setting.** llama.cpp already uses one thread per physical
  core by default (its `cpu_get_num_math`), which is what a spilled model
  wants, so the preset sets nothing. A setting comes only with a
  measurement showing another count is faster.
- **Lyrica:** a CPU line under each host's GPUs, built as a GPU block
  without a bar: "CPU · AMD Ryzen 7 7800X3D" and "8 cores · 16 threads ·
  96 GB RAM". On the host card and Administration → Status. The System RAM
  block's foot drops "N GB in this machine", now on the CPU line.
- **Host dashboard:** a CPU card after the GPUs (also under "No GPUs
  found."): its name, then cores, threads, memory and the servers that run
  on the CPU. The System RAM card drops the machine's memory likewise.

## Out of scope

- CPU load or temperature, memory bandwidth, NUMA, and a thread count
  setting.

## Handoff

Done: status field, Lyrica's CPU line, dashboard card, tests, docs
(host/API.md, host/README.md, docs/ux.md, docs/web.md). Next: reviews.
Open: none.
