# Lyrica model host

Turns a Linux GPU machine (NVIDIA or AMD) into a model host for Lyrica: a
Docker Compose stack that Lyrica reaches over mutual TLS after pairing.

- [PAIRING.md](PAIRING.md): how Lyrica and a host come to trust each other.
- [API.md](API.md): what Lyrica can call.

## Install

The machine needs:
- Debian or Ubuntu (other Linux distributions should work), with iptables;
- the GPU driver;
- Docker with the compose plugin, and its iptables firewall backend (the
  default). Podman isn't supported yet;
- the container runtime's GPU support. For NVIDIA, that's
  `nvidia-container-toolkit`.

```sh
git clone https://github.com/xlc2022/lyrica && cd lyrica
host/install.sh
```

`install.sh` does the following:
- checks the GPU, the driver and the container runtime's GPU support;
- asks for the host's name, the LAN address and the models folder;
- writes `host/.env`;
- builds and starts the stack;
- offers to set a dashboard password.

To upgrade, or to change a setting, run it again: `git pull && host/install.sh`.
Options: `host/install.sh --help`.

### AMD GPUs

ROCm runs llama.cpp, vLLM and images, but only on the GPUs its images are
built for: gfx908, gfx90a, gfx942, gfx1030 (RX 6800/6900), gfx1100–1102 (RX
7000), gfx1150–1151 and gfx1200–1201 (RX 9000). For any other AMD GPU, such as
Vega or a Radeon 780M, `install.sh` picks **Vulkan**. It serves llama.cpp
models only: no vLLM and no images.
- `--amd-backend rocm|vulkan` chooses one yourself. It's kept in `.env` as
  `GPU_BACKEND`; empty it and run `install.sh` again to go back to choosing
  automatically.
- `--hsa-override 11.0.0` runs a GPU on ROCm as a close one it supports: a
  780M (gfx1103) as gfx1100. AMD doesn't support this; it works on some
  machines and not others. It applies to every GPU, so `install.sh` warns
  when a discrete GPU ROCm already supports is there too.
  `--hsa-override none` clears it.
- An integrated GPU has a small BIOS carve-out and can also use shared
  system memory (GTT). Which one a server can use:
  - llama.cpp on Vulkan: both.
  - llama.cpp on ROCm: both on an APU without a discrete GPU (`install.sh`
    turns on unified memory, `compose.apu.yaml`); otherwise the carve-out.
  - vLLM and images: the carve-out only. On ROCm an integrated GPU runs
    llama.cpp only unless you allow more on the dashboard.

  Set what it keeps free on the dashboard to leave the system enough memory.
  Beside a discrete GPU, an integrated one is left out until you include it.

With `--tailscale NAME`, the stack joins your tailnet as a device of its own,
named `NAME`. It asks once for an auth key, which is removed from `.env` once
the device has joined. With `--no-lan` as well, the host is reachable only
over Tailscale.

## The dashboard

- **At the machine:** `http://127.0.0.1:7236`, with no login.
- **From the LAN:** `https://<LAN address>:7236`, with the password. The
  certificate is the host's own: check its fingerprint against the one
  `install.sh` printed.
- **Over Tailscale:** `https://NAME.<tailnet>.ts.net`, with the password and
  Tailscale's certificate.

The password is set at the machine, either by `install.sh` or on the
dashboard. Until it is set, the dashboard opens only at the machine. Five
wrong tries in 15 minutes from one address, or 20 in all, lock the login
until the window passes. The dashboard refuses requests whose Host or
Origin isn't the host's own.

## The models folder

The models folder is given at install (`--models`, default `/srv/models`) and
mounted read-only into the containers. It can be a folder another program
also uses, such as LM Studio's. To change it, run
`host/install.sh --models /new/path`. host-api can't remount containers
itself, because it has no access to the Docker socket.

## Downloads

Downloads come from Hugging Face, ModelScope or an https link, asked for by
Lyrica or on the dashboard. They go into the models folder's `lyrica/`
subfolder, under `lyrica/<source>/<repository>/`.
- Only GGUF, safetensors and ONNX files are downloaded, with the small
  files a model folder needs and a voice model's voices (plain arrays of
  numbers, checked when they arrive). Pickle formats and code are refused.
- Each file arrives under a temporary name and is checked against the
  hub's checksum (SHA-256, or the git hash for small files) before it
  appears. A link without a checksum is kept, marked unverified.
- Links and redirects must go to public addresses: never this machine, the
  LAN or the tailnet. A link must say its size, and a signed link's query
  string is never written down. Links are short (1024 characters), one at
  a time, and Downloads shows each in full while it downloads: a link is a
  way data could leave this machine, so check ones you don't recognise.
- A gated repository's token is used for that download only, and never
  written down. A gated download interrupted by a restart must be started
  again; it resumes from its partial file.
- Free space is checked first, counting downloads already queued, and no
  file grows past its size. Downloads resume after a restart (a busy server
  or a broken connection keeps the partial file) and can be cancelled,
  which deletes the partial file. A sharded model appears once all its
  shards are here.
- The **download record** lists each file downloaded, with its size and
  checksum. **Delete** removes only a file in it, inside `lyrica/` with no
  symlink on the way, unchanged since it was downloaded. A loaded model is
  unloaded first. Nothing else is ever deleted.

## Image models

Images are made by ComfyUI, from **recipes**: a diffusion model (or a
checkpoint), its text encoders and VAE, any LoRAs, and default settings.
Lyrica asks for an image by recipe, never by file or workflow; host-api
fills the recipe's template in `workflows/` (one per architecture).
- **Starters** (`recipes/`) are known-good recipes, with each part's
  checksum. Install downloads only the parts that aren't here.
- **Scanning** reads each safetensors header (tensor names only) to tell a
  part's role, slot, architecture and precision, and proposes recipes from
  matching parts. A proposal does nothing until it is confirmed. A file
  whose architecture has no template stays a file.
- Deleting a recipe deletes only parts the host downloaded, unchanged, that
  no other recipe uses.
- ComfyUI is our image (`comfyui/Dockerfile`, CUDA or ROCm), built from
  pinned commits of ComfyUI, ComfyUI-GGUF and the SeedVR2 upscaler, with no
  plugin manager. Only those nodes load. Their Python packages go into a
  venv, each pinned with its hash in `comfyui/requirements.txt`
  (`comfyui/lock.sh` remakes it); torch is the base image's. It has no route out, logs nothing,
  keeps its input, output and temp folders in memory, saves no metadata,
  and its history is cleared after every job. It uses one GPU,
  `COMFY_GPU` in `.env`, and frees its memory after ten idle minutes.
  A ComfyUI that is off, or doesn't answer a request within 30 seconds,
  fails that job as `unavailable`, and the next job still runs.

## Dictation and voice

- **Dictation** models (Whisper, Voxtral) are safetensors folders, served by
  vLLM on `/v1/audio/transcriptions` and placed like any vLLM model.
- **Voice** models are Kokoro's ONNX export: a folder with its `.onnx` file,
  its vocabulary and `voices/`. The speech server (`speech/`, our image)
  reads them in English and Mandarin, including English words in Mandarin
  text, and streams the audio on `/v1/audio/speech`. Voices in other
  languages are left out.
  - It runs on one GPU on an NVIDIA host (CUDA), and on the CPU elsewhere;
    Kokoro is small enough for either.
  - Like the model servers, it is on the `models` network only, logs
    nothing, runs read-only with no capabilities, and writes only to its
    `/tmp` tmpfs. That tmpfs allows running files, because the phonemizer
    loads espeak-ng from a copy it makes there. Text it reads is never kept.
  - Every package is pinned with its hash (`speech/requirements.*.txt`;
    `speech/lock.sh` remakes them), so nothing is fetched at run time.
- **Starters**, pinned to the revisions that were benchmarked. Download
  them on the dashboard or with `POST /host/v1/downloads`:
  - the voice (Li's pick from the benchmark):
    `onnx-community/Kokoro-82M-v1.1-zh-ONNX` at
    `6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3`: `onnx/model.onnx`,
    `config.json`, `tokenizer.json`, `tokenizer_config.json` and every
    `voices/*.bin` (about 330 MB with all 103 voices);
  - dictation: `openai/whisper-large-v3-turbo` at
    `41f01f3fe87f28c78e2fbf8b568835947dd65ed9`: `model.safetensors` and
    its JSON and text files (about 1.6 GB).
- **Keeping them loaded.** Pin both, so speaking and dictation never wait
  for a load. Whisper takes about 2.2 GB of a GPU and Kokoro about 1 GB.
  On a host with one large GPU, place both on it (Whisper with a vLLM
  memory share of 0.1 on a 24 GB card) and leave the rest for chat.
  On an RTX 3090 Kokoro starts speaking in about 0.3 s; it is quick
  enough on the CPU alone too, about 1.3 s for a 5-second sentence.
- `bench/speech/` compares voice and dictation models on a Windows machine
  with an NVIDIA GPU, and makes samples to listen to.

## Pairing

1. On the dashboard, choose **Pair with Lyrica**. A code like
   `7KQ2-M9XD-4RTB-W1HZ` appears there and in the log
   (`docker compose logs host-api`). It works once, for 10 minutes.
2. In Lyrica, on the Models page under **Hosts and endpoints**, choose
   **Add model host**. Give it a name, the host's addresses
   (`192.168.1.20`, or its tailnet name) and the code.

Paired Lyrica servers are listed on the dashboard, where they can be
revoked. A revoked server must pair again.

## Models and GPUs

- **Text models** are found by scanning the models folder:
  - GGUF files are served by llama.cpp. A file whose name starts with
    `mmproj` next to one is its vision projector, and split files count as
    one model.
  - Folders with a `config.json` and safetensors are served by vLLM. A model
    whose config asks for remote code is listed but never loaded.
  - Voice models (see above) are served by the speech server, on one GPU
    or the CPU. Their only setting is the placement.
- **Each model has a placement** and serving settings, set on the dashboard
  or through the API:
  - Auto (the default): one GPU with room, preferring one where nothing
    must be unloaded, else split over every GPU that allows its server.
  - Or chosen GPUs: one, or several, split by ratio (llama.cpp) or by
    tensor or pipeline parallel (vLLM).
  - Its context length (32k by default), KV-cache type, flash attention, GPU
    layers, parallel requests, batch size, a chat template, and for vLLM a
    memory share, so several vLLM models can share one GPU (each is its own
    server).
  - Settings apply at the next load, or now with Reload. A placement that
    can't work is refused when it's saved, with the reason.
- **Each GPU** says which servers it may run (llama.cpp, vLLM, images, speech), how
  much memory to keep free, or that it is left out. It can hold several
  models of any mix; a split model loads only when all its GPUs have room
  and unloads from all at once.
- **Pinned** models are loaded at start and never unloaded to make room.
- **Making room.** When a model needs room, idle models are unloaded, least
  recently used first. A pinned model or one in use is never unloaded.
  A model that can never fit fails at once, saying why.
- **Queues.** Requests wait in a queue per GPU: chat first, then images,
  then background work. A request that waits too long fails with "The GPU
  is busy with …".
- **VRAM** use is measured per GPU on each model's first load with a
  placement (an image recipe's on its first job), and remembered until its
  settings change.
- **Pause** refuses new work, lets the current job finish, then unloads
  every model and stops vLLM, so nothing of the host's stays in VRAM. What
  couldn't be unloaded shows on the dashboard. Until Resume, new work gets
  "The model host is paused." Pause survives a restart.

## How it's put together

- `host-api` (this folder's `src/`): TypeScript run by Node 22, with no npm
  dependencies. It is the only service with published ports:
  - `127.0.0.1:7236` for the dashboard at the machine. The container accepts
    that listener only from Docker's gateway address, which is where
    published loopback traffic arrives.
  - `<LAN address>:7236` for everything else, over TLS 1.3. It is never
    published on every interface, because Docker's published ports bypass
    the machine's firewall.
- The model servers are the official llama.cpp and vLLM images, pinned by
  digest. `compose.nvidia.yaml` uses CUDA images, `compose.amd.yaml` ROCm,
  and `compose.vulkan.yaml` Vulkan (llama.cpp only); `install.sh` picks one,
  and for ROCm adds `compose.hsa.yaml` for `--hsa-override` and
  `compose.apu.yaml` (unified memory) on an APU alone. They log nothing (Docker's `none` log
  driver).
  - llama.cpp runs in router mode. host-api writes its preset file (each
    model's file, GPU and context), then loads and unloads models through
    its API.
  - vLLM runs under `vllm/supervisor.py`, which starts one server per vLLM
    model on its GPUs as host-api asks in a file, in its own process group, with a growing
    wait between restarts of one that crashes. It reports servers that
    exited in the `vllm-status` volume, so a load that can't start fails at
    once.
  - host-api reads VRAM with `nvidia-smi`, through NVIDIA's `utility`
    capability, or from AMD's sysfs (with GTT for an integrated GPU). With
    ROCm, AMD GPUs are numbered as ROCm numbers them; with Vulkan, by PCI
    address. Without a KFD topology (no `/dev/kfd`), integrated GPUs can't be
    recognised, so their shared memory isn't counted.
- `speech` (`speech/`): our image, a small Python server around ONNX
  Runtime that loads and unloads voice models as host-api asks. The CPU
  build is in `compose.yaml`; `compose.nvidia.yaml` builds it for CUDA.
- `fetch` (`src/fetch/`) does the downloads. It is the same image as
  host-api, with another command.
  - It is the only container that goes out, on the `egress` network,
    alone. It reaches nothing else: host-api calls it over the internal
    `fetch-api` network, and it isn't on `models`.
  - It mounts only `lyrica/`, read-write, and has no GPU.
  - It answers only host-api's address. The download record and list are
    in its own `fetch-data` volume.
- **host-api has no route out.** It sees every prompt, so it may not start
  a connection anywhere, and neither may anything on the `models` network.
  - `models` is internal: host-api and the model servers. No route out, and
    nothing outside can reach it.
  - `edge` holds host-api alone, at a fixed address (`HOST_API_IP` in
    `.env`). The published ports arrive there.
    - Docker doesn't masquerade it.
    - `egress.sh` adds iptables rules (a `LYRICA-HOST-API` chain, called
      from `DOCKER-USER` and `INPUT`) that let replies through and drop
      every connection host-api starts, to the internet or to this
      machine, including DNS for outside names.
    - `install.sh` applies the rules before starting the stack, and installs
      `lyrica-host-egress.service`, which applies them before Docker starts
      at boot, and again on every Docker restart.
    - host-api's DNS server is a blackhole address: container names still
      resolve, outside names never do. Its networks have no IPv6.
    - Without systemd, run `host/egress.sh apply` yourself after each.
    - `install.sh` checks that host-api can't connect out, and stops it
      if it can.
  - With Tailscale, the `tailscale` service has its own network out
    (`tailnet`) and reaches host-api over an internal one
    (`tailscale-api`). It runs with no capabilities. All sign-ins over
    Tailscale come from its address, so they share one rate limit.
- No container mounts the Docker socket.
- Volumes:
  - `data`: host-api's key, certificate and state (below).
  - `fetch-data`: fetch's download record and list.
  - `serving`: what host-api asks of the model servers (llama.cpp's preset,
    vLLM's wanted servers, chat templates, SeedVR2's links); read-only for
    them.
  - `vllm-status`: the vLLM supervisor's report of servers that exited;
    read-only for host-api.
  - `tailscale` (with Tailscale only): the tailscale container's node
    state, so the machine keeps its tailnet identity across restarts.
  - The models folder is mounted read-only everywhere except its `lyrica/`
    subfolder, which only fetch writes.
- The host's key, certificate and state are in the `data` volume, readable
  only by host-api's user. The state is paired clients, the password hash,
  pause, GPU settings, model placements and serving settings, pins,
  measured VRAM and usage counts. Prompts are never stored, and host-api's log has no text: only
  event names, IDs and counts, plus the pairing code while it's valid.
- Images are pinned by digest. `host-api` is built from this checkout by
  `install.sh`, and CI builds it on every pull request.
- `test/stack/network.sh` checks the network layout on a running stack.

The local dashboard's address check and the egress rules assume Docker's
port publishing and its iptables firewall backend. After a firewall reload
that flushes INPUT, run `systemctl restart lyrica-host-egress`.
