# CI

For now, every workflow runs on GitHub's hosted runners (`ubuntu-latest`):
runs were queueing behind the owner's own runners, and the repository is
public, so hosted minutes cost nothing. The rest of this page describes the
self-hosted runners, which no workflow uses at the moment.
"Switching runners" below says how to move between them.

## The runner

- A dedicated Ubuntu 24.04 VM (matching GitHub's `ubuntu-latest`) with the
  label `lyrica-ci`. About 4 cores, 8 GB of memory and 150 GB of disk: the
  ROCm image build needs about 45 GB free, since Docker's containerd store
  keeps its 12 GB of compressed layers beside the 30 GB unpacked. Ubuntu's
  installer gives the root volume only part of the disk; `sudo lvextend -r
  -l +100%FREE /dev/ubuntu-vg/ubuntu-lv` gives it the rest.
- Any machine that runs the tests (the runner, a developer's, a NixOS test
  host) needs `openssl` and `bash` on its PATH; `vitest.config.ts`
  runs them in UTC.
- `.github/runner/setup.sh TOKEN`, run as root, installs Docker, a `runner`
  user with passwordless sudo, and the runner as a systemd service. TOKEN comes
  from the repository's Settings, Actions, Runners, New self-hosted runner.
- The jobs install their own packages with sudo, so the VM is theirs to
  change. needrestart only lists services (it once restarted the runner
  mid-job), and apt waits up to 10 minutes for a busy dpkg lock; setup.sh,
  the check job and the nix job all set this. The VM holds nothing else: never
  the lyricad machine (the owner's memory) or the model host (the host-stack job
  installs its own stack).
- The nix job installs Nix once (pinned installer, kept between runs), runs
  `nix flake check` and the sandbox tests with the NixOS sandbox tools and
  closure (docs/daemon.md "On NixOS"). Nix stays installed on the VM. If
  an install was cancelled partway, the job stops and names the leftover
  files; the Nix manual's multi-user uninstall steps clear it. Each run
  ends by keeping its builds as one generation of a profile
  (`~/.local/state/nix/profiles/lyrica-ci`), deleting all but the 10 newest
  and collecting garbage; `keep-outputs` in `/etc/nix/nix.conf` keeps what
  those 10 were built from, so the next run still finds them cached.
- Leftovers: a cancelled job can leave its test servers, browsers and
  sandbox helpers running, and enough of them use up the runner user's
  threads, so Chromium fails to start (`pthread_create: Resource
  temporarily unavailable`, `spawn EAGAIN`). The check, nix and host-stack
  jobs start with `.github/runner/clear-leftovers.sh`, which stops the
  runner user's processes of those kinds whose parent is init or the
  user's systemd (the running job's descend from the runner), with
  everything under them, and logs the user's thread count before and after.
- The host-stack job removes what it installed (the stack and its volumes,
  the egress and updater units and rules, the updater's folders and deploy
  key, Docker's daemon.json) when it ends.
- Runner speed: the runners sit on three machines of different speed. On
  them, the `check` job (unit tests and e2e) needs the extra label `lyrica-fast` and
  so runs only on the faster machines; it timed out and flaked on the slowest
  (4 cores), where it took twice as long. The other jobs run on any runner.
  Give a runner the label with `--labels lyrica-ci,lyrica-fast` when
  registering it, or add it in Settings, Actions, Runners. With no runner
  carrying `lyrica-fast`, `check` waits in the queue.
- One runner runs one job at a time. A new push to a pull request
  cancels its older runs. Main runs its newest merge only: a main run
  still waiting for a runner gives way to the next merge, and one already
  running finishes. A first `changes` job reads the diff (on main, from
  the last commit whose run passed, so merges that gave way are covered)
  and runs only the jobs it touches; the others show as skipped, which
  counts as passed:
  - check: anything but `docs/` and the top-level Markdown files.
    `persona/` is her seed, so it counts.
  - nix: the same, less `evals/` and the tests the flake leaves out of its
    source (`web/e2e/` and each `test/` but `core/test/`, which holds the
    sandbox tests).
  - host-stack: `host/` only.

  A change under `.github/`, or a diff that can't be read, runs all three.
  The e2e tests run seven Playwright projects side by side, each against
  its own lyricad: each `web/e2e/web-*.spec.ts` file (chat, projects,
  admin) at phone and at desktop size, and the setup page. The slowest
  project sets the step's time. A weekly cron job clears Docker images and
  build cache unused for a week.
- The host image jobs first check for room (`.github/runner/make-room.sh`):
  45 GB free for the ROCm build, 40 for ComfyUI's CUDA build, 30 for the
  speech server's. Short of that, they clear Docker's build cache and unused
  images, and fail naming the free space if that isn't enough. After a
  ComfyUI build they clear the build cache and its base image again, so the
  runner's other jobs keep their room.

## Where it sits on the network

Every job, and every package a job installs, runs as root on the VM, and the
machines beside it hold the owner's memory and the model host. So the VM reaches the
internet and nothing else:

- setup.sh installs `lyrica-ci-firewall`, an nftables table applied at boot
  before the runner starts. On the uplink it rejects 10.0.0.0/8,
  172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 and fc00::/7,
  except DNS to the configured resolvers and DHCP. Replies to connections
  opened to the VM, such as SSH from the LAN, still go out. Docker's own bridges are
  other interfaces, so the jobs' containers still reach each other.
- A job has root and could remove that table, so the same rules on the
  hypervisor (Proxmox's firewall for the VM) or a separate VLAN are stronger.
- The VM never joins the tailnet.

## Who can run code on it

Every job runs the code of the branch it checks, with root on the VM, and
the workflows' token is read-only. The repository is public, so anyone can
open a pull request from a fork, and a pull request's run uses the
workflow files from its own branch: a fork can name `lyrica-ci` in any
workflow, whatever `main`'s workflows say. So the boundary is a repository
setting, not the workflows: Settings, Actions, General, "Approval for
running fork pull request workflows from contributors" set to "Require
approval for all external contributors", and whoever approves a run reads
its changes under `.github/` first. An approved run can still name the
runners in its own copy of a workflow, and a personal repository has no
runner groups to restrict them, so while the repository is public and no
workflow uses them, remove them from it (Settings, Actions, Runners). In
Settings, Actions, General, keep "Workflow permissions" at "Read repository
contents" and "Allow GitHub Actions to create and approve pull requests"
off. No workflow uses `pull_request_target`.

## Switching runners

Only with the approval setting above in place: to move a workflow back to
the self-hosted runners, set each job's `runs-on` to `lyrica-ci`, and the
`check` job's to `[lyrica-ci, lyrica-fast]`. To move one to GitHub's
runners, set them to `ubuntu-latest`. On a hosted runner the "Stop what
earlier jobs left running" step finds nothing, and the nix job installs Nix
on every run. Claude Code is unfree, so no binary cache has it, and its
download answers 429 when every run fetches it: the nix job keeps the file
in the Actions cache, keyed by `flake.lock`, and adds it to the store
before the build (`.github/runner/seed-claude-code.sh`). The host-images jobs pick their "Make room" step by where they
run.
