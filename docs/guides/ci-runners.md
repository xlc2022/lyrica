# CI runners: adding a machine that runs the checks

The checks in `.github/workflows/` run on your own GitHub Actions runners,
labelled `lyrica-ci`, not on GitHub's hosted runners. This guide follows
`.github/runner/setup.sh`; why it is set up this way, and what the runner
may and may not reach, is in [docs/ci.md](../ci.md).

Unlike the other guides, this one has been exercised: two runner VMs were
set up with the script on 2026-10-11, and every pull request and push to
`main` runs on them since PR #68.

## The machine

- A dedicated **Ubuntu 24.04** VM that holds nothing else. The script warns
  on anything but Ubuntu. Keep every runner on 24.04; move the pool to a
  newer release all at once, after trying one VM under a label of its own.
- **x86-64.** The script accepts arm64, but the model host's images and
  pinned wheels are x86 only, so an ARM runner could run only the `check`
  job and would need a label of its own.
- About 4 cores, 8 GB of memory and 150 GB of disk: the ROCm image build
  needs about 45 GB free. Ubuntu's installer gives the root volume only
  part of the disk, so give it the rest before running the script:
  `sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv`. `df -h /`
  should then show nearly the whole disk.
- A **unique hostname**: it becomes the runner's name on GitHub. A clone of
  a prepared VM must get a new hostname before the script runs.
- Internet access. The script's firewall keeps it from reaching anything
  on the LAN or the tailnet; it never joins the tailnet.

Every job runs as root-equivalent on the VM (an ordinary user with
passwordless sudo and Docker), with the code of whatever branch it checks.
That is why the VM is dedicated, sits behind its own firewall, and why the
repository must stay private while it uses these runners.

## Set up a runner

1. On GitHub, open the repository's Settings, Actions, Runners, **New
   self-hosted runner**, and copy the registration token. It is valid for
   an hour and used once.
2. On the VM, as root, from a copy of the script (a checkout, or the copy
   kept in the project's files):

   ```sh
   sudo bash .github/runner/setup.sh TOKEN
   ```

   With no token on the command line it asks for one at a hidden prompt.

The script, in order:

1. Installs what the jobs expect to find: `build-essential`, curl, git,
   jq, python3, iptables, and Ubuntu's Docker with the compose and buildx
   plugins. The jobs install the rest themselves with sudo, as they do on
   GitHub's runners. It also tells needrestart to only list services (it
   once restarted the runner mid-job) and apt to wait up to ten minutes for
   a busy dpkg lock; the check job writes the same two settings, so runners
   set up before 2026-10-11 need nothing.
2. Creates the `runner` user with passwordless sudo and Docker access.
3. Downloads the latest GitHub Actions runner, checked against the
   checksum in its release notes, into `/home/runner/actions-runner`. It
   updates itself after that.
4. Registers it with the repository under the name of the VM's hostname
   and the label `lyrica-ci`, and installs it as a systemd service.
5. Installs `lyrica-ci-firewall`: an nftables table applied at boot before
   the runner starts, which lets the VM reach the internet, its DHCP
   resolvers on port 53 and DHCP, and rejects any new connection to a
   private, link-local or tailnet address. Connections opened to the VM,
   such as your SSH session, still get their replies.
6. Starts the runner, and adds a weekly cron job that prunes Docker images
   and build cache unused for a week.

It ends with "Done", and the runner shows as Idle under Settings, Actions,
Runners within a minute. Running the script again is safe: a registered
runner keeps its registration, and the firewall is applied again.

## Day to day

- **A queued job** means every runner is busy or offline. One runner runs
  one job at a time; a newer push to a pull request cancels its older
  runs, and every commit on `main` gets a full run.
- **Out of disk:** the host image jobs check for room first (45 GB free
  for ROCm, 40 for ComfyUI's CUDA build, 30 for speech), clear Docker's
  cache if short, and fail naming the free space if that isn't enough.
  Grow the VM's disk, then the volume as above.
- **Logs:** `journalctl -u 'actions.runner.*'` on the VM, and the job's own
  log on GitHub.
- **Locked out of the VM** by the firewall (it should never block SSH from
  the LAN, since replies to connections opened to the VM pass): from the
  hypervisor's console,

  ```sh
  sudo nft delete table inet lyrica_ci
  ```

  removes the table until the next boot or `systemctl restart
  lyrica-ci-firewall`.
- **The nix job** installs Nix on the runner the first time (a pinned
  installer, checked by hash) and keeps it; it needs the internet for
  `releases.nixos.org`, `channels.nixos.org` and `cache.nixos.org`, which
  the firewall allows like the rest of the internet. Its store does not
  grow without bound: each run ends by keeping its builds as one generation
  of a Nix profile, deleting all but the ten newest and collecting garbage,
  so the disk settles at about ten runs' worth. If that first install
  was cancelled partway (a cancelled run, a rebooted VM), later nix jobs
  stop with "An earlier Nix install on this runner stopped partway" and
  list the `/etc/*.backup-before-nix` files it left. Undo it by hand with
  the Nix manual's multi-user uninstall steps on the VM: put those backup
  files back in place, remove `/nix` and `/etc/nix`, the `nix-daemon`
  units and the `nixbld` users, then re-run the job.
- **The host-stack job** installs the model host stack with `--no-gpu` and
  removes it again when it ends (the stack, its volumes, the egress unit
  and rules, Docker's `daemon.json`).
- **More runners:** another VM from the same base image, a new hostname, a
  fresh token, the same script. There is no shared state between runners.
- **Removing a runner:** on the VM, `cd /home/runner/actions-runner &&
  sudo ./svc.sh stop && sudo ./svc.sh uninstall`, then `sudo -u runner
  ./config.sh remove --token <a removal token from the Runners page>`; or
  delete it on the Runners page and discard the VM.
- **Going back to GitHub's runners:** change `runs-on: lyrica-ci` to
  `ubuntu-latest` in both workflows. Hosted minutes on a private repository
  are billed past the plan's allowance, which is why these exist.
