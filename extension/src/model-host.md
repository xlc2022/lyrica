---
name: model-host
description: Install a Lyrica model host on one of this thread's SSH machines with a GPU, from checking the machine to the pairing code.
---

# Installing a model host on a machine

A model host serves local models to Lyrica from a GPU machine. Lyrica's code is in its repository on the forge; the installer is `host/install.sh`, and the operator's guide is `docs/guides/model-hosts.md` there. Read that guide's "The machine" and "Install" sections in the clone before you start, since they may be newer than these steps. Never change anything under `host/` to make an install work: report what failed.

Work on the machine with the machine argument. Your account there has no password for sudo, so every step that needs root goes to the person with `run_as_root`. You never type a sudo password and never ask for one.

1. **Check the machine.** Run each of these and keep what they print:
   - `uname -a`, `cat /etc/os-release`: Debian or Ubuntu (NixOS needs the operator's own module first: stop and say so).
   - `nvidia-smi` (or `ls /dev/kfd /dev/dri` for AMD): the GPUs, their memory, and the driver version. No driver: stop, since installing one is the person's job.
   - `docker version`, `docker compose version`, `docker info --format '{{.FirewallBackend.Driver}}'`: Docker with the compose plugin and the iptables backend. Podman or the nftables backend won't do.
   - `df -h` on the disk for the models folder (`/srv/models` by default): the images take about 40 GB, and models need their own room.
   - `id`, `command -v git jq iptables curl`.
   - `nvidia-smi --query-compute-apps=pid,used_memory --format=csv` and `docker ps`: whether someone else already uses the GPU. If they do, treat it as a **shared machine** (step 8).
2. **Say what can run there.** From the card: NVIDIA runs llama.cpp, vLLM, images and voices; an AMD GPU outside ROCm's list gets Vulkan, which serves GGUF models only. Name a few model sizes that fit its memory.
3. **List the system-wide changes and wait for a yes.** In one message: the packages to install, adding your account to the `docker` group (which is as good as root on that machine), the models folder, the egress firewall rules and their systemd unit, the updater (its units, `/etc/lyrica-host` and a deploy key), and that the stack keeps running on the GPU. Ask the person once and wait for their answer.
4. **Prerequisites, as a root step.** Write the script in your home folder on the machine (only what step 1 showed is missing), for example:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail
   apt-get update
   apt-get install -y git jq iptables curl
   # Docker and NVIDIA's container toolkit only if missing, from their own apt repositories
   nvidia-ctk runtime configure --runtime=docker && systemctl restart docker
   usermod -aG docker <your account>
   mkdir -p /srv/models && chown <your account> /srv/models
   ```

   Then `run_as_root` with it and wait for the person's answer. A new group needs a new login: check with `docker ps` on your next call.
5. **Get the code and pull in the background.** Clone the repository into your home folder (`git clone https://github.com/<owner>/lyrica`, the address the person gives or the project's own). Then:

   ```sh
   cd lyrica/host && ./install.sh --yes --no-start --name <host name> --models /srv/models
   ```

   This checks the GPU and writes `host/.env` only. Then start `docker compose build && docker compose pull --ignore-buildable` there with `background: true`, and tell the person it is running. You're told when it ends; read its last lines then.
6. **The install itself, as a root step.** The installer needs root for the egress rules and the updater. Write a script that runs it and gives `.env` back to your account:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail
   cd /home/<your account>/lyrica/host
   ./install.sh --yes
   chown <your account>: .env
   ```

   `run_as_root` with it. The builds are already cached, so it takes minutes. It prints a deploy key from `/etc/lyrica-host/deploy-key.pub` the first time: ask the person to add it to the repository as a read-only deploy key, for updates.
7. **Smoke test.** `curl -fsS http://127.0.0.1:7236/host/v1/status` on the machine: the state is `running` and the GPUs are listed. `docker compose ps` in `host/`: every service is up. If one isn't, read its `docker compose logs <service> --tail 50` and report it.
8. **Pause on a shared machine.** If step 1 found someone else on the GPU, pause the host now with `curl -fsS -X POST http://127.0.0.1:7236/host/v1/pause`, then check with `nvidia-smi` that no container of the host holds GPU memory. Never leave a model loaded there.
9. **The pairing code.** `curl -fsS -X POST http://127.0.0.1:7236/dashboard/pairing` makes a code that works once, for 10 minutes. Give it to the person with the host's addresses and its key fingerprint (from `install.sh`'s output), and ask them to open **Models**, **Hosts and endpoints**, **Add model host** at once. They compare the fingerprint Lyrica shows with that one.

If a step fails, stop there and tell the person what it printed and what you think the cause is. Don't work around a refused rule (egress, the firewall backend, a missing driver).
