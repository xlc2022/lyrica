# Lyrica model host

Turns a Linux GPU machine (NVIDIA or AMD) into a model host for Lyrica: a
Docker Compose stack that Lyrica reaches over mutual TLS after pairing.

- [PAIRING.md](PAIRING.md): how Lyrica and a host come to trust each other.
- [API.md](API.md): what Lyrica can call.

## Install

The machine needs:
- Debian or Ubuntu (other Linux distributions should work), with iptables,
  or NixOS (see "On NixOS" below);
- the GPU driver;
- Docker with the compose plugin, and its iptables firewall backend (the
  default). Podman isn't supported;
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
- builds and starts the stack, then removes the images its containers ran
  before and no longer run (only this stack's, so an update leaves no old
  images behind; a rollback builds or pulls its own again);
- offers to set a dashboard password.

To change a setting, run it again. To upgrade, press **Update** in Lyrica's
Models page (see Updates below), or `git pull && host/install.sh`.
Options: `host/install.sh --help`.

### Updates

Lyrica updates a host to the release she runs herself. On systemd machines
other than NixOS, `install.sh` installs the updater: a copy of `update.sh` at
`/usr/local/sbin/lyrica-host-update` (an update never replaces it) and
`lyrica-host-update.path`, which runs it as root when host-api writes a
request into `/var/lib/lyrica-host-update/inbox/`. host-api keeps no route
out: the updater fetches `main` and the `update/*` tags into its own
repository there with a read-only deploy key, `/etc/lyrica-host/deploy-key`,
which `install.sh` prints the first time: add it to the repository as a
deploy key. Then the updater refuses a tag that isn't annotated or isn't on
`main`; pauses the host (running jobs finish, up to 10 minutes, or nothing
changes); unpacks the release from its own repository into a root-owned
tree, `/opt/lyrica-host/<commit>`; carries `.env` over from the installed
folder; runs that tree's `install.sh --yes`; and waits up to 5 minutes for
host-api to answer with the new commit. If it doesn't, it installs the
commit before from its own tree the same way. Root never runs code from your
checkout, only reads its `.env`, whose settings (the models folder, the
addresses) it trusts as you chose them at install. The last 3 trees are kept, and the running
one is the installed folder from then on: change a setting by running
`sudo ./install.sh` there (the tree is root's; it keeps the release `.env`
records), or `git pull && host/install.sh` in your checkout to go
back to it. The host resumes unless it was paused before. Its progress is in
`/var/lib/lyrica-host-update/status/state.json` and the host's status; by
hand: `sudo lyrica-host-update --tag update/<name>`.

### On NixOS

NixOS can't have packages or units installed by a script, so the flake's
`model-host` module declares what `install.sh` needs: Docker (iptables
backend), the GPU driver, `iptables`, `git` and `curl`, the models folder,
and `lyrica-host-egress.service`. Add it to the machine's flake
configuration, beside `services.lyrica` if Lyrica runs there too:

```nix
inputs.lyrica.url = "github:xlc2022/lyrica";
# in nixosSystem's modules:
lyrica.nixosModules.model-host
{
  services.lyrica-host.enable = true;
  services.lyrica-host.gpu = "nvidia";      # or "amd", or "none"
  services.lyrica-host.checkout = "/srv/lyrica-host"; # where you clone the repo
  services.lyrica-host.modelsDir = "/srv/models";     # the default; created if missing
  nixpkgs.config.allowUnfree = true;        # NVIDIA's driver is unfree
  users.users.you.extraGroups = [ "docker" ]; # the user who runs install.sh
}
```

Then `nixos-rebuild switch`, clone the repo to `checkout` (never
`/opt/lyrica`, which is lyricad's), and run `host/install.sh` from it as on
Debian, giving it the same models folder as `modelsDir` (the module creates
it and its `lyrica/` subfolder). With `gpu = "nvidia"`, the driver
uses NVIDIA's open kernel modules (Turing or newer; set
`hardware.nvidia.open = false` for older cards) and Docker reaches the GPUs
through the container toolkit's CDI devices: `install.sh` sees the CDI spec
and adds `compose.cdi.yaml`. With `gpu = "amd"`, `amdgpu` loads at boot;
ROCm and Vulkan come inside the images. In a VM, pass the whole GPU through
(on Proxmox, a PCI device with All Functions and PCI-Express on a q35
machine). Upgrading is `git pull && host/install.sh`: Lyrica shows the
host's version but can't update it, since the configuration names the checkout.

### gpu-unlock

Optional, for GeForce RTX 20/30/40 cards: full-rate FP16/BF16 tensor math,
unlocked at boot by [gpu-unlock](https://github.com/Zagitta/gpu-unlock)'s
kernel module. On NixOS, `services.lyrica-host.gpuUnlock.enable = true`
builds the module for the configured kernel, adds NVIDIA's firmware and the
module to the initrd (so it runs before `nvidia`, which loads in stage 2)
and sets `gpu_unlock.targets=all`. On Debian or Ubuntu, `host/gpu-unlock.sh`
builds upstream's DKMS packages and adds the parameter to GRUB;
`--remove` undoes it. `install.sh` and updates never run it. Both pin
the same upstream commit and NVIDIA inputs (`nix/gpu-unlock.nix`); change
them together. See docs/guides/model-hosts.md, "Full-rate tensor math".

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
Origin isn't the host's own; only its page itself opens from a link
elsewhere, such as Lyrica's **Dashboard** link, and what the page then
asks for is same-origin.

The page has Lyrica's look (docs/ux.md), with its fonts served by the host
itself: the host's name, state and facts at the top, with **Pause** or
**Resume** and a ⋯ (Restart…, Sign out), and sections down the left (a
row on a phone): GPUs, Models, Image models, Downloads, Usage, Lyrica
servers and Password. A GPU's servers, the memory it keeps free and Left
out are edited in its drawer (**Edit**); a model's placement and serving
settings in its **Settings** drawer, where **Look up** reads its card.
Under the model list, **Starters** offers models to begin with, each
downloaded at a pinned revision: Qwen3.8 27B (Unsloth's UD-Q4_K_M with its
vision projector, for a 24 GB GPU), GLM 5.3 Flash (Unsloth's UD-Q3_K_XL in
four parts with its projector, about 149 GB, for two 96 GB GPUs), Qwen3.5 9B
(Q4_K_M with its projector), Qwen3 Embedding 0.6B (Q8_0), and the voice and
dictation models named in docs/guides/model-hosts.md. Only those the host's
servers run are listed, on a GPU or the CPU, and one too big says so: for
llama.cpp, too big for all the GPUs that allow it together, since it splits
a model over them; for the other servers, too big for every one of them.

## The models folder

The models folder is given at install (`--models`, default `/srv/models`) and
mounted read-only into the containers. It can be a folder another program
also uses, such as LM Studio's. Its `lyrica/` subfolder must be a folder, not
a link. `install.sh` gives it to the download service's user (10001) with
mode 755, so the model servers, which run as other users, can read it. To change it, run `host/install.sh --models /new/path`, or use
**Change** beside the folder on the host's card in Lyrica's Models page.
host-api can't remount containers itself, because it has no access to the
Docker socket, so Change goes through the updater (Updates above), as root:
it refuses a folder that doesn't exist, is or lies in a system folder (`/`,
`/etc`, `/usr`, `/var/lib` and the like), holds or lies in the host's own
files (the installed folder, the updater's, its trees and
`/etc/lyrica-host`), or that someone else could change before it is
mounted: the folder and every folder above it must be owned by root or by
the current models folder's owner, with no group or other write (above
it, a sticky folder such as `/tmp` is fine). That also refuses anything
under a `lyrica/` subfolder. Any other folder is the paired server's to
choose, and the model servers and host-api then read it. Then it pauses the host, installs the running commit
again from its own tree with `install.sh --yes --models <folder>`, and goes
back to the old folder if host-api doesn't answer with the new one within 5
minutes. No files move. By hand: `sudo lyrica-host-update --models <folder>`.
Only an updater installed by a `host/install.sh` run from this release on
takes a folder (an update never replaces the updater), and NixOS has no
updater: there, set `modelsDir` and run `install.sh --models`.

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
  file grows past its size. A broken connection, a stalled transfer or a
  busy server is tried again from where it stopped, after 5 s, 15 s, 30 s,
  1 and 2 minutes; the count starts over whenever a try got further, and
  the download fails only after five tries in a row get nowhere. While it
  waits it still shows as downloading. Downloads resume after a restart (a
  busy server or a broken connection keeps the partial file), and a failed
  one resumes when the same file is downloaded again while the failed one
  is still listed. They can be cancelled,
  which deletes the partial file. Clearing a failed download deletes its
  partial file too, and on start fetch deletes any partial file no listed
  download can resume. A sharded model appears once all its
  shards are here.
- The **download record** (`GET /host/v1/files`) lists each file downloaded,
  with its size and checksum. `DELETE /host/v1/files` removes only a file in
  it, inside `lyrica/` with no symlink on the way, unchanged since it was
  downloaded. A loaded model is unloaded first. Nothing else is ever
  deleted. (The dashboard's Delete is for image recipes.)

## Image models

Images are made by ComfyUI, from **recipes**: a diffusion model (or a
checkpoint), its text encoders and VAE, any LoRAs, and default settings.
Lyrica asks for an image by recipe, never by file or workflow; host-api
fills the recipe's template in `workflows/` (one per architecture). Recipes
live in `recipes.json`; the optional `useFor` tag is `fast`, `quality` or
`both`, with older recipes reading as both. Models → Image models saves it
per host, and Lyrica's router filters create tiers by it.
- **Starters** (`recipes/`) are known-good recipes, with each part's
  checksum. Install downloads only the parts that aren't here.
  A starter can be for one way of making images only: Krea 2 Turbo Q5
  (GGUFs, about 13.4 GB, for 16 GB cards) is listed only on hosts using
  stable-diffusion.cpp.
  The video starters (Wan 2.2 TI2V 5B, T2V 14B and I2V 14B, LTX-2.5
  Distilled, MiniMax H3 Turbo) are for ComfyUI hosts only. Wan 2.2 is
  Apache 2.0. LTX-2.5's repository is gated: installing it needs a
  Hugging Face token whose account accepted its licence, the LTX-2.x
  Community License (free under $10M yearly revenue). The hub hides a
  gated repository's checksums, so that starter has none pinned: the host
  checks each file against the hub's checksum when it downloads it with the
  token. MiniMax H3's licence
  forbids using, hosting or running it, or using what it makes, in the US,
  the EU, the UK and South Korea; the operator checks where the host and
  its users are before installing it. H3 and LTX-2.5 fit a 96 GB card;
  Wan 2.2 fits a 24 GB one. SCAIL-2 (ComfyUI hosts only, about 28 GB of
  files) moves an image's subject as the person in a driving clip moves:
  on a 3090 a 5 s clip at 1280×704 took about 14 minutes at 21 GB. Its
  weights are MIT; it finds people with SAM 3.1, under Meta's SAM License,
  which allows commercial use but asks that publications acknowledge SAM,
  that use follows the law (privacy law included) and trade controls, and
  that SAM isn't reverse engineered.
  Krea 2 Turbo's weights are under the Krea 2 Community License, which
  requires content filtering wherever it runs; the host filters nothing,
  so the operator who installs it sets that up. Qwen-Image 2.1 Turbo's
  weights are under the Qwen Research License (research and evaluation
  only, no commercial use without Qwen's separate licence).
- **Scanning** reads each safetensors header (tensor names only) to tell a
  part's role, slot, architecture and precision, and proposes recipes from
  matching parts (GGUFs by their metadata; a text model's GGUF is not a
  part, except Qwen3-VL 4B, which is also Krea 2's text encoder). A
  proposal does nothing until it is confirmed. A file whose architecture
  has no template stays a file. Installing a starter whose main file a
  scan already proposed makes that proposal the starter's recipe.
- A recipe too big for the image GPU, even empty, or whose template this
  host doesn't have, does nothing and says why, so Lyrica never offers it.
- Deleting a recipe deletes only parts the host downloaded, unchanged, that
  no other recipe uses and that aren't also a chat model.
- ComfyUI is our image (`comfyui/Dockerfile`, CUDA or ROCm), built from
  pinned commits of ComfyUI, ComfyUI-GGUF, the SeedVR2 upscaler and LanPaint
  (masked edits on Qwen-Image 2.1), with no plugin manager, plus our own
  `comfyui/websocket_video_save.py`, which sends a clip and its poster
  back over the websocket, and `comfyui/video_frames.py`, which picks a
  driving clip's frames at the model's frame rate. Only those nodes load. Their Python packages go into a
  venv, each pinned with its hash in `comfyui/requirements.txt`
  (`comfyui/lock.sh` remakes it); torch is the base image's. It has no
  route out, logs nothing, keeps its input, output and temp folders in
  memory, saves no metadata, and its history is cleared after every job.
  A job's uploads are overwritten with a blank image after it, and
  `gate.py` empties those folders whenever it starts or stops ComfyUI, so a
  crash mid-job leaves no photo behind either.
  It uses one GPU, `COMFY_GPU` in `.env`. It runs only while a recipe is
  loaded: freeing its models leaves its CUDA context (a few hundred MiB)
  until the process exits. `comfyui/gate.py`, its container's entry point,
  starts and stops it as host-api asks in `serving/comfyui.json`, and names
  the run it started in the `comfyui-status` volume, so host-api waits for
  that one. It stops two seconds after its last recipe unloads (ten idle
  minutes after a job), at once on Pause, and starts for the next image
  job, which then waits while it starts.
  A ComfyUI that is off, or doesn't answer a request within 30 seconds,
  fails that job as `unavailable`, and the next job still runs.
- **Videos** come from video recipes, through the same ComfyUI, one clip
  per job (API.md, "Making videos"). A clip can take from a few minutes
  to most of an hour, and holds ComfyUI's GPU until it is done; on a host
  with two GPUs, `COMFY_GPU` names the one for images and videos and the
  other serves chat. One clip isn't split over two GPUs.
- At start the gate checks that the image's PyTorch has kernels for the
  GPU (its compute capability against `torch.cuda.get_arch_list()`), in a
  process that holds the GPU only for those few seconds. If it
  has none, ComfyUI never starts, the container reports unhealthy, image
  jobs fail at once saying why, and the dashboard and status list it under
  problems.
- A recipe takes the memory of its largest stage plus its VAEs: the text
  encoders, or the diffusion model or checkpoint with its LoRAs (one of a
  video model's two experts at a time), or an upscaler. ComfyUI runs them in turn and frees one stage's models when the
  next needs the room, so a recipe whose parts add up to more than the GPU
  can still run.
- When `COMFY_GPU` is a CMP 100-210 (PCI ID `10de:1df4`), whose FP16 tensor
  cores are throttled, `install.sh` adds `compose.sdcpp.yaml` and ComfyUI
  isn't started. stable-diffusion.cpp's `sd-server` (`sdcpp/Dockerfile`, a
  pinned commit built with `GGML_CUDA_FORCE_MMQ`, pulled or built like the
  CMP's llama.cpp below) makes the images instead:
  it converts the recipe's parts to Q8_0 as it loads them (unless the
  diffusion model is a GGUF, whose own quantisation is kept, since a Q8_0
  copy may not fit) and runs with flash attention off, so the work goes to
  the card's int8 units. It
  creates only, for Z-Image, Qwen-Image, Krea 2, FLUX and SDXL recipes without
  LoRAs; the recipe list shows edit, upscale and other recipes as unsupported, saying why. It takes its model
  as start-up arguments, so `sdcpp/gate.sh` starts it for the recipe
  host-api names in `serving/sdcpp.json`, reports the run in the
  `sdcpp-status` volume, and stops it when the recipe unloads. A job for
  another recipe starts it again first. It runs as the user that downloads
  the models (10001), so it reads them whatever the mode of `lyrica/`.
  Like ComfyUI it has no route out, logs nothing and saves nothing; its jobs' images stay in its memory for
  ten minutes.

## Dictation and voice

- **Dictation** models (Whisper, Voxtral) are safetensors folders, served by
  vLLM on `/v1/audio/transcriptions` and placed like any vLLM model.
  - On a host with a CMP 100-210, whose sm_70 vLLM has no kernels for,
    `install.sh` adds `compose.whisper.yaml` and dictation runs on
    whisper.cpp instead: `whisper-server` (`whispercpp/Dockerfile`, v1.9.5
    built with `GGML_CUDA_FORCE_MMQ`, pulled or built like the CMP's
    llama.cpp) serves whisper.cpp model files (`ggml-*.bin`, checked for
    ggml's magic when downloaded and listed) with flash attention on. It
    takes its model as start-up arguments, so `whispercpp/gate.sh` starts
    it for the model and GPU host-api names in `serving/whisper.json` and
    stops it when the model unloads. It holds one model at a time, so
    loading another unloads the first. It takes WAV only,
    falls under the GPUs' speech setting, runs as 10001, has no route out,
    logs nothing and saves nothing. On danube's CMP, large-v3-turbo q8_0
    transcribes 180 s of English in about 6 s. Only that host's own
    dictation server's models are listed.
- **Voice** models are Kokoro's ONNX export: a folder with its `.onnx` file,
  its vocabulary and `voices/`. The speech server (`speech/`, our image)
  reads them in English and Mandarin, including English words in Mandarin
  text, and streams the audio on `/v1/audio/speech`. Voices in other
  languages are left out.
  - It runs on one GPU on an NVIDIA host (CUDA), and on the CPU elsewhere;
    Kokoro is small enough for either. On a host with a CMP 100-210,
    `compose.cmp.speech.yaml` builds it with an older cuDNN that still has
    Volta kernels (`requirements.cuda-volta.txt`), so a Blackwell card
    beside the CMP can't run voices. It runs as the user that
    downloads the models (10001), so it reads them whatever the mode of
    `lyrica/`. Once nothing is loaded, a server
    that has used a GPU exits and Docker starts it again, since ONNX
    Runtime keeps its CUDA context until the process exits.
  - Like the model servers, it is on the `models` network only, logs
    nothing, runs read-only with no capabilities, and writes only to its
    `/tmp` tmpfs. That tmpfs allows running files, because the phonemizer
    loads espeak-ng from a copy it makes there. Text it reads is never kept.
  - Every package is pinned with its hash (`speech/requirements.*.txt`;
    `speech/lock.sh` remakes them), so nothing is fetched at run time.
- **Starters**, pinned to the revisions that were benchmarked. Download
  them on the dashboard or with `POST /host/v1/downloads`:
  - the voice (the owner's pick from the benchmark):
    `onnx-community/Kokoro-82M-v1.1-zh-ONNX` at
    `6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3`: `onnx/model.onnx`,
    `config.json`, `tokenizer.json`, `tokenizer_config.json` and every
    `voices/*.bin` (about 330 MB with all 103 voices);
  - dictation: `openai/whisper-large-v3-turbo` at
    `41f01f3fe87f28c78e2fbf8b568835947dd65ed9`: `model.safetensors` and
    its JSON and text files (about 1.6 GB); on a host with a CMP,
    `ggerganov/whisper.cpp` at `5359861c739e955e79d9a303bcbc70fb988958b1`:
    `ggml-large-v3-turbo-q8_0.bin` (about 874 MB).
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
   `7KQ2-M9XD-4RTB-W1HZ` appears there; it is never logged. It works once,
   for 10 minutes.
2. In Lyrica, add the host with its addresses (`192.168.1.20`, or its
   tailnet name) and the code. The steps are in the
   [model hosts guide](../docs/guides/model-hosts.md#pair-it-with-lyrica).

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
  - Its context length (32k by default, or more with a YaRN stretch),
    KV-cache type, flash attention, GPU layers, System RAM (Auto or Off:
    whether it may use the host's allowance), Embedding table (Disk or
    RAM: where llama.cpp reads a per-layer embedding table over 4 GiB
    from; RAM takes it from the allowance), parallel requests, batch
    size, a chat template, and for vLLM a memory share, so several vLLM
    models can share one GPU (each is its own server).
  - A chat model serves 1 request at a time below a 200k context, 2 from
    200k and 4 from 500k, sharing one cache of its context, unless its
    parallel requests (llama.cpp) or max sequences (vLLM) say otherwise.
  - Settings apply at the next load, or now with Reload. A placement that
    can't work is refused when it's saved, with the reason.
- **Each GPU** says which servers it may run (llama.cpp, vLLM, images,
  speech), how much memory to keep free, or that it is left out. It can
  hold several models of any mix; a split model loads only when all its GPUs have room
  and unloads from all at once.
- **Pinned** models are loaded at start and never unloaded to make room.
- **Making room.** When a model needs room, idle models are unloaded, least
  recently used first. A pinned model or one in use is never unloaded.
  A model that can never fit fails at once, saying why.
- **Queues.** Requests wait in a queue per GPU: chat first, then images,
  then background work. A request that waits too long fails with "The GPU
  is busy with …", except a `/v1` request tagged with `X-Lyrica-Job`,
  which waits up to 15 minutes (API.md, "Job progress").
- **VRAM** use is measured per GPU at load and after the first attributable
  completed request (an image recipe's on its first job). The host keeps the
  larger measurement, including buffers grown on first use, until settings
  change. If another model serves or memory changes during the request, the
  host retries measurement on a later request.
- **At start** host-api unloads every model llama.cpp still holds that it
  didn't load itself, such as those loaded before host-api alone restarted
  (a re-run of `install.sh` that doesn't restart llama.cpp), so their memory
  isn't counted as other programs'. If llama.cpp isn't answering then,
  `docker restart lyrica-host-llamacpp-1` clears it.
- **Pause** refuses new work, lets the current job finish, then unloads
  every model and stops vLLM and ComfyUI, and the speech server restarts
  if it used a GPU, so nothing of the host's stays in VRAM. What
  couldn't be unloaded shows on the dashboard. Until Resume, new work gets
  "The model host is paused." Pause survives a restart.

## How it's put together

- `host-api` (this folder's `src/`): TypeScript run by Node 24, with no npm
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
  `compose.apu.yaml` (unified memory) on an APU alone. For NVIDIA without
  Docker's nvidia runtime (NixOS), `compose.cdi.yaml` swaps the GPU
  reservations for CDI devices. They log nothing
  (Docker's `none` log driver).
  - On a host with a CMP 100-210 (PCI ID `10de:1df4`), whose FP16 tensor
    cores are throttled, `install.sh` adds `compose.cmp.yaml`. Its
    llama.cpp (`llamacpp/Dockerfile`) is built at the stock image's tag with
    `GGML_CUDA_FORCE_MMQ`, so quantized models use int8; that changes
    nothing on Turing and newer cards. A patch (`volta-fa-tile.patch`) lets
    the overlay's `GGML_CUDA_VOLTA_FA_TILE` keep flash attention on sm_70
    off the tensor cores, and host-api reads prompts on the CMP in steps of
    2048 tokens (`ubatch-size`); together they read prompts about three
    times as fast as the stock image. CI publishes it and sd-server's image
    (`.github/workflows/cmp-images.yml`) under a tag that hashes their build
    folder and CUDA capabilities, in the registry `prebuilt.sh` names (one
    line, or `LYRICA_HOST_REGISTRY`). `install.sh` pulls the tag that matches
    its own code when the image covers every GPU's compute capability, and
    checks the image's content label, then runs it by the digest it
    checked, so a tag pushed again later changes nothing. Otherwise it adds
    `compose.cmp.build.yaml` (or `compose.sdcpp.build.yaml`) and builds
    the image for the host's GPUs, which takes a while, saying why.
  - llama.cpp runs in router mode. host-api writes its preset file (each
    model's file, GPU and context), then loads and unloads models through
    its API. Each loaded model keeps prompts in host memory (`cache-ram`),
    an eighth of the machine's memory up to 64 GiB, where that is more than
    llama.cpp's own 8 GiB, so threads taking turns on a model don't each
    re-read their whole conversation. It leaves llama.cpp's CPU threads to
    llama.cpp, which uses one per physical core (the status's `machine`
    names the CPU and counts them).
  - vLLM runs under `vllm/supervisor.py`, which starts one server per vLLM
    model on its GPUs, as host-api asks in a file, each in its own process
    group. A server that crashes is restarted after a growing wait (10
    seconds, doubling, up to 5 minutes). It reports servers that exited in
    the `vllm-status` volume, so a load that can't start fails at once.
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
  measured VRAM and usage counts. Prompts are never stored, and host-api's
  log has no text: only event names, IDs and counts, never the pairing code.
- Images are pinned by digest. `host-api` is built from this checkout by
  `install.sh`, and CI builds the stack on pull requests that touch `host/`.
- `test/stack/network.sh` checks the network layout on a running stack.

The local dashboard's address check and the egress rules assume Docker's
port publishing and its iptables firewall backend. After a firewall reload
that flushes INPUT, run `systemctl restart lyrica-host-egress`.
