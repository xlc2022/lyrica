---
name: model-host
description: Install a Lyrica model host on one of this thread's SSH machines with a GPU, from checking the machine to the pairing code.
---

# Installing a model host on a machine

A model host serves local models to Lyrica from a GPU machine. Lyrica's code is in its repository on the forge; the installer is `host/install.sh`, and the operator's guide is `docs/guides/model-hosts.md` there. Its "The machine" and "Install" sections may be newer than these steps: read them in this thread's clone if the repository is one of the thread's, and otherwise in the clone you make in step 5, before you run the installer. Don't clone anything before step 1's checks. Never change anything under `host/` to make an install work: report what failed.

Work on the machine with the machine argument. A step that needs root goes to the person with `run_as_root`, unless they gave your account sudo without a password there (`sudo -n true` succeeds): then you run it yourself with `sudo`, after the same yes. You never type a sudo password and never ask for one.

1. **Check the machine.** Run these and keep what they print. One command for all of them is one card for the person, and a program that isn't there is an answer, not a failure:
   - `uname -a`, `cat /etc/os-release`: Debian or Ubuntu (NixOS needs the operator's own module first: stop and say so).
   - `nvidia-smi` (or `ls /dev/kfd /dev/dri` for AMD): the GPUs, their memory, and the driver version. `/dev/dri` alone isn't a GPU: a virtual display has one. No GPU: stop. A card with no driver: the driver comes first. Both are below.
   - `for d in /sys/bus/pci/devices/*; do case $(cat "$d/class") in 0x03*) echo "$(cat "$d/vendor"):$(cat "$d/device")";; esac; done`: the cards in the machine, with a driver or without (`0x10de` is NVIDIA, `0x1002` AMD). `0x10de:0x1df4` or `0x10de:0x1d84` is a CMP 100-210, which `nvidia-smi` names a Tesla V100: read "A CMP 100-210" below before you go on.
   - `docker version`, `docker compose version`, `docker info --format '{{.FirewallBackend.Driver}}'`: Docker with the compose plugin and the iptables backend. Podman or the nftables backend won't do.
   - `df -h` on the disk for the models folder (`/srv/models` by default): the images take about 40 GB, and models need their own room.
   - `id`, `sudo -n true`, `command -v git jq iptables curl`.
   - `nvidia-smi --query-compute-apps=pid,used_memory --format=csv` and `docker ps`: whether someone else already uses the GPU. If they do, treat it as a **shared machine** (step 8).

   **No GPU: stop here.** Adding a card is the person's job. Say what you found and change nothing. Being told to install the host anyway, or that a card is coming, doesn't change the answer. An install now would make every system-wide change in step 3 for a host that serves no models, and once the card and its driver are in, the installer has to run again and the images still have to be pulled, so it saves next to nothing. Say that once and leave it there: no card offering an install, and no looking in the guide for another way. The installer's `--no-gpu` is a test mode with no model servers, the one CI uses. Don't bring it up. Go on with it only when the person themself asks for that mode by its name, and say first that it serves no models.

   **A card with no driver: the driver comes first.** Don't go on to step 2 without it, for the same reason. Name the card, say its driver is missing, and offer to install it. Installing it is yours to do when the person says yes, or asks you to: their ask is the yes. Say what it changes before you start, since it is a system-wide change of its own: the distribution's own driver packages and the kernel's headers, never NVIDIA's `.run` installer; the package sources they need switched on (on Debian, `contrib`, `non-free` and `non-free-firmware`); a kernel module, with `nouveau` switched off, so a desktop on that machine changes its display driver; and a reboot. For an AMD card the driver is the kernel's own `amdgpu`, and what is missing is usually its firmware package. Check `mokutil --sb-state` first: with Secure Boot on, the module loads only once its key is enrolled at the machine's own screen during the reboot, which only the person can do, so tell them before you start. Then install it as a root step and reboot the machine the same way. A reboot cuts your connection, so the command that reboots ends with an error: that is the reboot, not a failed step. Then start step 1's checks over on the machine with `background: true`, with `uptime` first: a background command there waits until the machine answers, and `uptime` shows that it did restart. If it ends at once with a connection error, the machine was still going down or not up yet: start it again in a minute. `nvidia-smi` lists the card.
2. **Say what can run there.** From the card: NVIDIA runs llama.cpp, vLLM, images and voices (a CMP 100-210 runs less: below); an AMD GPU outside ROCm's list gets Vulkan, which serves GGUF models only. Name a few model sizes that fit its memory.
3. **List the system-wide changes and wait for a yes.** In one message: the packages to install, adding your account to the `docker` group (which is as good as root on that machine), the models folder, the egress firewall rules and their root systemd unit, which runs `host/egress.sh` from your clone at every boot, the updater (its units, `/etc/lyrica-host` and a deploy key), and that the stack keeps running on the GPU. Ask the person once and wait for their answer.
4. **Prerequisites, as a root step.** Write the script in your home folder on the machine (only what step 1 showed is missing), for example:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail
   apt-get update
   apt-get install -y git jq iptables curl
   # Docker and NVIDIA's container toolkit only if missing, from their own apt repositories
   # NVIDIA only: give Docker the GPU runtime
   if command -v nvidia-ctk >/dev/null; then nvidia-ctk runtime configure --runtime=docker && systemctl restart docker; fi
   usermod -aG docker <your account>
   mkdir -p /srv/models && chown <your account> /srv/models
   ```

   Then `run_as_root` with it and wait for the person's answer. A new group needs a new login, and your connection to the machine stays open between calls: if `docker ps` is still refused, run Docker commands as `sg docker -c '…'` (step 5's too).
5. **Get the code and pull in the background.** Clone the repository into your home folder (`git clone https://github.com/<owner>/lyrica`, the address the person gives or the project's own). Then:

   ```sh
   cd lyrica/host && ./install.sh --yes --no-start --name <host name> --models /srv/models
   ```

   This checks the GPU and writes `host/.env` only. Then start `docker compose build && docker compose pull --ignore-buildable` there with `background: true`, and tell the person it is running. You're told when it ends; read its last lines then.
6. **The install itself, as a root step.** The installer needs root for the egress rules and the updater, and it runs your whole clone as root, so the script pins the clone to one commit and refuses changes in it. Take the commit from `git rev-parse HEAD`, then write:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail
   cd /home/<your account>/lyrica
   test "$(git rev-parse HEAD)" = <commit> || { echo "the clone isn't at <commit>"; exit 1; }
   test -z "$(git status --porcelain --untracked-files=no -- . ':!host/.env')" || { echo "the clone has changes"; exit 1; }
   cd host
   ./install.sh --yes
   chown <your account>: .env
   ```

   `run_as_root` with it, naming the commit in `why`. The builds are already cached, so it takes minutes. It prints a deploy key from `/etc/lyrica-host/deploy-key.pub` the first time: ask the person to add it to the repository as a read-only deploy key, for updates.
7. **Smoke test.** `curl -fsS http://127.0.0.1:7236/host/v1/status` on the machine: the state is `running` and the GPUs are listed. `docker compose ps` in `host/`: every service is up. If one isn't, read its `docker compose logs <service> --tail 50` and report it.
8. **Pause on a shared machine.** If step 1 found someone else on the GPU, pause the host now with `curl -fsS -X POST http://127.0.0.1:7236/host/v1/pause`, then check with `nvidia-smi` that no container of the host holds GPU memory. Never leave a model loaded there.
9. **The pairing code.** `curl -fsS -X POST http://127.0.0.1:7236/dashboard/pairing` makes a code that works once, for 10 minutes. Give it to the person with the host's addresses and its key fingerprint (from `install.sh`'s output), and ask them to open **Models**, **Hosts and endpoints**, **Add model host** at once. They compare the fingerprint Lyrica shows with that one.

## A CMP 100-210

A mining card whose tensor cores are throttled. The installer knows it by its PCI ID and sets the host up for it, so the steps stay the same, with these differences:

- **Driver (step 1).** It needs NVIDIA's proprietary driver from a branch between 535 and 580. The `-open` modules and branches after 580 don't run this card, and older ones are too old for the images. Before you install one, check which branch the distribution's package is, and say so if it is outside that range rather than installing it: `apt-cache policy nvidia-driver` on Debian; on Ubuntu the packages carry the branch in their name (`apt-cache search --names-only '^nvidia-driver-[0-9]+$'`), so pick one in the range.
- **What runs (step 2).** GGUF chat models, on a llama.cpp built for the card. Images from stable-diffusion.cpp, which creates but doesn't edit and takes no LoRAs. Dictation on whisper.cpp, and voices. No vLLM models.
- **The unlock (step 3).** `host/cmp-unlock.sh` gives the card full-rate tensor cores at every boot, which reads prompts about twice as fast. It is optional and a system-wide change of its own, so put it to the person as a second question in step 3's message, with what it does: it builds a kernel module that runs as root at every boot, before Docker; it keeps `nouveau` and `nvidia_drm` from loading, so a desktop drawn by an NVIDIA card on that machine loses its display; it needs Secure Boot off and the kernel's headers; it takes effect after a reboot; and `host/cmp-unlock.sh --remove` undoes it. Without it the host works, slower.
- **Images (steps 5 and 6).** CI publishes the card's own images (`lyrica-host-llamacpp`, `-sdcpp`, `-whispercpp`) for some commits only. Add `--ignore-pull-failures` to step 5's pull so the others still come, and see with `docker image ls` which of the three did. The ones that didn't, step 6's installer builds on the machine, which can take 45 minutes: tell the person how long before you hand it over.
- **Install (step 6).** With a yes to the unlock, the script's line is `./install.sh --yes --cmp-unlock`: `--yes` alone leaves the unlock out without a word. If the output says the unlock wasn't installed, tell the person why and go on. Otherwise ask them to reboot the machine before step 7. When they say it is done, check at once, before any model is loaded, that `docker compose exec llamacpp /app/tensor-probe` in `host/` prints `full`: start it on the machine with `background: true`, which waits until the machine answers (a connection error at once: start it again in a minute). `throttled` means the unlock didn't run, and no output means the probe couldn't tell: report either, and go on, since the host works either way.

If a step fails, stop there and tell the person what it printed and what you think the cause is. Don't work around a refused rule (egress, the firewall backend).
