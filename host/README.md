# Lyrica model host

Turns a Linux GPU machine (NVIDIA or AMD) into a model host for Lyrica: a
Docker Compose stack that Lyrica reaches over mutual TLS after pairing.

- [PAIRING.md](PAIRING.md): how Lyrica and a host come to trust each other.
- [API.md](API.md): what Lyrica can call.

## Install

The machine needs:
- Debian or Ubuntu (other Linux distributions should work), with iptables;
- the GPU driver;
- Docker with the compose plugin, or Podman with a compose provider;
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

## Pairing

1. On the dashboard, choose **Pair with Lyrica**. A code like
   `7KQ2-M9XD-4RTB-W1HZ` appears there and in the log
   (`docker compose logs host-api`). It works once, for 10 minutes.
2. In Lyrica, on the Models page, choose **Add model host**. Give it the
   host's addresses (`192.168.1.20`, or its tailnet name) and the code.

Paired Lyrica servers are listed on the dashboard, where they can be
revoked. A revoked server must pair again.

## Models and GPUs

- **Text models** are found by scanning the models folder:
  - GGUF files are served by llama.cpp. A file whose name starts with
    `mmproj` next to one is its vision projector, and split files count as
    one model.
  - Folders with a `config.json` and safetensors are served by vLLM. A model
    whose config asks for remote code is listed but never loaded.
- **Each GPU has a role**, set on the dashboard:
  - **Shared** (the default) holds llama.cpp models, loaded on demand.
  - **vLLM** holds one vLLM model at a time.
- **Pinned** models (on a shared GPU) are loaded at start and never unloaded
  to make room.
- **Making room.** When a model needs room, idle models are unloaded, least
  recently used first. A pinned model or one in use is never unloaded.
  A model that can never fit fails at once, saying why.
- **Queues.** Requests wait in a queue per GPU: chat first, then images,
  then background work. A request that waits too long fails with "The GPU
  is busy with …".
- **VRAM** use is measured on each model's first load and remembered.
- **Pause** finishes the current job, then unloads llama.cpp's models and
  puts vLLM to sleep. Until Resume, new work gets "The model host is
  paused." Pause survives a restart.

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
  digest. `compose.nvidia.yaml` uses CUDA images and `compose.amd.yaml` uses
  ROCm; `install.sh` picks one. They log nothing (Docker's `none` log
  driver).
  - llama.cpp runs in router mode. host-api writes its preset file (each
    model's file, GPU and context), then loads and unloads models through
    its API.
  - vLLM runs under `vllm/supervisor.py`, which starts one server per vLLM
    GPU as host-api asks in a file. Pause uses vLLM's own sleep and wake.
  - host-api reads VRAM with `nvidia-smi`, through NVIDIA's `utility`
    capability, or from AMD's sysfs.
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
      `lyrica-host-egress.service`, which applies them again after every
      reboot and Docker restart.
    - Without systemd, run `host/egress.sh apply` yourself after each.
    - `install.sh` checks that host-api can't connect out, and stops it
      if it can.
  - With Tailscale, the `tailscale` service has its own network out
    (`tailnet`) and reaches host-api over an internal one
    (`tailscale-api`). It runs with no capabilities. All sign-ins over
    Tailscale come from its address, so they share one rate limit.
- No container mounts the Docker socket.
- The host's key, certificate and state are in the `data` volume, readable
  only by host-api's user. The state is paired clients, the password hash,
  pause, GPU roles, pins, measured VRAM and usage counts. Prompts are never stored, and host-api's log has no text: only
  event names, IDs and counts, plus the pairing code while it's valid.
- Images are pinned by digest. `host-api` is built from this checkout by
  `install.sh`, and CI builds it on every pull request.
- `test/stack/network.sh` checks the network layout on a running stack.

Podman is supported by `install.sh` but hasn't been tested. The local
dashboard's address check and the egress rules assume Docker's port
publishing and its iptables firewall backend.
