# Model hosts: deploying a GPU machine for Lyrica

A model host is a Linux machine with an NVIDIA or AMD GPU running the stack
in `host/`: llama.cpp and vLLM for text, ComfyUI for images, a small speech
server for voices, and `host-api`, which Lyrica talks to over mutual TLS
after a one-time pairing. This guide follows `host/install.sh`; the
references are [host/README.md](../../host/README.md) (what the stack is),
[host/PAIRING.md](../../host/PAIRING.md) and [host/API.md](../../host/API.md),
and on Lyrica's side [docs/models.md](../models.md) ("Model hosts").

**What has and hasn't been exercised.** CI installs the stack with
`install.sh --no-gpu` on pull requests that touch `host/`, and checks its
network layout on the running containers. The CUDA and ROCm images build
only when the files that go into them change. Real hardware so far: an
RTX 3090 (chat and Wan 2.2 5B clips), the development deployment's host
(Qwen-Image 2.1 edits) and a CMP 100-210 (chat, dictation, voices and
stable-diffusion.cpp images, with starters from the hub); the briefs
record each run. The voice and dictation choices below come from a
benchmark the owner ran on a Windows machine with an RTX 3090, outside
this stack. Expect a new machine to turn something up; the checklist at
the end is for that.

## What a host is to Lyrica

- An **endpoint** of kind local, with a list of addresses tried in order
  and the host's key fingerprint pinned at pairing. Trust is in the key:
  addresses can change freely, and a host whose key changes is refused
  until it is paired again.
- Either **shared** (in `self.db`, every user can use it, only an
  administrator pairs or manages it) or **personal** (in one user's
  `user.db`, seen by nobody else).
- Every model file on it is an **offering** Lyrica can put in a preset's
  list, like a model on any other endpoint. Its context length, tool and
  vision support, and voices are read from the host.

A host that is off, paused or busy is skipped for the next model in the
list, so several hosts (or a host and a cloud model, in a general preset)
back each other up. Busy takes a while: Lyrica's text requests (chat,
sleep, subagents) wait for the GPU up to 15 minutes first, since a very
large model can take minutes to load, and a chat thread says what it waits
for. Lyrica waits up to 30 minutes in all, the GPU wait included, for an
answer to start, so a long prompt on a slow model can still be read.

## The machine

- Linux: Debian or Ubuntu, or NixOS with the flake's `model-host` module
  first ([host/README.md](../../host/README.md), "On NixOS"). It has run on
  one NixOS machine with an NVIDIA card. With `gpu = "nvidia"` on a machine
  still running nouveau, the first `nixos-rebuild switch` exits with code 4
  because the CDI generator finds no driver loaded; reboot once and it
  passes. Lyrica's own units start either way.
- The GPU driver: NVIDIA's, or `amdgpu` (with ROCm kernel support,
  `/dev/kfd`, for the ROCm backend).
- Docker with the compose plugin, using its **iptables** firewall backend
  (the default). Podman and Docker's nftables backend are refused: the
  rules that keep `host-api` from connecting out need the `DOCKER-USER`
  chain.
- The container runtime's GPU support: `nvidia-container-toolkit` for
  NVIDIA (`nvidia-ctk runtime configure --runtime=docker`, then restart
  Docker). AMD needs only the `render` group and `/dev/dri`.
- `iptables` and `git`. systemd keeps the egress rules across reboots;
  without it you run `sudo host/egress.sh apply` after every boot and
  Docker restart.
- A user in the `docker` group to run the script as: it runs `docker
  compose` as you, and uses `sudo` only for the egress rules, their unit
  and the updater (its state folder, deploy key, script and units).
- A **models folder**, `/srv/models` by default, on a disk with room for
  what you'll download. It must exist before the script runs, and you must
  be able to create its `lyrica/` subfolder:

  ```sh
  sudo mkdir -p /srv/models && sudo chown "$USER" /srv/models
  ```

  On NixOS the module creates it instead: `services.lyrica-host.modelsDir`,
  `/srv/models` by default, with its `lyrica/` subfolder. Give the script
  the same folder.

  It can be one another program already uses, such as LM Studio's; the
  stack mounts it read-only and writes only into `lyrica/`. To move to
  another folder later, see [Operating a host](#operating-a-host).
- A **private LAN address** (10/8, 172.16/12, 192.168/16, or a tailnet
  address). Docker's published ports bypass the machine's firewall, so the
  script never publishes on every interface, and a detected address that
  isn't private is dropped rather than offered. An address you type, or
  give with `--lan`, is used as given, so don't give it a public one.
  Optionally Tailscale: the stack can join your tailnet as a device of its
  own, with no Tailscale installed on the machine.
- **Memory beside the GPU:** each loaded llama.cpp model keeps recent
  prompts in the machine's own memory (`cache-ram`), an eighth of it up
  to 64 GiB, where that is more than llama.cpp's own 8 GiB.

### AMD GPUs

ROCm runs everything, but only on the GPUs its images are built for. For
any other AMD GPU, such as Vega or a Radeon 780M, the script picks
**Vulkan**, which serves llama.cpp (GGUF) models only: no vLLM, no images,
and voices on the CPU. `--amd-backend` chooses yourself; `--hsa-override
11.0.0` runs a 780M on ROCm as a gfx1100, which AMD doesn't support and
which works on some machines and not others. An integrated GPU beside a
discrete one is left out until you untick **Left out** in its **Edit** on
the dashboard. The supported GPUs and the memory an integrated GPU can use
are in [host/README.md](../../host/README.md#amd-gpus). None of the AMD
paths has been tried on hardware.

### A CMP 100-210

The CMP 100-210 (PCI ID `10de:1df4` or `10de:1d84`) is a mining card with
throttled FP16 tensor cores. The script detects it and uses a llama.cpp
that checks the tensor cores at each start: throttled, quantized models
use its int8 units and flash attention avoids the tensor cores, which
reads prompts about three times as fast as the stock image. It downloads the image CI built (a few GB) when the host's GPUs
are among those it covers, and otherwise builds it here, which took 25
minutes on a 4-core machine; it says which. `LYRICA_HOST_REGISTRY`
points it at another registry, such as a Forgejo instance's. When the
image GPU (`COMFY_GPU`) is one, ComfyUI isn't started and
stable-diffusion.cpp, downloaded the same way (or built, 18 minutes),
makes the images instead: create only, for Z-Image, Qwen-Image, Krea 2,
FLUX and SDXL recipes without LoRAs. The first image after a
load takes about 2.5 minutes while it converts the weights to Q8_0; a
GGUF keeps its own quantisation. Krea 2 has its own starter there, Krea 2
Turbo Q5 (GGUFs, about 13.4 GB), which fits the card's 16 GB: about 70
seconds an image once loaded, 2.5 minutes cold.
vLLM models can't run on the card, so dictation runs on whisper.cpp
instead, with its own starter (large-v3-turbo q8_0). Voices run on it
with an older cuDNN, so on such a host a Blackwell card can't run voices.
Details are in [host/README.md](../../host/README.md#image-models).

The card can be unlocked at every boot
([cmp100-unlock](https://github.com/mintoriakamoto/CMP100-210xFULLTENSORSxGEN3x1)):
full-rate tensor cores and PCIe Gen3, lost at power-off. Unlocked, prompts
read about twice as fast again, images take 1.2 seconds a step instead of
3.0 (F16 with flash attention), and a model already in memory loads about
3 times as fast. The images notice it by themselves at each start.

- **Debian or Ubuntu:** `install.sh` offers it, or run `host/cmp-unlock.sh`.
  It needs NVIDIA's proprietary driver (not `-open`), Secure Boot off and
  the kernel's headers, builds a kernel module, and blacklists `nouveau`
  and `nvidia_drm`, so a desktop drawn by an NVIDIA card would lose its
  display. Then reboot.
- **NixOS:** `services.lyrica-host.cmpUnlock.enable = true;`, then
  `nixos-rebuild boot` and reboot. It uses the 580 driver with the
  proprietary modules.
- **Check:** `journalctl -u cmp100-unlock -b` ends with `PASS`, and
  `cmp100-bench` reports about 37 cycles per instruction (512 when locked).
- **Skip or undo:** add `cmp100.skip` to the kernel command line for one
  boot; `host/cmp-unlock.sh --remove`, or set the option false, to undo.
  A run started by hand refuses while the host's containers hold the GPU.

### Full-rate tensor math

GeForce cards run FP16, BF16 and TF32 tensor math at half the rate of the
same chip sold as a workstation card.
[gpu-unlock](https://github.com/Zagitta/gpu-unlock), a kernel module,
lifts that cap at every boot, before the NVIDIA driver loads. Upstream
reports faster prompt reading on vLLM (25 to 55%), image and video
making, and little change for quantized GGUF models or for writing
tokens. On an RTX 3090 under NixOS, a warm Krea 2 image went from 14.9
to 9.4 seconds, a Qwen-Image edit from 11.1 to 7.0, and a 5-second Wan
14B clip from 427 to 283. It's optional and off by default.

- **Cards:** GeForce RTX 30 (stable upstream); RTX 20 and 40 are
  experimental. Not RTX 50, workstation cards or the CMP 100-210 (its own
  unlock is above). Tried here on one RTX 3090 with NixOS; the Debian
  script hasn't run yet.
- **Debian or Ubuntu:** `host/gpu-unlock.sh`. It lists the cards it would
  unlock and asks first, then fetches the pinned upstream commit and two
  files from NVIDIA's driver (checked against pinned checksums), builds
  DKMS packages, installs them and adds `gpu_unlock.targets=all` to GRUB's
  kernel command line through `/etc/default/grub.d/lyrica-gpu-unlock.cfg`.
  Without GRUB, add that parameter yourself. Keep your distribution's
  headers package (`linux-headers-amd64`, `linux-headers-generic`)
  installed so DKMS builds it for new kernels; with Secure Boot, enroll
  DKMS's key the first time (`mokutil --import`).
- **NixOS:** `services.lyrica-host.gpuUnlock.enable = true;`, then
  `nixos-rebuild boot`. The firmware is unfree: with an
  `allowUnfreePredicate`, also allow `gpu-unlock-firmware`.
- **Reboot**, then check: `journalctl -k -b | grep gpu_unlock` says
  `unlocked` for each card.
- **Undo:** `host/gpu-unlock.sh --remove` and reboot; on NixOS, set it
  false and rebuild, or boot the previous generation. For one boot,
  delete `gpu_unlock.targets=all` in the boot menu's editor.

It runs as root before the driver, on the machine that holds Lyrica's
memory if she runs there too. At the pinned commit it opens no network
connection and writes no files; it touches only the cards it supports,
through their registers and NVIDIA's own signed firmware. A suspend
resets the unlock and the module redoes it on resume; hibernation isn't
covered.

## Install

Lyrica can do this for you on a Debian or Ubuntu machine she reaches
over SSH: give a thread the machine and ask her to install a model host
there. She checks the machine, asks before changing anything system-wide,
hands you the two steps that need root on cards, pulls the images in the
background and ends with a pairing code. On a GPU someone else already
uses, she leaves the host paused. On NixOS she stops and says the module
comes first. The steps below are the same ones, by hand.

```sh
git clone https://github.com/xlc2022/lyrica && cd lyrica
host/install.sh
```

On NixOS, add the `model-host` module and `nixos-rebuild switch` first
([host/README.md](../../host/README.md), "On NixOS"), then clone into its
`checkout` folder. `/srv` belongs to root, so make the folder yours first:

```sh
sudo mkdir -p /srv/lyrica-host && sudo chown "$USER" /srv/lyrica-host
git clone https://github.com/xlc2022/lyrica /srv/lyrica-host && cd /srv/lyrica-host
host/install.sh
```

It first checks the GPU, the driver and Docker's GPU support, and for AMD
picks ROCm or Vulkan. Then it asks three questions, each with a default:
the host's name (lower-case letters, digits and dashes;
`lyrica-<hostname>`), the LAN address to publish on (detected, if the
detected one is private), and the models folder. Then it:

1. Writes `host/.env` (mode 0600) with the answers, the compose files to
   use, and the fixed address of `host-api`'s own bridge.
2. Applies the egress rules (`egress.sh`, with sudo) and installs
   `lyrica-host-egress.service`, which applies them again at boot and after
   every Docker restart.
3. Builds the `host-api` and speech images and starts the stack
   (`docker compose up -d`). The ComfyUI image is large and builds here
   too, from pinned commits.
4. Checks that `host-api` can't open a connection to the internet, by
   address or by name, and stops it if it can.
5. Offers to set a dashboard password.
6. Prints the dashboard addresses and the host's **key fingerprint**. Keep
   the fingerprint: you check it against what Lyrica shows after pairing.
7. On a systemd machine other than NixOS, installs the updater (see
   Upgrade below). The first time, it makes a key and prints it from
   `/etc/lyrica-host/deploy-key.pub`: add it to the GitHub repository as a
   read-only deploy key (Settings → Deploy keys). The updater needs `jq`,
   `git` and `ssh`; without them the host reports it unavailable and says
   which to install.

Options, for a second run or a non-interactive one (`host/install.sh --help`):

| Option | Use |
|---|---|
| `--name NAME`, `--lan ADDRESS`, `--models DIR` | The three answers, as flags. |
| `--tailscale NAME` | Also join the tailnet as device `NAME`. Asks once for an auth key; the key is dropped from `.env` once the device has joined. |
| `--no-lan` | Reachable over Tailscale only (needs `--tailscale`). |
| `--no-tailscale` | Leave the tailnet. |
| `--vendor nvidia\|amd`, `--amd-backend rocm\|vulkan`, `--hsa-override VER` | Override what was detected. |
| `--yes` | No questions: defaults and flags. |
| `--no-start` | Write `.env` only. |
| `--no-gpu` | `host-api` alone, no model servers. What CI uses. |

Running the script again keeps `.env`'s values as defaults, rebuilds, and
restarts the stack in place, also on a machine with many network
interfaces (Docker's, for one). That is how you change a setting.

## The dashboard

- From Lyrica: the **Dashboard** link on the host's card in Models opens
  it in a new tab.
- At the machine: `http://127.0.0.1:7236`, no login.
- From the LAN: `https://<LAN address>:7236`, with the password. The
  certificate is the host's own, so the browser warns; check its
  fingerprint against the one the script printed.
- Over Tailscale: `https://NAME.<tailnet>.ts.net`, with the password and
  Tailscale's certificate.

Until a password is set (by the script, or on the dashboard at the machine)
it opens only at the machine. It looks like Lyrica's own pages: the host's
state with **Pause** at the top, and sections down the left for the GPUs
and what is loaded on them, the model library (each model's **Settings**
opens a drawer), image models, downloads, usage, paired Lyrica servers and
the password.

## Pair it with Lyrica

Pairing is once per host and per Lyrica server. It binds Lyrica's key and
the host's key to a short-lived code, so neither side ever trusts an
address.

1. On the dashboard choose **Pair with Lyrica**. A code like
   `7KQ2-M9XD-4RTB-W1HZ` appears there; it is never logged. It works once,
   for 10 minutes, and 5 wrong tries void it.
2. In Lyrica, open Models, Hosts and endpoints, **Add model host**. Give
   the host a name, its addresses one per line in the order to try them
   (LAN address first, tailnet name second, say) and the pairing code.
   A tailnet address or name works when Lyrica is on that tailnet itself
   (Administration, Tailnet): she reaches it through her own tailscaled.
   On a Debian install from before 2026-10-22, re-run `install.sh` once
   so her tailscaled gets that proxy; NixOS gets it with the next rebuild.
   Turn on **Shared** for a host every user may use (administrators only);
   leave it off for one of your own. Then **Pair**.
3. Lyrica shows the host's fingerprint: compare it with the one the install
   printed. The host's dashboard now lists this Lyrica server, and Lyrica
   has read its model library. A plain reason comes back for no active
   code, a wrong code, or no address reachable.

The same is `POST /api/u/<user id>/hosts` with `name`, `addresses`, `code`
and `shared` ([docs/contracts.md](../contracts.md)).

If the host's key ever changes (a rebuilt `data` volume), Lyrica refuses it
with "This host's identity changed. Pair it again." Make a new code on the
dashboard, choose **Pair again…** in the host's ⋯ menu and enter it on
the page that opens; every id stays. New addresses go in with **Edit** on
the host card.

## Put models on it

Three ways a model gets into the library:

- **Copy files into the models folder** and **Scan the folder** on the
  dashboard, or **Scan** in Lyrica's Models, Image models, which has every
  host you manage read its folder again (the host also scans at start and
  after each download). GGUF
  files are served by llama.cpp; a folder with a `config.json` and
  safetensors by vLLM (a model whose config asks for remote code is listed
  but never loaded).
  vLLM gets tool calling only for families the host knows (Qwen2.5,
  Qwen3.x, Llama 3.x, Mistral and Mixtral, DeepSeek; see `host/API.md`);
  any other family shows tools off and chats without them.
- **Download on the dashboard** from Hugging Face, ModelScope or an https
  link, into `lyrica/<source>/<repository>/` in the models folder. Only
  GGUF, safetensors and ONNX files are taken; pickles and code are refused;
  every file is checked against the hub's checksum. A gated repository's
  token is used for that download and never kept.
- **Download from Lyrica**: in Models, Text models, **Download model**
  opens Download text model. Name a repository on Hugging Face or
  ModelScope, or paste its link, pick a host and a GGUF file (or the whole
  repository when it has none), and it starts on that host. Ticking a
  GGUF model also ticks its vision projector and MTP file, marked
  **Vision** and **MTP**. A link to one `.gguf` or `.safetensors` file,
  with an optional SHA-256, works too.
  Models, **Downloads** shows every host's queue, with Cancel, Clear
  finished and Add to the group. A download that loses its connection,
  stalls or meets a busy server retries by itself from where it stopped,
  for about four minutes of waits, and fails only when five tries in a
  row get nowhere. Downloading the same file again while the failed one is
  still listed resumes it; cancelling or clearing a failed download
  deletes its partial file. Its **Accounts** section holds hub
  tokens: a user's own, or a shared one an administrator adds, sent to the
  host per request. A token typed for a gated repository is saved for next
  time unless you untick **Save it for next time**. The page takes a
  repository's `main` branch; the same download API (`…/hosts/<endpoint
  id>/downloads`) also takes a revision.

### The voice and dictation starters

The owner chose these after the benchmark; the host's README names them
and the exact revisions. The dashboard's Models section offers both under
**Starters**, at these revisions, beside the chat and embedding starters;
**Download** there is the quickest way. A starter shows only where the
host runs its server: the voice on every host (on the CPU except on
NVIDIA), dictation on hosts that run vLLM (not Vulkan) or, beside a CMP
100-210, whisper.cpp. The voice starter takes three voices, `zm_010`,
`zf_001` and `af_maple`. For other voices, or where a starter
doesn't show, do the same by hand, from the machine, where the dashboard
port needs no password: list a repository's files first, then ask for
the ones you want by name:

```sh
curl -sS 'http://127.0.0.1:7236/host/v1/hub/files?source=huggingface&repo=onnx-community/Kokoro-82M-v1.1-zh-ONNX&revision=6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3'
```

- **The voice**, `onnx-community/Kokoro-82M-v1.1-zh-ONNX` at revision
  `6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3`: `onnx/model.onnx`,
  `config.json`, `tokenizer.json`, `tokenizer_config.json` and the
  `voices/*.bin` you want (all 103 are about 330 MB). `zm_010` was the best
  voice for English words in Mandarin text.
- **Dictation**, `openai/whisper-large-v3-turbo` at revision
  `41f01f3fe87f28c78e2fbf8b568835947dd65ed9`: `model.safetensors` and
  every `.json` and `.txt` file the listing shows (about 1.6 GB).

```sh
curl -sS -H 'content-type: application/json' -d '{
  "source": "huggingface", "repo": "onnx-community/Kokoro-82M-v1.1-zh-ONNX",
  "revision": "6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3",
  "files": ["onnx/model.onnx", "config.json", "tokenizer.json", "tokenizer_config.json", "voices/zm_010.bin", "voices/zf_001.bin", "voices/af_maple.bin"] }' \
  http://127.0.0.1:7236/host/v1/downloads
```

The answer is `202` with the downloads; `GET /host/v1/downloads` follows
them, and the dashboard shows the same. A sharded or multi-file model
appears in the library once every file is here.

Pin both (**Pin** in the model's ⋯ in the library, or `POST
/host/v1/models/pin`) if the GPU has room, so neither waits for a load
when someone speaks or listens. Together they take about 4.2 GB of VRAM
on an NVIDIA host; on AMD or without CUDA the voice runs on the CPU,
where Kokoro is quick enough.
Warm, on an RTX 3090, a 24-second reply is spoken in 0.7 s and transcribed
in 0.25 s; on the CPU alone Kokoro takes about 1.3 s for a 5-second
sentence. Unpinned, the host swaps models in and out, and the first use
after a swap takes about 30 s. Dictation uses the Private column unless a
thread picks its own model, so put Whisper in its
`speech.transcribe` list.

### Placements and settings

Each model has a placement (Auto, or chosen GPUs) and serving settings
such as its context length, KV-cache type and, for vLLM, its share of the
GPU's memory. Set them in the model's **Settings** on the dashboard, or
from Lyrica with `PUT /api/u/<user id>/offerings/<offering id>/serving`.
A placement that can't work is refused when saved, with the reason. Each
GPU says which servers it may run and how much memory to keep free.

A host can also give llama.cpp models part of its system RAM, so a model or
quant bigger than its GPUs still runs, slower. It is off until you set
**System RAM** in GB: in the host's **Edit** drawer under Models, Hosts and
endpoints, or on its dashboard's GPUs page. A 96 GB machine allows up to
76 GB, leaving room for llama.cpp's prompt cache and the system. Only a
model that can't fit its GPUs uses it, and only for what they lack; a
model's **System RAM** setting, Off, keeps it on the GPUs. A host gets
the allowance with its next Update.

Some models, such as Qwen3.8-Flash-Next and Gemma 4, have a per-layer
embedding table that llama.cpp keeps off the GPUs and reads from the model
file as it goes. When downloads or other files fill the machine's memory,
long prompts then crawl with the GPUs idle. With an allowance set, the
model's **Embedding table** setting, RAM, loads it into memory instead. What
each setting means, and how models are placed and unloaded, is in
[host/README.md](../../host/README.md#models-and-gpus) and
[host/API.md](../../host/API.md#placement-and-serving-settings).

A GGUF chat model loads the vision projector whose name is closest to its
own. For a fine-tune named unlike its base, pick another in **Projector**
in the model's drawer under Models, Text models: it lists every `mmproj`
file on the host, and applies at the next load. A model downloaded without
its projector or MTP file shows **Missing files** there, which downloads
the file from the model's own Hugging Face repository beside it. A
projector takes about its size in GPU memory, so a model that only just
fits may need a shorter context. Hosts get both on their next update.

A chat model can serve more context than it was trained for with a YaRN
stretch, set in the model's settings on the dashboard together with the
context to serve, for example
`"contextLength": 1010000, "stretch": { "type": "yarn", "factor": 4 }`.
You can also ask Lyrica to do it: her `models` tool asks you on a card
before it changes anything. The stretch raises the most the model may serve
(the trained length times the factor; `originalContext`, the length YaRN
scales from, defaults to the trained length); `contextLength` still picks
what it serves. Unset, a chat model gets the largest context that fits its
GPUs, up to its trained length (32k when the host can't tell), so it may
fill a GPU and be unloaded whenever another model needs the room; set a
smaller context to keep both loaded. The editor's hint shows what the
model's card recommends; **Look up** in the model's Settings reads the
card (it asks for the repository when the host doesn't know it). A factor
above the card's asks "<publisher> documents N. Save anyway?". Each model
row shows "stretched ×N" and the size of its KV cache, which grows with
the context length, so a stretched model may need a lower context or more
memory. The host reports a stretch on any vLLM model as untested
(vllm#58870) until its image carries the fix; llama.cpp is the safer
choice for it. Details are in
[host/API.md](../../host/API.md#recommended-settings).

On a host with one large GPU, voice and a big chat model compete for
memory. On 24 GB, the 27B below at 128k leaves no room for pinned voice:
either leave voice unpinned and accept the 30-second first use after a
swap, or pin it and serve the chat model at a shorter context. An image
recipe such as Z-Image takes 19–22 GB on its own, so on 24 GB chat, voice
and images take turns: pin only what must answer at once. The Krea 2
Turbo starter (fp8, about 18.6 GB of files) loads one stage at a time,
about 13.5 GB at its largest; beside a 27B chat model on 24 GB it runs
only once the host unloads the chat model, which it never does to a
pinned or busy one. The Qwen-Image 2.1 Turbo starter, which edits and
creates (bf16 diffusion model, int8 Qwen3-VL 8B encoder, about 24.3 GB
of files), is 14.9 GB at its largest stage and takes turns the same way.
It replaces Qwen-Image-Edit 2509 for edits: once installed, put it first
in a column's Image edits list, and in its Images list too if you like
its images. A masked edit on it runs through LanPaint (a pinned ComfyUI
node, GPL-3.0), which takes about two and a half times as long as a
plain edit. Whisper on vLLM wants a memory share of about 0.1 of a 24 GB
card.

Krea 2 Turbo's weights are under the Krea 2 Community License: free for
non-commercial use and for commercial use under $1M a year in revenue,
and section 4.2 requires content filtering wherever it runs. The host
filters nothing, so an operator who installs it sets up that filter.
Qwen-Image 2.1's weights are under the Qwen Research License: research
and evaluation only, no commercial use without a separate licence from
Qwen, and a notice with their attribution wherever it is passed on. An
operator who installs that starter takes that on.

Measured on an RTX 3090 (24 GB) with Qwen3.8-27B Q4_K_M on llama.cpp:

| Context | KV cache | Result |
|---|---|---|
| 128k | q8_0 | Fits: about 22 GB; 41–55 tokens/s out, about 750 tokens/s prompt |
| 336k (stretch factor 2) | q4_0 | Loads: 23.8 GB |
| 352k | q4_0 | Refused at load, too big |
| 384k and up | q4_0 | Refused when saved |
| 600k | q4_0 | Refused when saved: 3.6 GB short; needs 48 GB |

So the 600k stretch needs a 48 GB GPU; on 24 GB, stay at 336k or below.
A night's sleep ran cleanly on this model at 128k in 7.5 minutes.

## Use it from Lyrica

Once paired, the host's models are offerings named `<host>/<model id>`
(with `shared.` in front for a shared host). Put them in a preset's lists,
from Models, Tasks, or from a terminal on the
Lyrica machine (`lyrica` runs as her user by itself):

```sh
lyrica admin models preset set private chat 'shared.blackwell/lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf' --user ada
lyrica admin models preset set private speech.speak 'shared.blackwell/lyrica/huggingface/onnx-community/Kokoro-82M-v1.1-zh-ONNX' --user ada
lyrica admin models preset set private speech.transcribe 'shared.blackwell/lyrica/huggingface/openai/whisper-large-v3-turbo' --user ada
lyrica admin models preset list --user ada
```

A model id is its path under the models folder, as the dashboard and
`GET /host/v1/models` show it. Private and local-only threads use the
Private column, so a host is how private threads get a model at all. Each user
picks their own voice and speed per language with the speech model's
**Settings**, in its host's "N models" list under Models, Hosts and
endpoints; without one, the model's first voice for the language is used.

## Images

Confirmed, ready recipes can go in the `image.create`, `image.edit` and
`image.upscale` lists, like any other model (see "Use it from Lyrica").
Set each host recipe's **Use for** in **Models → Image models** to **Fast**,
**Quality** or **Both** (default). Create skips recipes tagged only for the
other tier, including on fallback; edits and upscaling use their lists as
before. Her `image` tool keeps a recipe's defaults unless she gives a size
or count, and never picks parts or LoRAs itself. Each list is an ordered
fallback, and private threads only use local models. SeedVR2 recipes
upscale. Before any cloud fallback, a portrait photo's cloud setting is
checked. OpenAI setup and offline diagrams are in the [getting-started
guide](getting-started.md#image-models). Qwen-Image 2.1 edits (masked
too) and Z-Image and Krea 2 Q5 on stable-diffusion.cpp have made real
images; other starters haven't yet: item 9 of the checklist below.
ComfyUI runs only while an image recipe is loaded, and stops once none
is. A recipe too big for the image GPU even with nothing else loaded,
or whose template the host lacks (one a newer release made, after a
rollback), is unsupported: `GET
/host/v1/recipes` lists it with no actions and the reason, Lyrica never
offers it for a task, and a job for it fails as too big. A host gets
this with its next Update or `host/install.sh`.

### Video recipes

ComfyUI hosts list seven video starters: Wan 2.2 TI2V 5B (about 18 GB of
files, fits a 24 GB card), Wan 2.2 T2V 14B and I2V 14B (about 38 GB
each), the same two as Q5 GGUF quants, **Wan 2.2 T2V 14B Q5** and
**I2V 14B Q5** (about 31 GB each, for a 24 GB card and less system
memory; all four 14B starters also fetch a small RIFE model that turns
their 16 fps into 32 fps, and installing one again adds it to a recipe
made before it), LTX-2.5 Distilled (about 40 GB) and MiniMax H3 Turbo (about
42 GB); H3 and LTX-2.5 fit a 96 GB card. A host on stable-diffusion.cpp
doesn't list them. Once one is confirmed, put it in the **Videos** row
of Models, Tasks (the last row under Images, whose picker lists only
model hosts' video recipes), or `lyrica admin models preset set private
video '<host>/<recipe>' --user ada`. Until a column has one, her `image`
tool can't make clips. A clip is 1 to 15 seconds, from a prompt or, with
a recipe that animates (Wan 2.2 I2V, for one), from an image as its first
frame; it is saved encrypted in the thread's folder under `videos/`, and
Files shows its poster. Cloud models and plain endpoints in the list are
passed over. A clip takes from a few minutes to most of an hour and holds
ComfyUI's GPU until it is done; with two GPUs, `COMFY_GPU` picks the one
for images and videos. When she asks for a shape (16:9, say), the host
keeps the recipe's area and fits the size to its template's step. Ask for a
number of steps and she passes it on for that clip; a recipe's own steps
are **Steps** in its block under Models, Image models. A host
from before that refuses such a clip as invalid, so update the host
whenever you update `lyricad`.

Wan 2.2 is Apache 2.0. LTX-2.5's repository is gated: installing it
needs a Hugging Face token whose account accepted the LTX-2.x Community
License (free under $10M yearly revenue), and its files are checked
against the hub's checksums at download, since none are pinned. MiniMax
H3's licence forbids using, hosting or running it, or using what it
makes, in the US, the EU, the UK and South Korea: check where the host
and its users are before installing it. The ComfyUI image gained a
video-saving node, so the next Update or `host/install.sh` rebuilds it.

ComfyUI hosts also list a **SCAIL-2** starter (about 28 GB of files),
which moves an image's subject as the person in a driving clip moves.
Only the host's API can use it so far: Lyrica leaves it out of her
model lists until her side is built. On a 3090 a 5 s clip at 1280×704
took 9 to 14 minutes at 21 GB of VRAM and nearly 30 GB of system memory,
so give the machine room beyond the card. Its weights are MIT; it finds
people with SAM 3.1, under Meta's SAM License (commercial use allowed,
with an acknowledgement in publications, lawful use including privacy
law, and trade controls). Its frame-reading node is another addition to
the ComfyUI image, so the next Update rebuilds it again.

## More than one host

Deploying a second host is the same install, with a name of its own, and a
second pairing. Then:

- **Order the lists.** A task's list is tried in order; the first model
  whose host is up and not paused answers. Put the same model on two hosts
  one after the other, and a host that is off, paused, restarting or busy
  is passed over within 30 seconds. Lyrica's group suggestions (see
  [docs/models.md](../models.md)) find the same file on two hosts by its
  checksum, and Clean up finds the same model on another endpoint by name.
- **Shared or personal** is per host. A host every persona should use is
  shared; a host only one user may reach is personal, and no other user
  sees its addresses or models.
- **One hub token** saved in Lyrica serves downloads on every host.
- A host **can be paired with several Lyrica servers** at once, each
  with its own code; its dashboard lists them and revokes any one. Every
  paired server has the same rights: it sees the same models, recipes and
  GPUs, and can load, pin, pause, change settings, delete downloads and
  update the host. Only the dashboard makes codes and revokes servers.
  Their jobs share one queue on the same GPUs, so one busy server slows
  the others, and a pause from any of them pauses the host for all.
  **Update** moves the host to the asking server's release, so keep the
  servers on the same release. Each Lyrica keeps its own lists, users and
  shared or personal setting, and neither sees the other's threads; the
  dashboard's Usage counts all servers together.

## Operating a host

- **Pause** on the dashboard (or from Lyrica, `…/hosts/<endpoint
  id>/pause`) refuses new work, finishes the current job, unloads every
  model, stops vLLM and ComfyUI, and restarts the speech server if it
  used a GPU, so nothing of the host's stays in VRAM while you use the GPU
  for something else. Resume loads the pinned models again.
  Pause survives a restart. Lyrica falls back to the next model meanwhile.
- **Logs:** `docker compose logs host-api` in `host/`. They hold event
  names, ids and counts; never a pairing code or a prompt. The model
  servers log nothing at all, so `docker logs` on them fails. To see what
  holds the GPU, `nvidia-smi --query-compute-apps=pid,process_name,used_memory
  --format=csv`.
- **Upgrade:** **Update** in the host's ⋯ on Models (an administrator, for
  a shared host) moves it to the release Lyrica runs. It shows when
  Lyrica runs a release (Administration → Updates), the host has the
  updater, and the host runs another commit. The host pauses (running
  jobs finish first), installs the release into a root-owned tree,
  `/opt/lyrica-host/<commit>`, and is rolled back if host-api doesn't
  report the new commit within 5 minutes; a host paused before stays
  paused. From the first update on, the host runs from that tree, so its
  settings are in `/opt/lyrica-host/<commit>/host/.env`, carried to each
  new tree. To change a setting, run `git pull && host/install.sh` in your
  checkout: it installs from the checkout again, and the next Update
  carries its `.env` along.
  Either way the `data` volume keeps the host's key, so pairing survives.
  Each install or Update then removes the Docker images this stack ran
  before and no longer runs: only its own, never a prune, and a rollback
  builds or pulls its own again. Docker's build cache stays; free it
  yourself, and on a machine others use Docker on, never with a global
  prune.
  Details are in [host/README.md](../../host/README.md#updates).
- **Move to another models folder:** **Edit** on the host's card under
  Models → Hosts and endpoints, then **Models folder** and Save, or `sudo
  lyrica-host-update --models <folder>` on the host. The updater pauses the
  host (running jobs finish first), installs the same commit again with
  the new folder, and goes back to the old one if host-api doesn't answer
  on the new one within 5 minutes. No files move: models not in the new
  folder leave the lists. It refuses a folder that doesn't exist, a system
  folder (all of `/var/lib` included), one holding the host's own files,
  or one that someone else could change: the folder and every folder above
  it must belong to root or the current folder's owner with no group or
  other write, though a sticky folder such as `/tmp` above it is fine. A
  `lyrica/` subfolder must be a folder, not a link or a file. An updater
  installed before this was added can't move the folder, and an update
  never replaces the updater, so run `host/install.sh` once more; until
  then the card's tooltip says "Run install.sh on the host again". On
  NixOS, which has no updater, set `modelsDir` and run `host/install.sh
  --models <folder>`; any host can still change it that way. Details are
  in [host/README.md](../../host/README.md#the-models-folder).
- **Hosts installed before the updater** need `git pull &&
  host/install.sh` once more: it installs the updater, prints the deploy
  key to add, and brings the host-api image that opens from Lyrica's
  Dashboard link, recognises a model's vision projector and MTP file,
  and waits for a model's memory to free before loading the next. A host
  installed before the image server got its `/triton` scratch space needs
  this too, or image jobs fail with an `ImportError` (seen on NVIDIA).
- **On NixOS** the updater isn't installed: upgrade with `git pull &&
  host/install.sh` in the `checkout` folder. Lyrica shows the host's
  version but has no Update.
- **Restarting host-api alone** (a re-run of `install.sh` that leaves
  llama.cpp running): host-api unloads whatever llama.cpp still holds when
  it starts, then loads pinned models again. If llama.cpp wasn't answering
  then and a model is refused as too big, `docker restart
  lyrica-host-llamacpp-1` clears it.
- **After a firewall reload** that flushes `INPUT`, `sudo systemctl
  restart lyrica-host-egress`. `host/test/stack/network.sh` checks the network
  layout on the running stack whenever you doubt it.
- **Revoke** a Lyrica server on the dashboard; it must pair again.
  **Unpair** from Lyrica's side by removing the endpoint (`DELETE
  …/endpoints/<endpoint id>`); the host keeps it listed until revoked
  there.
- **Deleting a file** (`DELETE /host/v1/files?path=<path>`) removes only
  a file the host itself downloaded, unchanged since; nothing else in the
  models folder is ever touched. The dashboard's Delete is for image
  recipes.
- **Tear down:** `docker compose down -v` in `host/` removes the stack and
  its volumes, including the host's key (a new pairing afterwards), and
  `sudo systemctl disable --now lyrica-host-egress` with `sudo
  host/egress.sh remove` takes the rules out. The models folder stays.

## Uninstall

In Lyrica, remove the host under Models, Hosts and endpoints. Then, on the
host machine, from its checkout:

```sh
host/install.sh --uninstall
```

It says what it will remove and asks first. It removes:

- the stack's containers, volumes and network, with the host's key, so
  every paired Lyrica loses it;
- its images, by ID: one another container uses stays, and nothing is
  pruned, so other programs' images and Docker's build cache are left
  alone (on a shared machine, leave the build cache too);
- the egress rules and, on Debian or Ubuntu, the egress and updater
  units, `/usr/local/sbin/lyrica-host-update`, `/etc/lyrica-host` (the
  deploy key), `/var/lib/lyrica-host-update` and the release trees in
  `/opt/lyrica-host`.

It asks before deleting the models folder's `lyrica/` downloads; your own
model files beside them stay. `--delete-downloads` deletes them without
asking, and `--yes` skips the questions and keeps them. On NixOS, also
remove `services.lyrica-host` (with `gpuUnlock` or `cmpUnlock`) from the
configuration and rebuild. On Debian or Ubuntu, gpu-unlock stays until
`host/gpu-unlock.sh --remove` and a reboot, and the CMP unlock until
`host/cmp-unlock.sh --remove` and a reboot. The checkout itself stays;
delete it when you're done. Remove the deploy key from the repository
on GitHub too, if you added one.

## Checklist for the first host on your GPU machine

The model host brief lists the same steps in more detail ("Try it on the
workstation"). Note what goes wrong against each.

1. `host/install.sh` ends with the dashboard address and the fingerprint,
   and its own egress check passed. Then `host/test/stack/network.sh`.
2. Set the dashboard password and open the dashboard from another machine.
3. Pair from Lyrica with Add model host; the fingerprints match; the
   dashboard lists the server.
4. A GGUF in the models folder: Scan, put it in the local chat list, chat
   with it from a private thread. Check the context length, that it
   unloads when idle, and the VRAM measured after its first load.
5. Download the Kokoro and Whisper starters, pin them, then dictate and
   Read aloud in a thread.
6. A vLLM model (a safetensors folder), with a memory share, and a context
   too long for the share refused when saved.
7. Pause while something else uses the GPU: `nvidia-smi` shows nothing of
   the host's, then Resume brings the pinned models back.
8. A download of a gated repository with a token, and one from a link.
9. An image: install the Z-Image Turbo starter recipe (Image models,
   **Download image model**, which opens on Starter recipes; missing parts
   download after you confirm), make an image, edit and upscale. Then
   install Krea 2 Turbo and make an image beside an unpinned chat model:
   the chat model unloads first and loads again on the next chat. Edit
   an image with Qwen-Image 2.1 Turbo, then a masked edit: only the
   masked part should change. Templates no real job has used yet may
   need node or input names in `host/workflows/` fixed.
10. Optional, on a GeForce RTX 20, 30 or 40 card: turn on gpu-unlock
    ("Full-rate tensor math"), reboot, and check the kernel log says
    `unlocked`. Time the same prompt and the same image before and
    after, and check that a suspend and resume keeps it.

Report what fails, with the `host-api` log lines, in the Operator docs
thread.
