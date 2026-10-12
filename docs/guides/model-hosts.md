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
only when the files that go into them change. Nothing has run on a GPU,
with a real model, or against a real hub (the model host brief's handoff
says so, and no later thread has reported otherwise). The voice and
dictation choices below come from a benchmark the owner ran on a Windows machine
with an RTX 3090, outside this stack. Expect the first real install to turn
something up; the checklist at the end is for that.

## What a host is to Lyrica

- An **endpoint** of kind local, with a list of addresses tried in order
  and the host's key fingerprint pinned at pairing. Trust is in the key:
  addresses can change freely, and a host whose key changes is refused
  until it is paired again.
- Either **shared** (in `self.db`, every user can use it, only an
  administrator pairs or manages it) or **personal** (in one user's
  `user.db`, seen by nobody else).
- Every model file on it is an **offering** Lyrica can put in a profile's
  list, like a model on any other endpoint. Its context length, tool and
  vision support, and voices are read from the host.

A host that is off, paused or busy is skipped for the next model in the
list, so several hosts (or a host and a cloud model, in the custom profile)
back each other up.

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
  compose` as you, and uses `sudo` only for the egress rules and the unit.
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
  stack mounts it read-only and writes only into `lyrica/`.
- A **private LAN address** (10/8, 172.16/12, 192.168/16, or a tailnet
  address). Docker's published ports bypass the machine's firewall, so the
  script never publishes on every interface, and a detected address that
  isn't private is dropped rather than offered. An address you type, or
  give with `--lan`, is used as given, so don't give it a public one.
  Optionally Tailscale: the stack can join your tailnet as a device of its
  own, with no Tailscale installed on the machine.

### AMD GPUs

ROCm runs everything, but only on the GPUs its images are built for. For
any other AMD GPU, such as Vega or a Radeon 780M, the script picks
**Vulkan**, which serves llama.cpp (GGUF) models only: no vLLM, no images,
and voices on the CPU. `--amd-backend` chooses yourself; `--hsa-override
11.0.0` runs a 780M on ROCm as a gfx1100, which AMD doesn't support and
which works on some machines and not others. An integrated GPU beside a
discrete one is left out until you include it on the dashboard. The
supported GPUs and the memory an integrated GPU can use are in
[host/README.md](../../host/README.md#amd-gpus). None of the AMD paths has
been tried on hardware.

## Install

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
interfaces (Docker's, for one). That is how you change a setting or
upgrade (`git pull && host/install.sh`).

## The dashboard

- At the machine: `http://127.0.0.1:7236`, no login.
- From the LAN: `https://<LAN address>:7236`, with the password. The
  certificate is the host's own, so the browser warns; check its
  fingerprint against the one the script printed.
- Over Tailscale: `https://NAME.<tailnet>.ts.net`, with the password and
  Tailscale's certificate.

Until a password is set (by the script, or on the dashboard at the machine)
it opens only at the machine. It shows the GPUs and what is loaded on them,
the model library with each model's placement and settings, downloads,
image recipes, paired Lyrica servers, and Pause.

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
dashboard and choose **Pair again…** in the host's ⋯ menu; every id stays.
New addresses go in with **Edit** on the host card's facts line.

## Put models on it

Three ways a model gets into the library:

- **Copy files into the models folder** and Scan on the dashboard (the
  host also scans at start and after each download). GGUF files are served
  by llama.cpp; a folder with a `config.json` and safetensors by vLLM (a
  model whose config asks for remote code is listed but never loaded).
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
  repository when it has none), and it starts on that host; a link to one
  `.gguf` or `.safetensors` file, with an optional SHA-256, works too.
  Models, **Downloads** shows every host's queue, with Cancel, Clear
  finished and Add to the group. Its **Accounts** section holds hub
  tokens: a user's own, or a shared one an administrator adds, sent to the
  host per request. A token typed for a gated repository is saved for next
  time unless you untick **Save it for next time**. The page takes a
  repository's `main` branch; the same download API (`…/hosts/<endpoint
  id>/downloads`) also takes a revision.

### The voice and dictation starters

The owner chose these after the benchmark; the host's README names them and the
exact revisions. The dashboard's Downloads takes a repository and
downloads its `main` branch; to get the benchmarked revision, use the API
from the machine, where the dashboard port needs no password. List a
repository's files first, then ask for the ones you want by name:

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

Pin both (the pin button in the library, or `POST /host/v1/models/pin`)
if the GPU has room, so neither waits for a load when someone speaks or
listens. Together they take about 4.2 GB of VRAM on an NVIDIA host; on AMD
or without CUDA the voice runs on the CPU, where Kokoro is quick enough.
Warm, on an RTX 3090, a 24-second reply is spoken in 0.7 s and transcribed
in 0.25 s; on the CPU alone Kokoro takes about 1.3 s for a 5-second
sentence. Unpinned, the host swaps models in and out, and the first use
after a swap takes about 30 s. Dictation uses the local profile unless a
thread picks its own model, so put Whisper in that profile's
`speech.transcribe` list.

### Placements and settings

Each model has a placement (Auto, or chosen GPUs) and serving settings
such as its context length, KV-cache type and, for vLLM, its share of the
GPU's memory. Set them in the model's **Settings** on the dashboard, or
from Lyrica with `PUT /api/u/<user id>/offerings/<offering id>/serving`.
A placement that can't work is refused when saved, with the reason. Each
GPU says which servers it may run and how much memory to keep free. What
each setting means, and how models are placed and unloaded, is in
[host/README.md](../../host/README.md#models-and-gpus) and
[host/API.md](../../host/API.md#placement-and-serving-settings).

A chat model can serve more context than it was trained for with a YaRN
stretch, set in the model's settings on the dashboard together with the
context to serve, for example
`"contextLength": 1010000, "stretch": { "type": "yarn", "factor": 4 }`.
You can also ask Lyrica to do it: her `models` tool asks you on a card
before it changes anything. The stretch raises the most the model may serve
(the trained length times the factor; `originalContext`, the length YaRN
scales from, defaults to the trained length); `contextLength` still picks
what it serves, 32k unless set. The editor's hint shows what the model's
card recommends; **Look up** on the model reads the card (it asks for the
repository when the host doesn't know it). A factor above the card's asks
"<publisher> documents N. Save anyway?". Each model row shows "stretched
×N" and the size of its KV cache, which grows with the context length, so a
stretched model may need a lower context or more memory. The host reports a
stretch on any vLLM model as untested (vllm#58870) until its image carries
the fix; llama.cpp is the safer choice for it. Details are in
[host/API.md](../../host/API.md#recommended-settings).

On a host with one large GPU, voice and a big chat model compete for
memory. On 24 GB, the 27B below at 128k leaves no room for pinned voice:
either leave voice unpinned and accept the 30-second first use after a
swap, or pin it and serve the chat model at a shorter context. An image
recipe such as Z-Image takes 19–22 GB on its own, so on 24 GB chat, voice
and images take turns: pin only what must answer at once. Whisper on
vLLM wants a memory share of about 0.1 of a 24 GB card.

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
(with `shared.` in front for a shared host). Put them in a profile's lists,
from Models, Tasks, or from a terminal on the
Lyrica machine (`lyrica` runs as her user by itself):

```sh
lyrica admin models profile set local chat 'shared.blackwell/lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf' --user ada
lyrica admin models profile set local speech.speak 'shared.blackwell/lyrica/huggingface/onnx-community/Kokoro-82M-v1.1-zh-ONNX' --user ada
lyrica admin models profile set local speech.transcribe 'shared.blackwell/lyrica/huggingface/openai/whisper-large-v3-turbo' --user ada
lyrica admin models profile show --user ada
```

A model id is its path under the models folder, as the dashboard and
`GET /host/v1/models` show it. Private and local-only threads use the local
profile, so a host is how private threads get a model at all. Each user
picks their own voice and speed per language with the speech model's
**Settings**, in its host's "N models" list under Models, Hosts and
endpoints; without one, the model's first voice for the language is used.

## Images

Confirmed, ready recipes can go in the `image.create`, `image.edit` and
`image.upscale` lists, like any other model (see "Use it from Lyrica").
Set each host recipe's **Use for** in **Models → Image models** to **Fast**,
**Quality** or **Both** (default). Create skips recipes tagged only for the
other tier, including on fallback; edits and upscaling use their lists as before.
Her `image` tool keeps a recipe's defaults unless she gives a size or
count, and never picks parts or LoRAs itself. Each list is an ordered
fallback, and private threads only use local models. SeedVR2 recipes
upscale. Before any cloud fallback, a portrait photo's cloud setting is
checked. OpenAI setup and offline diagrams are in the
[getting-started guide](getting-started.md#image-models). No real GPU image
job has run yet: item 9 of the checklist below.

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
- A host **can be paired with several Lyrica servers** at once; its
  dashboard lists them.

## Operating a host

- **Pause** on the dashboard (or from Lyrica, `…/hosts/<endpoint
  id>/pause`) refuses new work, finishes the current job, unloads every
  model and stops vLLM, so nothing of the host's stays in VRAM while you
  use the GPU for something else. Resume loads the pinned models again.
  Pause survives a restart. Lyrica falls back to the next model meanwhile.
- **Logs:** `docker compose logs host-api` in `host/`. They hold event
  names, ids and counts; never a pairing code or a prompt. The model
  servers log nothing at all, so `docker logs` on them fails. To see what
  holds the GPU, `nvidia-smi --query-compute-apps=pid,process_name,used_memory
  --format=csv`.
- **Upgrade:** `git pull && host/install.sh` in the checkout. It rebuilds
  the images and restarts the stack; `.env` keeps the settings, and the
  `data` volume keeps the host's key, so pairing survives. A host
  installed before the image server got its `/triton` scratch space needs
  this once, or image jobs fail with an `ImportError` (seen on NVIDIA).
- **Restarting host-api alone** (a re-run of `install.sh` that leaves
  llama.cpp running) loses track of the models llama.cpp still holds:
  their memory counts as other programs', so a model may be refused as too
  big. `docker restart lyrica-host-llamacpp-1` clears it.
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
9. An image: install the Z-Image Turbo starter recipe, make an image, edit
   and upscale. The ComfyUI workflow templates have never run, so expect
   node or input names in `host/workflows/` to need fixing.

Report what fails, with the `host-api` log lines, in the Operator docs
thread.
