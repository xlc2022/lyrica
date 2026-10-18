# Getting started: Lyrica on a new machine

How to bootstrap `lyricad`, the one process that is Lyrica, on a fresh
machine, and what to do on the first day. Her expected home is NixOS,
through the repository's flake and its `services.lyrica` module; Debian or
Ubuntu, through `daemon/deploy/install.sh` and the systemd units next to
it, is the other way. The reference for each piece is
[docs/daemon.md](../daemon.md) ("Deployment" and "On NixOS")
and [docs/workspace.md](../workspace.md) ("Host requirements"). Model hosts
(the GPU machines that run her models) have their own guide,
[model-hosts.md](model-hosts.md), and the machines that run the project's
checks have [ci-runners.md](ci-runners.md). Her web search uses a SearXNG
you host: [searxng.md](searxng.md).

**What has and hasn't been exercised.** Neither way has run on a real
host yet. CI builds the NixOS module and runs the sandbox tests with its
tools (`nix flake check`), but `nix/check-host.sh` has never run on a real
NixOS machine. No automated check runs `install.sh`, and it has never been
run on a fresh Debian host, nor its unit and hardening on an LXC container
(the daemon brief's handoff says so). Everything below is read from the
script and the units, so expect to hit something the first time; the
checklist at the end is for that first run. The checks CI does run on every
pull request (typecheck, tests, the sandbox tests as an unprivileged user,
the web build and the browser tests) run on Ubuntu 24.04, not on Debian.

## What you end up with

One machine, in practice a NixOS VM on your Proxmox (or a Debian or
Ubuntu VM or LXC container), running:

- `lyricad` as the `lyrica` system user, from the release that
  `/opt/lyrica/current` points at (on NixOS, the profile
  `/nix/var/nix/profiles/lyrica`), with its state
  in `/var/lib/lyrica` (`self.db`, each user's encrypted databases and home
  workspace, saved credentials). It listens on `127.0.0.1:7340` and on a
  Unix socket. A fresh install also serves HTTPS itself on port 7340 of
  every LAN and Tailscale address, with its own certificate (Web access,
  Direct).
- Her own `tailscaled` (`lyrica-tailscaled.service`), as the `lyrica` user
  in userspace networking, so she can be a device of her own on a tailnet.
  The host's own Tailscale, if it has one, is left alone.
- The built-in Caddy (`/usr/local/bin/lyrica-caddy`) as the `lyrica-caddy`
  user, for when Web access serves a name of yours with a real certificate.
  It is built once by the install script, with DNS plugins, and configured
  by `lyricad` through a Unix socket.
- The updater (`lyrica-update`, `lyrica-rollback` and their units), run as
  root. It installs releases from annotated `update/*` tags on `main`,
  built by the `lyrica-build` user, with a snapshot of her databases before
  each switch.

Her models run elsewhere: on cloud endpoints, on any OpenAI-compatible
server on your network, or on a paired model host.

## Before you start

### What the machine needs

These are estimates. None was measured on a real host.

| | Minimum | Suggested |
|---|---|---|
| **Lyrica alone**, models elsewhere (cloud, or another model host) | 2 vCPU, 4 GB RAM, 32 GB disk | 4 vCPU, 8 GB RAM, 64 GB disk |
| **Lyrica and the model host on one machine** | 8 cores, 32 GB RAM, 1 TB NVMe, one 24 GB NVIDIA card | 16 cores, 64 GB RAM, 2 TB NVMe, 48 GB of NVIDIA VRAM |

- **Lyrica alone.** Measured on the repository's build: `npm ci` peaks near
  0.5 GB of memory, the web build near 0.3 GB, and a built release takes
  about 280 MB (`/opt/lyrica/releases` keeps up to five, so about 1.4 GB).
  The Caddy build (Go, `xcaddy`) is the heaviest step and, inferred,
  needs 1 to 2 GB of memory and a few hundred MB of disk while it runs. On
  NixOS the Nix store holds the system, the package and the sandbox tools
  (inferred: 15 to 20 GB with a few generations). Headless Chromium and
  its fonts, for her screenshots, add about 1 GB on either system. Her
  databases, snapshots and users' files grow on top of that.
- **One machine for both.** From the model host's sizing: the minimum
  runs Qwen3.8-27B (Q4_K_M) at 128k context with a q8_0 KV cache, not 1M.
  The suggested card memory runs 1M at a q4_0 KV cache with speech
  alongside. The disk holds models, Docker images and builds. NVIDIA is
  recommended; AMD works through ROCm on the chips listed there or through
  Vulkan; Intel and Apple GPUs are not supported. See
  [model-hosts.md](model-hosts.md) and [host/README.md](../../host/README.md).
- **CPU architecture.** NixOS: x86-64 only (the flake builds for
  `x86_64-linux`). Debian and Ubuntu: amd64 or arm64; the install script
  refuses anything else.

### In a Proxmox LXC container (Debian or Ubuntu)

Her tools run commands in a bubblewrap sandbox and mount each user's home
workspace with gocryptfs, so the container needs unprivileged user
namespaces, FUSE and a tun device. A VM needs nothing special.

1. In Proxmox, under the container's Options, Features, turn on `nesting`
   and `fuse` (or `features: nesting=1,fuse=1` in its config).
2. For `pasta` (the sandbox's network), pass the tun device through in
   `/etc/pve/lxc/<id>.conf`:

   ```text
   lxc.cgroup2.devices.allow: c 10:200 rwm
   lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
   ```

3. Restart the container.

The full checklist, with the commands that prove each piece works, is in
[docs/workspace.md](../workspace.md#host-requirements).

## Install

### On NixOS

The repository is a flake, and its NixOS module sets up what the install
script does on Debian: the users, `/var/lib/lyrica`, the units with the
same hardening, her own `tailscaled`, and Caddy with the DNS plugins.
Saving the passphrase needs systemd 256 or later; NixOS 26.05, which the
flake builds against, has 260. The package brings its own Node. The
reference is [docs/daemon.md](../daemon.md#on-nixos).

**From nothing.** The steps follow the
[NixOS manual's installation chapter](https://nixos.org/manual/nixos/stable/#sec-installation);
read it for anything not covered here.

1. **The machine.** On bare metal, nothing to do. In a Proxmox VM: machine
   type `q35`, BIOS `OVMF (UEFI)` with an EFI disk, CPU type `host`, a
   VirtIO SCSI disk and the sizes from "What the machine needs".
2. **Boot the installer.** Download the NixOS 26.05 minimal ISO (x86-64)
   from [nixos.org/download](https://nixos.org/download/), boot it, and
   become root with `sudo -i`. The disk is `/dev/sda` below (check with
   `lsblk`; a VirtIO Block or NVMe disk has another name).
3. **Partition, format and mount** (the manual's UEFI example, without swap):

   ```sh
   parted /dev/sda -- mklabel gpt
   parted /dev/sda -- mkpart root ext4 512MB 100%
   parted /dev/sda -- mkpart ESP fat32 1MB 512MB
   parted /dev/sda -- set 2 esp on
   mkfs.ext4 -L nixos /dev/sda1
   mkfs.fat -F 32 -n boot /dev/sda2
   mount /dev/disk/by-label/nixos /mnt
   mkdir -p /mnt/boot
   mount -o umask=077 /dev/disk/by-label/boot /mnt/boot
   nixos-generate-config --root /mnt
   ```

4. **Edit `/mnt/etc/nixos/configuration.nix`.** Add, inside the braces,
   a user, SSH and flakes (keep the generated boot loader and
   `system.stateVersion`):

   ```nix
   networking.hostName = "lyrica";
   users.users.ada = { isNormalUser = true; extraGroups = [ "wheel" ]; };
   services.openssh.enable = true;
   services.qemuGuest.enable = true; # Proxmox VM only
   nix.settings.experimental-features = [ "nix-command" "flakes" ];
   ```

5. **Install and reboot.** `nixos-install` asks for the root password. Then
   `nixos-enter --root /mnt -c 'passwd ada'` sets your user's, and `reboot`
   (remove the ISO). Log in over SSH as that user.
6. **Turn `/etc/nixos` into a flake.** Create `/etc/nixos/flake.nix` (as
   root, `sudo -e`), using the `networking.hostName` from step 4 as the
   configuration's name:

   ```nix
   {
     inputs.lyrica.url = "github:xlc2022/lyrica";
     # One nixpkgs, Lyrica's own: the module's Caddy hash is for it.
     inputs.nixpkgs.follows = "lyrica/nixpkgs";

     outputs = { nixpkgs, lyrica, ... }: {
       nixosConfigurations.lyrica = nixpkgs.lib.nixosSystem {
         system = "x86_64-linux";
         modules = [
           ./configuration.nix
           ./hardware-configuration.nix
           lyrica.nixosModules.default
           { services.lyrica.enable = true; }
         ];
       };
     };
   }
   ```

   While the repository is private, `nix flake lock` and `nixos-rebuild`
   need a GitHub token to fetch it. Make a fine-grained, read-only token
   for this one repository, put `access-tokens = github.com=<token>` in
   `/etc/nix/access-tokens.conf` (owned by root, mode 0600), and add
   `nix.extraOptions = "!include /etc/nix/access-tokens.conf";` to
   `configuration.nix`. Not on the command line, which keeps it in shell
   history, and not in `nix.settings`, which copies it into the
   world-readable Nix store. Until the first rebuild applies that, pass
   the file in for those two commands, for example `sudo env
   NIX_CONFIG="$(sudo cat /etc/nix/access-tokens.conf)" nixos-rebuild
   switch --flake /etc/nixos#lyrica`; history keeps the command, not the
   token.
   Leaving `nixpkgs` unfollowed also builds, but then the system's
   nixpkgs can differ from the one the module's Caddy hash and CI use
   (inferred; only the followed form was evaluated).
   The options of `services.lyrica` are `port` (7340), `tailscale` (on: her
   own `tailscaled`, from `tailscalePackage`), `openFirewall` (on: opens
   port 7340 for Direct, whatever `port` is, so the machine can be set up
   from another one), `caddyPackage`, and `sandboxPackages`, the tools her
   commands see (NixOS has no `/usr` to share, so the module builds one
   directory from that list, which includes git, gh, tea, Node 22 and
   Claude Code by default; add to it to give her more). Claude Code is
   unfree, but the module allows that one package alone, so your system
   configuration needs no `allowUnfree` line. The module refuses to build
   while `security.allowUserNamespaces` is off; it is on by default.
   To run the model host on the same machine, add its module as well:
   [model-hosts.md](model-hosts.md).
7. `sudo nixos-rebuild switch --flake /etc/nixos#lyrica`. The package
   builds lyricad, the CLI and the web UI, and `lyricad` starts setting
   up, as on Debian. Nothing prints the setup code at the rebuild: `lyrica admin setup-code`, as root, prints
   it with the addresses and the fingerprint. The first build fetches many
   sources at once; if the Caddy plugin fetch fails on a DNS timeout
   (`sum.golang.org`), run the same command again.
8. The first run below is the same. `lyrica` is on the system path and
   runs as her user with her state folder, as on Debian.
9. Instead of "Check the deploy", run `nix/check-host.sh` from a checkout
   of the repository, as root, after the first run. It checks `lyricad`
   and Caddy, that her `tailscaled` answers on its socket, `NoNewPrivs`,
   the setuid `fusermount3`, Caddy's socket, `lyrica-update.path`, a
   sandbox and `pasta` as the `lyrica` user, the network self-test and the port, one line each, and
   ends with "All checks passed." or stops at the first failure.
10. The self-test runs at unlock, so `check-host.sh` misses it when she
    hasn't been unlocked yet (after `lyrica admin init` she starts
    locked). After the first unlock, run

    ```sh
    journalctl -u lyricad _SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value lyricad) | grep 'network is off'
    ```

    It must print nothing. It reads only the current `lyricad` run, so
    lines from an earlier run in the same boot don't count.

Everything from "Save the passphrase" on applies unchanged. `lyricad`
runs from the profile `/nix/var/nix/profiles/lyrica`, and its first start
makes `/etc/lyrica/deploy-key`: add its `.pub` as in "Add the deploy key"
below. Keep a scheduled Proxmox backup of the VM, for the reason given
there. Upgrading is
`nix flake update lyrica` in `/etc/nixos` and `nixos-rebuild switch`,
which restarts `lyricad` (which logs everyone out). Before that start, when the package
changed, her databases are snapshotted and the profile moves to it; if the
new package can't read them, the newest snapshot it can read is restored.
The package is rebuilt only when the code it ships changed; a commit that
touched only docs or tests reuses the built one, and the restart is quick.
Updates and rollback from "Upgrading" work on NixOS too. After an
Update, run `nix flake update lyrica` before your next `nixos-rebuild`
for any reason: the system flake's lock still names the older commit.
lyricad keeps the newer release anyway and logs it once ("the module's
package (…) is older than the running release (…)" in `journalctl -u
lyricad`). For the same reason, pinning the flake to an older commit
doesn't take her back: use Roll back. The home page header shows the
commit that is running, as on Debian.

### On Debian or Ubuntu

**From nothing.**

1. **Pick a release.** Debian 13 "trixie" (systemd 257) or Ubuntu Server
   26.04 LTS (inferred: systemd 256 or later; not checked). Saving the
   `self.db` passphrase needs systemd 256 or later
   (`systemd-creds encrypt --user`). Debian 12 and Ubuntu 24.04 work
   too, but she can't start unlocked: you type the passphrase on the unlock
   page after each start, and everything else is the same. Ubuntu 25.04 is
   end of life.
2. **The machine.** In a Proxmox LXC container, do the features in the
   section above first, then continue at step 4. In a Proxmox VM: machine
   type `q35`, BIOS default or `OVMF (UEFI)` with an EFI disk, CPU type
   `host`, a VirtIO SCSI disk and the sizes from "What the machine needs".
3. **Install the OS** from the Debian netinst or the Ubuntu Server ISO. At
   the software choice, pick only "SSH server" (Debian, plus "standard
   system utilities") or "Install OpenSSH server" (Ubuntu); no desktop.
   Reboot, log in over SSH, and become root (`su -` on Debian, `sudo -i`
   on Ubuntu).
4. **Update and add what the script expects to find.** The script checks
   for root, a git checkout and Node, and installs the rest itself. You
   need `git` to clone, and `curl` and `ca-certificates` for NodeSource:

   ```sh
   apt-get update && apt-get upgrade -y
   apt-get install -y git curl ca-certificates
   ```

5. **Node.js 22.6 or later**, installed before the script runs (it checks
   and stops otherwise). The SSH helper that machines use runs with
   Node's type stripping, which arrived in 22.6; an older 22 fails every
   machine call. NodeSource's packages are one way:

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt-get install -y nodejs
   node --version   # v22.6 or later
   ```

6. **Internet access** during the install: npm, `proxy.golang.org` for the
   Caddy build, Playwright's download servers for headless Chromium, and
   `pkgs.tailscale.com` when Tailscale isn't installed yet. Updates later
   fetch from GitHub over SSH with a deploy key.
7. As root, from a git checkout of the repository outside `/opt/lyrica`:

   ```sh
   git clone https://github.com/xlc2022/lyrica /root/lyrica
   cd /root/lyrica
   daemon/deploy/install.sh
   ```

A release is exactly one commit, so the script refuses a checkout with
uncommitted changes. It builds the web UI itself.

What `install.sh` does, in order:

1. Installs the packages her sandboxes need: bubblewrap, gocryptfs, FUSE,
   passt, nftables, ImageMagick (the Files panel's thumbnails are made in
   the sandbox), openssl, curl, unzip and rsync for itself, and
   build-essential, python3, git, openssh-client and jq for building
   releases and fetching updates, and `gh` and `tea` for threads with
   repositories (`tea` only where it is packaged; without it, Gitea and
   Forgejo accounts work through git alone). It installs IBM Plex and
   Playwright's headless Chromium with the libraries it needs, in
   `/usr/local/lib/lyrica-chromium`, so her sandboxes can take
   screenshots. It installs Anthropic's Claude Code
   (`@anthropic-ai/claude-code`, at the version the script pins) with npm
   into `/usr/local`; if that fails it only prints a warning. When
   Tailscale's binaries are missing it adds Tailscale's apt repository
   and installs `tailscale`; the package turns on the host's own
   `tailscaled`,
   and the script turns it off again unless it was on before.
2. Creates the `lyrica`, `lyrica-caddy` and `lyrica-build` system users.
   `lyricad` gets the `lyrica-caddy` group from its unit, so it alone can
   reach Caddy's admin socket. `lyrica-build` builds releases with no
   access to her data.
3. Installs the updater, its units, the bare repository
   `/opt/lyrica/repo.git`, GitHub's pinned host key in
   `/etc/lyrica/known_hosts`, and (the first time) a deploy key in
   `/etc/lyrica/deploy-key`, whose public half it prints at the end.
4. Builds the checkout's commit, as `lyrica-build`, into
   `/opt/lyrica/releases/<commit>`, makes it root-owned and read-only, and
   points `/opt/lyrica/current` at it (`previous` at the one before). When
   `lyricad` was running another release, it lets turns finish, stops her
   and snapshots her databases first. `/var/lib/lyrica` is created for the
   `lyrica` user, mode 0700. It also installs the `lyrica` command in
   `/usr/local/bin`.
5. Builds Caddy with `xcaddy` from pinned versions of Go, xcaddy, Caddy and
   every DNS plugin in `daemon/src/web/providers.ts`, in a clean
   environment. This takes a few minutes the first time. Running the script
   again rebuilds only when a pin changed.
6. Sets `net.ipv4.ip_nonlocal_bind=1`, so Caddy can bind a Tailscale address
   before Tailscale is up.
7. Installs, enables and starts `lyrica-caddy.service`,
   `lyrica-tailscaled.service` and `lyricad.service`, enables and
   starts `lyrica-update.path`, and enables `lyrica-probation.service`,
   which resumes an update's probation after a reboot. On an upgrade it restarts `lyricad`. On a
   fresh install `lyricad` starts setting up, and the script ends by printing
   a one-time setup code, the addresses to open and the certificate's
   fingerprint (see "First run").

Running it again later installs the checkout's commit as a new release
(see "Upgrading").

**Add the deploy key.** Updates fetch from GitHub with that key. Add the
printed line (also in `/etc/lyrica/deploy-key.pub`) to the repository on
GitHub under Settings, Deploy keys, without write access.

**Keep a scheduled Proxmox backup of the container.** The updater
snapshots her databases, but it can't snapshot the container it runs in.

## First run

### Note the addresses and the fingerprint

Without `self.db`, `lyricad` runs **setting up**: it answers nothing but
the setup call, and serves HTTPS with a certificate of its own on port 7340
of the machine's LAN and Tailscale addresses. A fresh install ends by
printing what you need, and this prints it again until she is set up:

```sh
lyrica admin setup-code
```

```text
Setup code: XXXX-XXXX
Open:       https://<address>:7340
Certificate fingerprint (SHA-256), to compare with the browser's warning:
  <fingerprint>
```

`lyrica` (in `/usr/local/bin`, or on the system path on NixOS) runs the CLI as the `lyrica` user with her
state folder, from root or any sudoer, so the files it makes are hers. It
works from any folder: from one she can't enter, such as your home, it runs
from `/`. Every `lyrica admin …` command in this guide works the same way
from any shell.
Each restart while she is still setting up makes a new code.

### Set her up in the browser

Open one of the printed addresses from any machine on your network. The
browser warns about the certificate once; go on only if its SHA-256
fingerprint matches the one printed. The page is **Set up Lyrica**:

1. **Code and passphrase:** the setup code, a new `self.db` passphrase
   twice, and **Start unlocked**, which saves the passphrase (see "Save the
   passphrase" below). It is off, with the reason, where saving isn't
   available.
2. **Name:** her name, Lyrica by default.
3. **Administrator:** the first administrator's login, password, display
   name and pronouns. **Create** makes `self.db`, imports the persona seed
   from `persona/`, unlocks her and signs you in. A wrong code says so; too
   many wrong codes make you wait, longer each time.
4. **Tailnet** (or Skip): an auth key and hostname to put her on your
   tailnet, then whether to serve the web UI there too.
5. **Models** (or Skip): one shared endpoint, whose first chat model
   becomes the default.
6. **Done:** the addresses to open her at with the fingerprint, your
   login, the tailnet, and whether she starts locked. **Start a chat**.

`journalctl -u lyricad -f` shows her starting. No restart is needed.

The other way is a terminal: `lyrica admin init` asks for the passphrase,
her name and the first administrator (no code needed; passwords and
passphrases are read at hidden prompts, never passed as arguments, so it
needs a real terminal: over SSH, `ssh -t`), then
`systemctl restart lyricad`, and she starts locked. It does not set up the
tailnet or models: do those under Administration and Settings.

### Unlock her

After every restart without a saved passphrase she starts **locked**: the
API answers only the state and unlock calls, and the web UI serves its
unlock page. Enter the passphrase there, then log in. A script that
calls `POST /api/unlock` instead must send an `Origin` header matching her
address, or it gets `403`.

### Check the deploy

Two things to look at once she is unlocked:

- **The unit's hardening didn't break her tools.** The sandbox needs the
  setuid `fusermount3` and unprivileged user namespaces, so `lyricad` must
  run without `no_new_privs`:

  ```sh
  grep NoNewPrivs /proc/$(systemctl show -p MainPID --value lyricad)/status
  ```

  must print `NoNewPrivs: 0`. The unit keeps only `PrivateTmp` and
  `ProtectControlGroups`; the comment in `daemon/deploy/lyricad.service`
  lists what must stay off and why.

- **The network self-test passed.** At unlock, `lyricad` starts a sandbox
  and checks that it can't undo its own firewall rules. If that fails, the
  journal says "network is off for every thread" with the reason, and
  Administration, Status shows it to administrators. Until it is
  fixed, her commands have no network at all; everything else works.
  After the first unlock,

  ```sh
  journalctl -u lyricad _SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value lyricad) | grep 'network is off'
  ```

  must print nothing.

### Save the passphrase

Under Administration, Start unlocked (administrators only; the user menu at
the foot of the sidebar opens Administration), enter the passphrase and
**Save**: it is sealed with `systemd-creds` into
`/var/lib/lyrica/credentials/`, and lyricad unseals it into memory at each
start with `systemd-creds decrypt --user`, so she comes up unlocked after a
reboot. If the saved file can't be decrypted, she starts locked; unlock by
hand. The button is disabled, with the reason, on a system where
`systemd-creds` isn't available. Forget it there to go back to unlocking
by hand. On Debian or Ubuntu, an install from before lyricad unsealed it
itself gets the new `lyricad.service` only from an `install.sh` run:
Updates never replace units, so an install that only takes Updates keeps
the old one, and Administration → Status says the unit is older than
the release. Run `install.sh` once before saving the passphrase: the old
unit has systemd unseal the file itself, which can fail and stop lyricad
from starting.

To change the passphrase later, use **Change passphrase…** under
Administration, Start unlocked: the current passphrase, then the new one
twice. She keeps running, and from then on only the new one unlocks her.
A saved Start unlocked passphrase is re-saved with the new one; if that
fails, the saved copy is removed and the page says so: save it again.
With lyricad stopped (`sudo systemctl stop lyricad`), `sudo lyrica admin
passphrase` does the same at hidden prompts, and says so if the saved
copy was removed; it refuses while lyricad runs. Then start lyricad
again. Old update snapshots of `self.db` keep opening with the old
passphrase.

Each user can likewise save their own data key under Settings, Unlock and
lock, so
their home workspace mounts at start and sleep can run for them without a
login.

An administrator can set any user's password with **Change password…** on
that user's row under Administration, Users, giving their own password too.
The user's data stays; they are logged out everywhere and told who set it
until they change it under Settings, Password.
This works because `self.db` keeps a recovery copy of each user's key, so
whoever holds the passphrase can open every user's data. A user created
before that copy existed gets it at their next login, or when their saved
key loads at start; until then, Change password… says they need to log in
once first.

## Reach her from other machines

A fresh install starts in **Direct**: `lyricad` serves HTTPS itself on port
7340 of every LAN and Tailscale address, with its own certificate. When the
machine's addresses change, the next start makes a new certificate and logs
its fingerprint. Direct stays on until an administrator picks another mode
under Administration, **Web access**: Only this machine, Direct, Tailnet,
Built-in Caddy or A proxy elsewhere.

For a name of your own with a certificate browsers trust, use the built-in
Caddy:

1. Pick a name under a domain you control, such as `lyrica.example.net`, and
   point its DNS record at the machine's Tailscale address. On the LAN,
   split DNS can give the same name the LAN address.
2. Make an API token at your DNS provider, limited to that one zone. The
   page lists the providers Caddy was built with (Cloudflare, Porkbun,
   Namecheap, Route 53, DigitalOcean, Hetzner, deSEC, Duck DNS) and how to
   scope each token.
3. In Web access choose **Built-in Caddy**, enter the name, tick the
   Tailscale and LAN addresses to serve on, pick the provider and paste the
   token, and apply. The certificate comes by DNS-01 challenge, so the
   machine needn't be reachable from the internet. A new name can take
   about 90 seconds; the page shows the certificate's state and Caddy's
   last error.

A change never locks you out: the old setup keeps serving until the new one
has a working certificate. The other mode, **A proxy elsewhere**, is for a
Caddy or other proxy elsewhere on your network; the page gives it a
Caddyfile snippet and a certificate to pin. Details are in
[docs/daemon.md](../daemon.md#web-access).

Caddy and Direct keep serving while `lyricad` is locked, so after a reboot
the unlock page is reachable.

Her own `tailscaled` runs from the install on, but on no tailnet until the
setup page or Administration, **Tailnet** joins one with an auth key. Then
the **Tailnet** mode in Web access serves her at her own ts.net name
through `tailscale serve`. Details are in
[docs/daemon.md](../daemon.md#the-tailnet).

## Give her models

She has no model until you add one. Each user has two columns, **Private
threads** and **General threads**, each following a preset that maps tasks
(main conversation, subagents, titles, sleep, dictation, read aloud and so
on) to ordered lists of models; the first model that answers is used, and
private and local-only threads use the Private column only. Dictation uses
the Private column too, unless a thread picks its own model, so its
`speech.transcribe` list goes there. See [docs/models.md](../models.md).

- **A cloud or OpenAI-compatible endpoint:** Models, Hosts and endpoints,
  **Add endpoint** (Name, Kind Custom, Base URL, API key, then the Local or Cloud checkbox). Shared
  endpoints, which every user can use, need an administrator. The same from
  a terminal:

  ```sh
  lyrica admin models endpoints add openrouter cloud https://openrouter.ai/api/v1 --shared
  lyrica admin models preset set general chat openrouter/<model-id> --user ada
  lyrica admin models preset list --user ada
  ```

- **A model host** (a GPU machine of your own running the host stack):
  [model-hosts.md](model-hosts.md).
- **llama-server, LM Studio, KoboldCpp** on your network are plain local
  endpoints. Start llama-server and KoboldCpp with `--jinja` (KoboldCpp also
  `--jinja_tools`) for tool calling, and enter a context window by hand
  where the server doesn't report one (`endpoints model … --context`).

### Image models

Her `image` tool creates and edits pictures through a ChatGPT plan, an
OpenAI API key or confirmed recipes on a paired model host, and upscales
through host recipes only. It uses the `image.create`, `image.edit` and
`image.upscale` task lists; private and local-only threads always use the
Private column's. Each list is an ordered fallback: create takes the first
entry that fits and falls back down the list. Results are saved in the
encrypted thread folder, with no prompt metadata.

**Use for** sets each image model to **Fast**, **Quality** or **Both** (the
default), and a request skips models set only for the other one. It is
saved at once. Hosts keep their recipe defaults for both; OpenAI uses low
or high quality. Set it in **Models → Image models**, in the model's opened
row: a host recipe, ChatGPT Images, or a key's model once Generate is on.

To make images in the cloud, add an endpoint under Models, Hosts and
endpoints:

- **ChatGPT plan:** Add endpoint, Kind ChatGPT plan, and sign in. Images count
  against the plan's own limits. Edits with a mask skip the plan; edits
  without one work.
- **OpenAI API key:** Add endpoint, Kind Custom, Base URL
  `https://api.openai.com/v1`, select Cloud, and the key. The name
  defaults to **OpenAI**; you can rename it, and the examples below call
  it `openai-images`.

A signed-in ChatGPT plan shows one image model, **ChatGPT Images**, under
Cloud on Models, Image models; it makes and edits images from the start.
For a key, open Image models, then **Other cloud models** at the foot of
the Cloud group, and tick **Generate** and **Edit** for each model that
supports them (`gpt-image-1`, for example). Only the endpoint's owner, or
an administrator for a shared endpoint, can change them. To use the plan
first and the key as a paid fallback, put ChatGPT Images first in the
General threads column's image lists and the key's model after it.

Then put models in the lists, under Models, Tasks, or from a terminal
(`private` for the Private column, `general` for the General column):

```sh
lyrica admin models preset set general image.create openai-images/gpt-image-1 --user ada
lyrica admin models preset set general image.edit openai-images/gpt-image-1 --user ada
lyrica admin models preset set private image.upscale '<host>/<recipe>' --user ada
```

When a model refuses, the image says it declined, and nothing falls back.
**Edit message** puts the request back in the composer while it is still
the last message, **Resend** asks the same model again, and **Try**
followed by a model name appears when an eligible model on another
endpoint follows it in the list. A retry checks portrait consent again and
doesn't change your task lists.

Add reference photos and choose their cloud setting in **Settings → Portrait
photos**. Ask once a day is the default; **Send today** allows them through
server-local midnight, and **Not today** declines the request.

Diagrams with exact layouts render offline with the headless Chromium and
fonts already in her sandbox (`install.sh` installs them; on NixOS they are
in the default `sandboxPackages`, so keep them if you override it). An
install from before them gets them on its next `install.sh` run or rebuild.
No GPU is needed: see
[docs/workspace.md](../workspace.md#images-and-portrait-photos).

## Give her folders and a network

Her `read`, `write`, `edit` and `bash` run in a sandbox that sees only the
folders a thread was granted, chosen from lists an administrator sets per
user and per pool (general or private). Without any, she can work only in
each thread's own folder in the user's encrypted home workspace.

```sh
lyrica admin grants add --user ada --pool general /srv/shared/notes
lyrica admin grants list --user ada
```

The folder must be a real directory with no symlinks on its path, readable
by the `lyrica` user (through its group or an ACL for anything she should
write), and may not be in both pools. `/opt/lyrica`, the updater's state
and the snapshots can never be granted. The same lists are under
Administration, Users.

Network defaults are per user and pool: general threads start with internet
on and local services off, private threads with both off. Change
them under Settings, Network (below its "New threads" group, which holds
the default mode and Fallback), or with `lyrica admin net`. Each
thread can narrow or widen its own from the thread settings drawer.

## Give her web search

Her `web_search` asks one SearXNG that you host yourself; Lyrica never
installs or runs it. Host one and give its address under Administration,
**Web search**, which says **Reachable** once a test search works:
[searxng.md](searxng.md). Every thread with the Web search switch on can
then search, private ones included (the engines see the query, never who
asked). `web_fetch` reads a page with `curl` inside the thread's sandbox,
so its network switches decide what it reaches.

## Give her repositories

She works on code in Git repositories the way Claude's project threads do.
Each user adds their accounts under Settings, **Git accounts** (GitHub,
Forgejo, Gitea or Other): a host, the account's login and a token, checked
against the host before it is saved, in one pool. A GitHub account is
general only; a private account must be on a host on your own network,
unless you confirm adding it anyway.
Make each token fine-grained, for the repositories she works on, with no
admin rights. The token stays in `lyricad` and never enters her sandbox,
but every command in a thread that has the repository can use it on that
host.

A Forgejo or Gitea needs a publicly trusted certificate, such as one
from Let's Encrypt or from `tailscale cert` (Tailscale Serve uses it).
One whose certificate comes from your own authority can't be added yet:
`lyricad` checks the account against the host and trusts only Node's own
list of authorities.

A Forgejo or Gitea account whose host is on her own network shows a
**Webhook** section in the account's drawer: a URL on her tailnet address
and a secret, one per account. To have the forge wake her when a pull
request changes, instead of waiting for the next poll (every 2 minutes),
add that URL and secret as a webhook on the repository:

- Keep the content type `application/json`. A form-encoded body is
  refused.
- Choose the pull request, pull request reviewed, pull request comment
  and status events. For a day after a repository's last webhook, she
  polls it only every 10 minutes, so an event left out can wait that
  long.
- The forge machine must be on her tailnet, because the URL is her
  tailnet name.
- Forgejo and Gitea refuse to deliver to a private address unless the
  forge's `app.ini` allows it. Add her tailnet name or `100.64.0.0/10`
  to `[webhook] ALLOWED_HOST_LIST`, keeping `external` in the list if
  the forge sends other webhooks to public hosts (for example
  `ALLOWED_HOST_LIST = external,100.64.0.0/10`), then restart the forge.

GitHub stays on polling, and its account drawer has no Webhook section.

A project's **Repositories** row (Project settings, under This chat) and
the thread drawer list which repositories a thread has. Each thread clones
its own copy into `/workspace/repos`, and `gh` and `tea` there use the
right account by themselves. Details are in
[docs/workspace.md](../workspace.md#git-accounts-and-repositories).

For her own code, the one-time setup on GitHub (her account as a
collaborator, its token as a Git account, rules for `main` and her
`lyrica/*` branches, CODEOWNERS) is in
[docs/workspace.md](../workspace.md#her-own-code).

## Give her Claude Code

She can hand a coding task to Claude Code, Anthropic's own program, and it
runs on your own Claude plan. It isn't a model for her chat: her
conversation and memory never go through it.

1. On any computer where you're signed in to Claude, run
   `claude setup-token` and copy the token it prints.
2. Paste it under Settings, **Claude Code**, and save. It stays in
   `lyricad`, is never shown back, and never enters her sandbox.
3. In a thread's drawer, turn on **Claude Code**. It is off by default, and
   appears only once a token is saved and Claude Code is installed. It works
   only in a general thread that isn't local-only.

Claude Code sends what it reads to Anthropic. Details are in
[docs/workspace.md](../workspace.md#claude-code).

## Give her another computer

A **machine** is one of your other computers that she works on over SSH,
with a dedicated account there, in one pool (general or private) and with
a **mode limit** she can't exceed on it (Ask, Accept edits or Auto; new
machines start at Ask). The reference is
[docs/workspace.md](../workspace.md#machines).

```sh
lyrica admin ssh add --user ada office ada-lyrica@office.lan --pool general --limit ask
```

(`--root <path>` limits her reads and writes there.) It runs in three
steps:

1. She makes a key pair and prints the setup to run **as root on the
   machine**: her public key into `/etc/ssh/authorized_keys/<account>`, a
   file only root can change, with a `Match User` block in
   `/etc/ssh/sshd_config.d/lyrica.conf`, then `sshd -t && systemctl reload
   ssh` (the unit is `sshd` on Fedora and RHEL). The key line is restricted to connections from this computer. If
   she should run some commands as root there, give the account exact
   commands with `visudo -f /etc/sudoers.d/lyrica`, never a password.
2. Press Enter. She connects, prints the machine's host key fingerprint
   and whether her key was accepted, and asks you to confirm the
   fingerprint. Compare it with what the machine prints:

   ```sh
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

   Nothing is saved until you say yes. A private machine whose address
   resolves outside your network asks for a second confirmation.
3. Threads grant the machine like a folder, and her tools take it as a
   target. A command that could wreck the machine (deleting `/` or a home
   folder, `mkfs`, `dd` onto a device, `shutdown` and the like) always
   asks with a warning, whatever the mode.

The same three steps are in the web UI under Settings, Machines, **Add
machine** (SSH or Proxmox); nothing is saved there before you confirm the
fingerprint either. Each machine's row shows whether she can reach it, and
its ⋯ menu has Replace key, Use anyway (a private machine outside your
network) and Remove.

The machine needs OpenSSH 9.6 or later, or a distribution build with the
Terrapin fix (strict key exchange); adding an older one fails with "the
server doesn't offer strict key exchange; update its OpenSSH". On Lyrica's
side, each SSH connection runs in a sandbox of its own, so machines need
`bwrap`, `pasta`, `nft`, `unshare` and `bash` on her host (the install
script installs them, and NixOS's module brings its own)
and a passed network self-test: when the journal says "network is off for
every thread", every machine call fails too, with nothing to fall back to.
If a machine's host key ever changes, every call fails until you confirm
the new key (Replace key in its ⋯ menu); `lyrica
admin ssh list` shows each machine's pool, limit and confirmed key, and
`ssh remove` takes one away. SSH targets added before machines existed
became general machines at Ask; one that had never connected has no
confirmed key and must be added again (`ssh remove <name>`, then `add`).
The same cure applies to a machine added before 2026-10-11 that never
connects, even though its setup was run: about one key in 256 made before
#96 was one OpenSSH could not load, and saved keys are not checked.

## Give her a Proxmox node

A **Proxmox machine** is a Proxmox VE node or cluster she reaches over its
HTTPS API with a token, never a shell: she can list VMs and containers,
read their status and snapshots, and start, shut down, stop or reboot the
ones the token may. Nothing else (no destroy, create, console or snapshot
changes), and her file and shell tools refuse it. It lives in the same
list as SSH machines, with a pool and a mode limit. The reference is
[docs/workspace.md](../workspace.md#proxmox).

**The Proxmox that runs Lyrica's own VM or container is refused**, on
purpose, and there is no way to add it yet. She tells which sign gave it
away (its address is this computer or its gateway, or a guest there has
this computer's name or MAC address).

1. On the Proxmox node, as root, make her a user, a role that can only
   see and power VMs, and a privilege-separated token:

   ```sh
   pveum user add lyrica@pve --comment Lyrica
   pveum role add LyricaPower --privs "VM.Audit VM.PowerMgmt"
   pveum user token add lyrica@pve agent --privsep 1
   ```

   The last command prints the token's secret once. The token she takes
   is `lyrica@pve!agent=<that secret>`.
2. Grant reads everywhere and power only on the VMs she may manage, one
   `/vms/<id>` at a time or a `/pool/<name>`. A separated token has only
   what both it and its user have, so both get each role:

   ```sh
   pveum acl modify / --roles PVEAuditor --users lyrica@pve --tokens 'lyrica@pve!agent'
   pveum acl modify /vms/101 --roles LyricaPower --users lyrica@pve --tokens 'lyrica@pve!agent'
   ```

   Never give her `PVEVMUser` (its console and guest-agent rights run code
   inside the guests) or `Sys.PowerMgmt`.
3. Note the node's certificate fingerprint, to compare in the next step:

   ```sh
   openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pveproxy-ssl.pem
   ```

   (`pve-ssl.pem` in the same folder if there is no `pveproxy-ssl.pem`.)
4. On Lyrica's machine:

   ```sh
   lyrica admin proxmox add --user ada hypervisor https://pve.lan:8006 --pool general --limit ask
   ```

   It prints the setup above again, shows the certificate's fingerprint
   and asks you to confirm it, then asks for the token at a hidden prompt.
   The token is not sent anywhere until the fingerprint is confirmed, and
   the machine is saved only once the token works. A private machine whose
   address resolves outside your network asks a second time.

Threads grant it like any machine. Listing, status and snapshots never
ask; start and shutdown ask like a command under the thread's mode and the
machine's limit; stop and reboot always ask with a warning. If the node's
certificate changes (Proxmox renews it), every call fails until you confirm
the new fingerprint (Replace key in the row's ⋯ menu under Settings,
Machines, which takes a new token too; or `ssh remove <name>`, then
`proxmox add` again). Add machine there, with Proxmox as the kind, is the
same as the command. `lyrica admin ssh list` shows Proxmox machines with
the SSH ones, and `ssh remove <name>` takes one away.

## Day to day

- **Logs:** `journalctl -u lyricad`, `journalctl -u lyrica-caddy` and
  `journalctl -u lyrica-tailscaled`. Each request logs one line with the
  route pattern and status; never message or memory text. Caddy's TLS
  errors go to `/run/lyrica-caddy/tls.log` instead of the journal, since a DNS plugin can quote its token in one.
- **Restart:** `systemctl restart lyricad`. On stop she ends every turn and
  sleep, unmounts home workspaces and drops keys. With no saved passphrase,
  she comes back locked; browser sessions don't survive a restart, so
  everyone logs in again.
- **Her name** is under Administration, Her name, Name. Memories and threads
  written so far keep the old one.
- **Sleep** runs at `sleep.time` (04:00 local by default; Administration,
  Sleep) for every user whose key is available, unless they set Sleep to
  Only when I ask in Settings, Sleep. The **Sleep** page in the
  sidebar shows each night's runs and has **Sleep now**.
- **Where the data is:** everything is under `/var/lib/lyrica`. `self.db`
  and each `users/<id>/` directory are encrypted at rest; a copy made while
  the service is stopped is a backup, and useless without the passphrase.
  With it, every user's data opens through the recovery copies, so keep the
  passphrase as carefully as the backup. The updater's snapshots are in
  `/var/lib/lyrica-snapshots`, readable by root only. It keeps the last
  three, and any taken before a release that drops old schema stay until a
  later such release has passed probation and they are 30 days old. A
  restore keeps the databases it replaced in a `<time>-set-aside` folder
  there, kept the same way.
- **Updates:** an update is an annotated `update/<name>` tag on a `main`
  commit, whose message is the update note. Administration, **Updates**
  shows the running version and the newest note; **Check** looks for one
  and **Update** installs it. From a terminal, as root:

  ```sh
  lyrica-update --tag update/<name>
  ```

  It fetches with the deploy key, builds the release as `lyrica-build`,
  smoke-tests it in a scratch home, lets running turns finish (up to 10
  minutes, or it changes nothing), stops `lyricad`, snapshots her
  databases, switches and starts her. She is then on probation until she
  has been unlocked for 10 minutes with every health check passing, so
  without a saved passphrase someone has to unlock her. A failed check or a
  crash loop rolls back by itself, and Notifications says so for a week.
  A reboot during probation starts it over at boot
  (`lyrica-probation.service`), so the 10 minutes count again from the
  next unlock; if another release is running by then (a rebuild or a
  rollback), that probation just ends. An install from before the unit
  existed gets it on its next `install.sh` run, NixOS on its next
  rebuild; an Update doesn't add it. The Updates page shows each step;
  the updater's state is in `/var/lib/lyrica-update`. An update installs
  no packages: when a release needs a new one, install it by hand or run
  `install.sh` from a checkout. On Debian and Ubuntu, Administration → Status
  reports any installed units that differ from the new release or are missing;
  run `install.sh` from a current checkout to update them. Updates never
  rewrite units, since `lyricad.service` defines her confinement. NixOS units
  are managed by its module instead.
- **Rollback:** under Updates, **Roll back** in a kept release's ⋯ goes
  back to it. As root, `lyrica-rollback` goes back to the previous
  release, or `lyrica-rollback <commit>` to another kept one, older or
  newer. When that
  release can't read her databases, it restores the newest snapshot it can
  read, asking first (`--yes` skips the question), or refuses and names the
  oldest release it could go back to.
- **Upgrading from a checkout** (Debian or Ubuntu; on NixOS it is the
  flake update in "On NixOS"): as root:

  ```sh
  cd /root/lyrica && git pull
  daemon/deploy/install.sh
  ```

  The script installs that commit as a release the same way: turns finish,
  a snapshot, the switch and a restart, which logs everyone out. It
  rebuilds Caddy only if a pin changed. Its first run over an install from
  before releases can't wait for turns, because the old `lyricad` has no
  update socket: stop `lyricad` first, or let turns finish. That run moves
  the old code to `/opt/lyrica/before-releases`; delete it once the new
  release runs. An install made before
  2026-10-11 gets the `lyrica` command and ImageMagick on this run; until
  then the Files panel shows images themselves instead of thumbnails. On
  NixOS the next `nixos-rebuild switch` brings ImageMagick in with the
  default `sandboxPackages`. An existing install gets Tailscale and her
  `tailscaled` on its next run and keeps its web access as it was; Direct
  comes only with a fresh install. An install made before 2026-10-12
  needs `apt-get install gh`, and `apt-get install tea` where it is
  packaged (or this run), for threads with repositories; on NixOS the next
  rebuild brings them. An install without
  `/usr/local/bin/chromium-headless-shell` gets headless Chromium and IBM
  Plex for her screenshots on this run; on NixOS the next rebuild brings
  them. An existing install gets Claude Code on its next `install.sh` run,
  and NixOS on the next rebuild. The home page header (her name, then
  "0.1.0 · <build>") shows the git commit that is running.

## Checklist for the first install on your machine

Run these in order the first time and note where each stops. Each one is
something the code expects but nobody has confirmed on real hardware.

On NixOS, items 1 and 2 are `nixos-rebuild switch` building the module and
`nix/check-host.sh` passing after the first run (it covers item 4, and
item 5 once she has been unlocked: see step 10 of "On NixOS"), and item 3's code comes from `lyrica admin setup-code`. The rest
apply as written.

1. The LXC features and tun device from "In a Proxmox LXC container", then
   the proofs in [docs/workspace.md](../workspace.md#host-requirements):
   `bwrap … /bin/true` and `pasta --config-net -- true` as the `lyrica`
   user. On Ubuntu 24.04 or later, a bubblewrap "Permission denied" means
   `kernel.apparmor_restrict_unprivileged_userns=0` on the Proxmox host.
2. `install.sh` runs to the end on a fresh system. Expected soft spots: the
   Node check, the release build and the Caddy build (each prints the tail
   of its build log when it fails; a checksum mismatch stops Caddy's).
3. `install.sh` prints the setup code, an address and a fingerprint; the
   browser's certificate warning shows the same fingerprint at that
   address. The setup page creates her and signs you in; note any step
   that fails. `systemctl status lyrica-tailscaled` shows it running as
   `lyrica`.
4. `NoNewPrivs: 0` on the running process.
5. The self-test: no "network is off for every thread" in the journal, and
   Administration, Status shows no network warning.
6. In a thread with a granted folder, `read` and a `bash` command work, and
   a command with internet on can reach the internet.
7. A file uploaded in a thread opens with `read` (this proves the home
   workspace mounted: gocryptfs and FUSE).
8. Save the passphrase, `systemctl restart lyricad`, and she comes back
   unlocked. If the button is disabled, note the reason it shows.
9. Web access with the built-in Caddy: the name gets a certificate, and the
   unlock page is reachable at it after a restart.
10. Add the deploy key, push an annotated `update/<name>` tag on `main`, and
    Update on Administration, Updates runs through probation. Then Roll
    back goes back to the release before; `lyrica-update` and
    `lyrica-rollback` do the same from a terminal.
11. Add a Git account and give a thread a repository: it is cloned into
    `/workspace/repos`, and with internet on `gh pr list` works there.
12. Set the SearXNG address under Administration, Web search: it says
    Reachable, and `web_search` answers in a thread.
13. Save a token under Settings, Claude Code, turn the switch on in a test
    thread, and ask her to use it.

Report what fails, with the journal lines, in the Operator docs thread; the
guide gets corrected from the real run.
