# Getting started: Lyrica on a new machine

How to bootstrap `lyricad`, the one process that is Lyrica, on a fresh
Debian or Ubuntu system, and what to do on the first day. This guide follows
`daemon/deploy/install.sh` and the two systemd units next to it; the
reference for each piece is [docs/daemon.md](../daemon.md) ("Deployment")
and [docs/workspace.md](../workspace.md) ("Host requirements"). Model hosts
(the GPU machines that run her models) have their own guide,
[model-hosts.md](model-hosts.md), and the machines that run the project's
checks have [ci-runners.md](ci-runners.md).

**What has and hasn't been exercised.** `install.sh` is run in no automated
check, and as of this writing it has never been run on a fresh Debian host.
The systemd unit and its hardening have not been checked on Li's LXC
container either (the daemon brief's handoff says so). Everything below is
read from the script and the units, so expect to hit something the first
time; the checklist at the end is for that first run. The checks CI does run
on every pull request (typecheck, tests, the sandbox tests as an unprivileged
user, the web build and the browser tests) run on Ubuntu 24.04, not on
Debian.

## What you end up with

One machine, in practice an LXC container or a VM on Li's Proxmox, running:

- `lyricad` as the `lyrica` system user, from `/opt/lyrica`, with its state
  in `/var/lib/lyrica` (`self.db`, each user's encrypted databases and home
  workspace, saved credentials). It listens on `127.0.0.1:7340` and on a
  Unix socket only.
- The built-in Caddy (`/usr/local/bin/lyrica-caddy`) as the `lyrica-caddy`
  user, which is what other machines connect to over HTTPS once Web access
  is set up. It is built once by the install script, with DNS plugins, and
  configured by `lyricad` through a Unix socket.

Her models run elsewhere: on cloud endpoints, on any OpenAI-compatible
server on your network, or on a paired model host.

## Before you start

### The machine

- Debian or Ubuntu, amd64 or arm64. The install script refuses anything
  else.
- **systemd 256 or later** if you want her to start unlocked. Saving the
  `self.db` passphrase uses `systemd-creds encrypt --user`, which older
  systemd doesn't have. Debian 13 and Ubuntu 25.04 have it; Debian 12 and
  Ubuntu 24.04 don't. Without it everything else works, and you type the
  passphrase on the unlock page after each start.
- **Node.js 22 or later**, installed before the script runs (it checks and
  stops otherwise). NodeSource's packages are one way:

  ```sh
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  ```

- `build-essential` and `python3`, so `npm ci` can build the SQLite
  binding when no prebuilt one matches. CI installs `build-essential` on a
  fresh Ubuntu for this reason; the install script doesn't.
- `git`, to clone the repository.
- Internet access during the install: npm, and `proxy.golang.org` for the
  Caddy build.

### In a Proxmox LXC container

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

As root, from a checkout of the repository:

```sh
git clone https://github.com/xlc2022/lyrica /root/lyrica
cd /root/lyrica
npm ci
npm run build
daemon/deploy/install.sh
```

`npm run build` matters: it builds the web UI into `web/dist`, which is
ignored by git, and the install script copies the checkout as it is. The
script itself installs only production dependencies, so it can't build the
UI. Skip the build and `lyricad` starts fine but serves no pages.

What `install.sh` does, in order:

1. Installs the packages her sandboxes need: bubblewrap, gocryptfs, FUSE,
   passt, nftables, and openssl, curl, unzip and rsync for itself.
2. Creates the `lyrica` and `lyrica-caddy` system users. `lyricad` gets the
   `lyrica-caddy` group from its unit, so it alone can reach Caddy's admin
   socket.
3. Copies the checkout to `/opt/lyrica` (without `.git`, `node_modules` and
   `runtime`), runs `npm ci --omit=dev` there, and makes it root-owned and
   read-only for everyone else. `/var/lib/lyrica` is created for the
   `lyrica` user, mode 0700.
4. Builds Caddy with `xcaddy` from pinned versions of Go, xcaddy, Caddy and
   every DNS plugin in `daemon/src/web/providers.ts`, in a clean
   environment. This takes a few minutes the first time. Running the script
   again rebuilds only when a pin changed.
5. Sets `net.ipv4.ip_nonlocal_bind=1`, so Caddy can bind a Tailscale address
   before Tailscale is up.
6. Installs and enables `lyrica-caddy.service` and `lyricad.service`, starts
   Caddy, and either restarts `lyricad` (an upgrade) or tells you to create
   `self.db` first (a fresh install).

Running it again later is the upgrade path (see "Upgrading").

## First run

### Create self.db and the first administrator

The script prints this; run it as the `lyrica` user so the files are hers:

```sh
runuser -u lyrica -- env LYRICA_HOME=/var/lib/lyrica /opt/lyrica/bin/lyrica admin init
```

It asks, at hidden prompts, for a new `self.db` passphrase, the first
administrator's login name (default `li`), a display name and pronouns, and
that user's password. It then imports the persona seed from `persona/`.
Passwords and passphrases are only ever typed at prompts, never passed as
arguments.

### Start her

```sh
systemctl start lyricad
journalctl -u lyricad -f
```

She starts **locked**: until `self.db` is unlocked, the API answers only
the state and unlock calls, and the web UI serves its unlock page. Open
`http://127.0.0.1:7340` from the machine. From your own computer the
simplest way, before Web access exists, is an SSH tunnel:

```sh
ssh -L 7340:127.0.0.1:7340 root@<the machine>
```

then `http://127.0.0.1:7340` in your browser. Enter the passphrase, then log
in as the administrator you created.

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
  journal says "network is off for every thread" with the reason, and the
  control panel's Server section shows it to administrators. Until it is
  fixed, her commands have no network at all; everything else works.

### Save the passphrase

In the control panel (Server section, administrators only), **Save the
passphrase** seals it with `systemd-creds` into
`/var/lib/lyrica/credentials/`; the unit unseals it at each start, so she
comes up unlocked after a reboot. The button is disabled, with the reason,
on a system where `systemd-creds` isn't available. Forget it there to go
back to unlocking by hand.

Each user can likewise save their own data key in their Profile section, so
their home workspace mounts at start and sleep can run for them without a
login.

## Reach her from other machines

By default nothing but `127.0.0.1` can reach her. An administrator sets up
**Web access** in the control panel. The common choice is the built-in
Caddy:

1. Pick a name under a domain you control, such as `lyrica.example.net`, and
   point its DNS record at the machine's Tailscale address. On the LAN,
   split DNS can give the same name the LAN address.
2. Make an API token at your DNS provider, limited to that one zone. The
   panel lists the providers Caddy was built with (Cloudflare, Porkbun,
   Namecheap, Route 53, DigitalOcean, Hetzner, deSEC, Duck DNS) and how to
   scope each token.
3. In Web access choose **Built-in Caddy**, enter the name, tick the
   Tailscale and LAN addresses to serve on, pick the provider and paste the
   token, and apply. The certificate comes by DNS-01 challenge, so the
   machine needn't be reachable from the internet. A new name can take
   about 90 seconds; the panel shows the certificate's state and Caddy's
   last error.

A change never locks you out: the old setup keeps serving until the new one
has a working certificate. The other mode, **External proxy**, is for a
Caddy or other proxy elsewhere on your network; the panel gives it a
Caddyfile snippet and a certificate to pin. Details are in
[docs/daemon.md](../daemon.md#web-access).

Caddy keeps serving while `lyricad` is locked, so after a reboot the unlock
page is reachable at the name.

## Give her models

She has no model until you add one. Each user has three profiles (local,
cloud, custom), each mapping tasks (main conversation, subagents, titles,
sleep, dictation, read aloud and so on) to ordered lists of models; the
first model that answers is used, and private and local-only threads use
the local profile only. See [docs/models.md](../models.md).

- **A cloud or OpenAI-compatible endpoint:** control panel, Endpoints, Add
  an endpoint (a name, cloud or local, the base URL, the API key). Shared
  endpoints, which every user can use, need an administrator. The same from
  a terminal, as the `lyrica` user with `LYRICA_HOME=/var/lib/lyrica`:

  ```sh
  lyrica admin models endpoints add openrouter cloud https://openrouter.ai/api/v1 --shared
  lyrica admin models profile set cloud chat openrouter/<model-id> --user li
  lyrica admin models profile show --user li
  ```

- **A model host** (a GPU machine of your own running the host stack):
  [model-hosts.md](model-hosts.md).
- **llama-server, LM Studio, KoboldCpp** on your network are plain local
  endpoints. Start llama-server and KoboldCpp with `--jinja` (KoboldCpp also
  `--jinja_tools`) for tool calling, and enter a context window by hand
  where the server doesn't report one (`endpoints model … --context`).

## Give her folders and a network

Her `read`, `write`, `edit` and `bash` run in a sandbox that sees only the
folders a thread was granted, chosen from lists an administrator sets per
user and per pool (general or private). Without any, she can work only in
each thread's own folder in the user's encrypted home workspace.

```sh
lyrica admin grants add --user li --pool general /srv/shared/notes
lyrica admin grants list --user li
```

The folder must be a real directory with no symlinks on its path, readable
by the `lyrica` user (through its group or an ACL for anything she should
write), and may not be in both pools. The same lists are in the control
panel under Users.

Network defaults are per user and pool: general threads start with internet
on and this machine's services off, private threads with both off. Change
them in the control panel under Network, or with `lyrica admin net`. Each
thread can narrow or widen its own from the thread settings drawer.

## Give her another computer

A **machine** is one of your other computers that she works on over SSH,
with a dedicated account there, in one pool (general or private) and with
a **mode limit** she can't exceed on it (Ask, Accept edits or Auto; new
machines start at Ask). The reference is
[docs/workspace.md](../workspace.md#machines).

```sh
lyrica admin ssh add --user li office li-lyrica@office.lan --pool general --limit ask
```

(As the `lyrica` user with `LYRICA_HOME=/var/lib/lyrica`, like the other
`admin` commands; `--root <path>` limits her reads and writes there.) It
runs in three steps:

1. She makes a key pair and prints the setup to run **as root on the
   machine**: her public key into `/etc/ssh/authorized_keys/<account>`, a
   file only root can change, with a `Match User` block in
   `/etc/ssh/sshd_config.d/lyrica.conf`, then `sshd -t && systemctl reload
   ssh`. The key line is restricted to connections from this computer. If
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

The machine needs OpenSSH 9.6 or later (strict key exchange). If its host
key ever changes, every call fails until you confirm the new key; `lyrica
admin ssh list` shows each machine's pool, limit and confirmed key, and
`ssh remove` takes one away. SSH targets added before machines existed
became general machines at Ask; one that had never connected has no
confirmed key and must be added again.

## Day to day

- **Logs:** `journalctl -u lyricad` and `journalctl -u lyrica-caddy`. One
  line per request with the route pattern and status; never message or
  memory text. Caddy's TLS errors go to `/run/lyrica-caddy/tls.log` instead
  of the journal, since a DNS plugin can quote its token in one.
- **Restart:** `systemctl restart lyricad`. On stop she ends every turn and
  sleep, unmounts home workspaces and drops keys. With no saved passphrase,
  she comes back locked; browser sessions don't survive a restart, so
  everyone logs in again.
- **Sleep** runs at `sleep.time` (04:00 local by default; the control
  panel's Server section) for every user whose key is available.
- **Where the data is:** everything is under `/var/lib/lyrica`. `self.db`
  and each `users/<id>/` directory are encrypted at rest; a copy made while
  the service is stopped is a backup, and useless without the passphrase
  and the users' passwords.
- **Upgrading:** in the checkout, as root:

  ```sh
  cd /root/lyrica && git pull
  npm ci && npm run build
  daemon/deploy/install.sh
  ```

  The script replaces `/opt/lyrica`, rebuilds Caddy only if a pin changed,
  and restarts `lyricad` (which logs everyone out).

## Checklist for the first install on Li's machine

Run these in order the first time and note where each stops. Each one is
something the code expects but nobody has confirmed on real hardware.

1. The LXC features and tun device from "In a Proxmox LXC container", then
   the proofs in [docs/workspace.md](../workspace.md#host-requirements):
   `bwrap … /bin/true` and `pasta --config-net -- true` as the `lyrica`
   user. On Ubuntu 24.04 or later, a bubblewrap "Permission denied" means
   `kernel.apparmor_restrict_unprivileged_userns=0` on the Proxmox host.
2. `install.sh` runs to the end on a fresh system. Expected soft spots: the
   Node check, `npm ci` needing `build-essential`, the Caddy build (a
   checksum mismatch stops it; the tail of its build log is printed).
3. `lyrica admin init`, `systemctl start lyricad`, unlock, login.
4. `NoNewPrivs: 0` on the running process.
5. The self-test: no "network is off for every thread" in the journal, and
   the control panel's Server section shows no network warning.
6. In a thread with a granted folder, `read` and a `bash` command work, and
   a command with internet on can reach the internet.
7. A file uploaded in a thread opens with `read` (this proves the home
   workspace mounted: gocryptfs and FUSE).
8. Save the passphrase, `systemctl restart lyricad`, and she comes back
   unlocked. If the button is disabled, note the reason it shows.
9. Web access with the built-in Caddy: the name gets a certificate, and the
   unlock page is reachable at it after a restart.

Report what fails, with the journal lines, in the Operator docs thread; the
guide gets corrected from the real run.
