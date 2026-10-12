# Brief: Model host

**Thread:** Model host. **Branch:** `feature/model-host`.

**Depends on:** nothing in Lyrica. The host is its own package. Lyrica's side
(pairing client, fallbacks, Models page) is the **Models 2** thread
(`docs/briefs/models-2.md`), built in parallel against the API defined here.

**Read first:**
- AGENTS.md and PRINCIPLES.md;
- DESIGN.md: "Models and endpoints", especially the model host bullets,
  Pairing and the Models page, and "Images";
- docs/contracts.md: `core/models`.

## Goal

One self-contained package that turns a Linux GPU machine, NVIDIA or AMD,
into a model host for Lyrica. It must be easy to deploy, safe on a personal
workstation, and manageable from Lyrica or from its own dashboard. This
serves principles 1 and 2: Lyrica's best models live on a machine the owner also
games on, so the host has to be easy to live with and hard to misuse.

## In scope

1. **Layout:** a new top-level `host/` folder with its own README. The host
   API is TypeScript on Node 22, like the rest of the project (principle 7).
2. **The Compose stack**, with images pinned by digest:
   - `host-api`: ours, built in CI. It is the only service with a published
     port.
   - `comfyui`: ours, built in CI from pinned ComfyUI and custom-node
     commits (including ComfyUI-GGUF and ComfyUI-SeedVR2_VideoUpscaler),
     with a CUDA and a ROCm variant. It has no plugin manager.
   - vLLM and llama.cpp: their official images, pinned by digest, with a
     CUDA and a ROCm variant (and Vulkan for llama.cpp where useful).
   - `fetch`: ours, small, for downloads (item 9).
   - A compose profile per vendor (`nvidia`, `amd`). An `install.sh` checks
     the GPU, the driver and the container runtime's GPU support, writes
     `.env`, and starts the stack. Running it again upgrades in place.
3. **Network.**
   - The model servers sit on an internal Docker network with no route out.
   - `fetch` alone has a route out, on a network of its own that `host-api`
     shares with it and the model servers don't.
   - `host-api` joins it and publishes one port, bound to the LAN address
     given at install, never `0.0.0.0`.
   - An optional `tailscale` service makes the stack a tailnet device of its
     own (the auth key comes from `.env` and is never logged), and serves the
     dashboard over HTTPS with Tailscale's certificate.
   - `host-api` accepts only paired clients. Any address allowlist is an
     outer check.
4. **Pairing**, as in DESIGN:
   - The host makes its key and certificate at first start, and stores them
     in its data volume, readable only by its user.
   - **Pair with Lyrica** shows a one-time code of about 16 characters,
     expiring after 10 minutes, on the dashboard and in the log.
   - The client proves it knows the code, bound to both certificates as each
     side sees them. The host pins the client's certificate.
   - Every API call after that is mutual TLS with pinned certificates.
   - Paired clients are listed on the dashboard and can be revoked.
   - Specify the exact exchange in `host/PAIRING.md` and in the PR, so Models
     2 implements the same thing.
5. **The host API** (mutual TLS):
   - an OpenAI-compatible `/v1` (chat completions with streaming and tools,
     embeddings, and models), routed to the right server;
   - an image API (create and edit) that fills **workflow templates** kept in
     `host/workflows/`, one per architecture. A request names a confirmed
     **recipe** and gives its parameters, never a workflow;
   - **recipes**, as in DESIGN ("Image models are recipes"), kept in the
     host's data folder: list, confirm or ignore a proposal, swap a part for
     another of the same role and slot, add or remove a LoRA (with strength)
     or a VAE or encoder in place of a checkpoint's own, save as a new
     recipe, delete. An upscale template for SeedVR2 (scale, largest size,
     colour matching), with starter recipes for 3B and 7B. Starter recipes for each
     supported architecture live in `host/recipes/`, with each part's file
     and checksum;
   - management: status (GPUs, VRAM, loaded and pinned models, queue,
     paused), load, unload, pin, placements, GPU settings, pause, resume,
     restart, and
     downloads (list a repository's files, start, progress, cancel).
6. **VRAM**, as in DESIGN:
   - each model's placement: Auto, or chosen GPUs (one, or several with
     llama.cpp's split ratio or vLLM's tensor or pipeline parallel), plus its
     context length (32k default) and, for vLLM, its memory share, so one
     GPU can run several vLLM models. Each vLLM model is its own server
     process under the supervisor;
   - each GPU's allowed servers (llama.cpp, vLLM, images), its free margin,
     or excluded;
   - several models of any mix on one GPU; a split model loads only when all
     its GPUs have room, and unloads from all;
   - a placement that can't work is refused when saved, with the reason;
   - each model's serving settings, saved in the data volume with its
     placement: context length, KV-cache type, flash attention, GPU layers,
     parallel requests, batch size; for vLLM its memory share, maximum
     sequences and dtype; a chat-template override. They apply at the next
     load; Reload now applies them when the model is idle. A context too big
     for the placement's memory is refused with the reason. The context
     length is reported in the model list so Lyrica plans for it;
   - pinned models;
   - least-recently-used unloading of idle models, never a pinned model or
     one in use;
   - a priority queue per GPU (chat, then images, then background work);
   - plain errors instead of running out of memory;
   - each model's VRAM use is measured at load and after its first attributable
     completed request, keeping the larger value for eviction.

   It works through each server's own API: vLLM sleep and wake, llama.cpp's
   model loading, ComfyUI's `/free`. Never the Docker socket.
7. **Pause.** Finish the current job, unload everything, and refuse new work
   with a clear "paused" error until resumed. The state survives a restart.
8. **The models folder**, set on the dashboard or in `.env`:
   - mounted read-only into the model servers;
   - llama.cpp reads GGUF files from it directly, and ComfyUI reads it through
     its extra model paths;
   - downloads go into a `lyrica/` subfolder.
9. **Downloads,** as in DESIGN, from Hugging Face, ModelScope or an https
   link, asked for by Lyrica or on the dashboard:
   - a small `fetch` service is the only container with internet access. It
     writes only to `lyrica/`, has no GPU, and has no way to the other
     containers. `host-api` asks it to list and download; never the Docker
     socket;
   - GGUF and safetensors only. Pickle formats are refused, and nothing runs
     with `trust_remote_code`;
   - each file is checked against the hub's published checksum, or the one
     given with a link (otherwise it is marked unverified). It downloads
     under a temporary name and appears only once checked;
   - https only. Every address, redirects included, is checked, refusing
     loopback, private, link-local and tailnet ranges;
   - a gated repository's token arrives with the request and is never
     written to disk;
   - free space is checked first; downloads resume after a restart and can
     be cancelled, which deletes the partial file;
   - fetch keeps a **download record** (path, size, checksum, when) in the
     host's data folder;
   - **delete** removes only a file in that record, unchanged since it was
     downloaded, after unloading it if it's loaded. Anything else is
     refused;
   - discovery reports each file's raw path and its GGUF identity metadata
     (`general.basename`, `size_label`, `finetune`, `base_model.*`), or the
     model card's `base_model` and `base_model_relation` for a download;
   - for image files, discovery reads the safetensors header only (tensor
     names, never loading the file) to report the part's role, slot,
     architecture and precision. It proposes recipes from matching parts,
     listing parts that are missing; a file whose architecture has no
     template stays a file. Scanned files are used in place;
   - deleting a recipe deletes only parts in the download record that no
     other recipe uses;
   - tests: a pickle file is refused, a wrong checksum leaves nothing
     behind, a link to a LAN address or a redirect to one is refused, the
     token never reaches disk or logs, and deleting is refused for a path
     outside `lyrica/` (including through `..` or a symlink), for a file put
     there by hand, and for a downloaded file that has since changed.
10. **The dashboard**, a small page served by `host-api` on port 7236:
   - shows GPUs and VRAM, models, the queue, and usage statistics (counts,
     tokens, images and time per model; never prompts, results or who asked;
     nothing leaves the machine);
   - controls pause, resume and restart, the models folder, downloads,
     placements, GPU settings and pins, pairing and revoking;
   - at the machine (`127.0.0.1`) it needs no login. Remotely it needs a
     password set at first start, rate-limited, over HTTPS;
   - it checks the Host and Origin headers.
11. **No prompt traces.**
    - The serving containers use the `none` log driver.
    - ComfyUI's input, output and temp folders are `tmpfs`, metadata saving
      is off, and history is cleared after each job.
    - `host-api` logs carry no text.

## Out of scope

- Lyrica's side: Models 2.
- Windows.
- Training (LoRA).
- Public internet exposure.

## Done when

- CI builds the images (CUDA and ROCm variants) and pins them. A no-GPU CI
  job runs `host-api` against fake model servers.
- Tests show that:
  - pairing succeeds only with the right code, binds both certificates, and
    fails against a machine in the middle;
  - an unpaired client is refused, and a revoked one is refused;
  - the queue respects priorities;
  - least-recently-used unloading never touches pinned or busy models, and a
    request that can't fit gets the plain error;
  - a model split over two GPUs loads only when both have room and frees
    both; two vLLM models share one GPU within their memory shares; an
    impossible placement is refused when saved;
  - pause refuses work and survives a restart;
  - image requests accept only template names and parameters;
  - the dashboard needs no login at `127.0.0.1`, needs one remotely, and
    rejects a foreign Origin;
  - no logs contain prompt text, checked with a marker string;
  - the serving containers can't reach the internet.
- `install.sh` runs on a clean Debian or Ubuntu machine (record it in the PR
  if CI can't). The README explains install, pairing and the models folder.
- `host/PAIRING.md` and the API are documented for Models 2.

## Handoff notes

All of `host/` is on main (#28, #31, #32, #33, #38, #39). CI builds both
ComfyUI images, runs every test against fake model servers and hubs, and
checks the network layout on a real Docker stack (`install.sh --no-gpu`,
then `test/stack/network.sh`). Nothing has run on a GPU, a real model or a
real hub.

### Try it on the workstation, in this order

Each step depends on the one before. Note what goes wrong against the step.

1. **Install.** `host/install.sh` on the workstation (Docker with the iptables
   backend, NVIDIA container toolkit or the amdgpu driver). It should end with
   the dashboard address and the key fingerprint, and its own check that
   host-api can't connect out should pass. Then run
   `host/test/stack/network.sh` on the real stack.
2. **Pair from Lyrica.** On the dashboard (`http://127.0.0.1:7236`), Pair with
   Lyrica, paste the code into Add model host, and check that the fingerprints
   match. Set a dashboard password and open the dashboard from another machine.
3. **A llama.cpp model.** Put a GGUF in the models folder, Scan, and chat with
   it from Lyrica. Check the context length, that the model unloads when idle,
   and the VRAM measured after load and its first completed request.
4. **A vLLM model.** A safetensors folder (no remote code). Check that its
   memory share is what the dashboard says, and that a context too long for
   the share is refused when saved. Then kill its server (or give it a context
   that can't start) and check that the load fails at once, not after 30
   minutes.
5. **A two-GPU split.** A model too big for one GPU, on Auto and then with
   chosen GPUs and a split. Check that both GPUs are used, that the model
   unloads from both, and (vLLM) that tensor parallel is picked for matching
   GPUs.
6. **Pause while gaming.** Pause, check `nvidia-smi` or `rocm-smi` shows
   nothing of the host's, play, then Resume and check pinned models load
   again.
7. **A download.** A small GGUF from Hugging Face, then a gated repository
   with a token, then a link. Check checksums, the record, resume after a
   restart, and that deleting works only on downloaded files.
8. **An image.** Install the Z-Image Turbo starter, make an image, then edit
   (Qwen-Image-Edit) and upscale (SeedVR2). This is the first time ComfyUI
   runs the templates: expect node or input names to need fixing in
   `host/workflows/`. Check that a cancelled request stops the job.

### For a future thread

- **Older AMD GPUs and integrated GPUs** (the owner's question about Vega and the
  780M):
  - ROCm's images cover gfx908, gfx90a, gfx942, gfx1030, gfx1100–1102,
    gfx1150–1151 and gfx1200–1201 (the llama.cpp ROCm image, b11459).
  - For other GPUs, `install.sh` picks Vulkan: llama.cpp only, with no vLLM
    and no images (`compose.vulkan.yaml`).
  - `--hsa-override 11.0.0` runs a 780M (gfx1103) on ROCm as gfx1100
    (`compose.hsa.yaml`). AMD doesn't support this, and it may not work.
  - An integrated GPU counts its shared memory (GTT) as well as its
    carve-out. Beside a discrete GPU it's left out by default.
  - Not checked on hardware:
    - that Vulkan numbers several GPUs in PCI order, as host-api assumes;
    - the APU list in `gpus.ts` and `install.sh`;
    - how much of GTT a model can really use.
  - On a ROCm APU, an idle llama.cpp model's shared-memory bytes still count
    as freeable for a vLLM or image placement on the carve-out, so it may be
    unloaded for nothing.
  - `keepFree` is one number per GPU and also comes off the carve-out, so a
    large value set to protect system memory can rule out vLLM and images on
    an integrated GPU.
- **Image VRAM** is measured per recipe, not per part, and unloading one
  recipe frees all of ComfyUI's memory.
- **`gpuLayers`** below "all" doesn't shrink the expected memory.
- **The KV-cache estimate** comes from model headers and hasn't been checked
  against real servers. If plans are off, compare with the measured VRAM
  (`vram` in the model list).
- **The Host images CI job** runs only when the image files change, so it
  can't be a required check as it stands.
- **The pinned images** (llama.cpp, vLLM, both ComfyUI bases, Tailscale) are
  pinned by digest. Updating one means a new digest and a CI build. ComfyUI's
  Python packages are remade with `host/comfyui/lock.sh`.
