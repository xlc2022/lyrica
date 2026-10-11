# CI

The checks in `.github/workflows/` run on Li's own GitHub Actions runner, not
on GitHub's hosted runners: a self-hosted runner costs nothing, while hosted
minutes on a private repository are billed past the plan's allowance.

## The runner

- A dedicated Ubuntu 24.04 VM (matching GitHub's `ubuntu-latest`) with the
  label `lyrica-ci`. About 4 cores, 8 GB of memory and 150 GB of disk: the
  ROCm image build needs over 30 GB.
- `.github/runner/setup.sh TOKEN`, run as root, installs Docker, a `runner`
  user with passwordless sudo, and the runner as a systemd service. TOKEN comes
  from the repository's Settings, Actions, Runners, New self-hosted runner.
- The jobs install their own packages with sudo, so the VM is theirs to
  change. needrestart only lists services (it once restarted the runner
  mid-job), and apt waits up to 10 minutes for a busy dpkg lock; setup.sh
  and the check job both set this. It holds nothing else: never the lyricad machine (Li's memory) or
  the model host (the host-stack job installs its own model host stack).
- The nix job installs Nix once (pinned installer, kept between runs), runs
  `nix flake check` and the sandbox tests with the NixOS sandbox tools and
  closure (docs/daemon.md "On NixOS"). Nix stays installed on the VM. If
  an install was cancelled partway, the job stops and names the leftover
  files; the Nix manual's multi-user uninstall steps clear it.
- The host-stack job removes what it installed (the stack and its volumes,
  the egress unit and rules, Docker's daemon.json) when it ends.
- One runner runs one job at a time. A new push to a pull request
  cancels its older runs; every commit on main gets a full run. A weekly cron job clears Docker images
  and build cache unused for a week.

## Where it sits on the network

Every job, and every package a job installs, runs as root on the VM, and the
machines beside it hold Li's memory and the model host. So the VM reaches the
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

Every job runs the code of the branch it checks, with root on the VM. The
repository is private, so only people with access to it can open a pull
request; the workflows' token is read-only. The repository must stay private
while it uses this runner.

## Going back to GitHub's runners

Change `runs-on: lyrica-ci` back to `ubuntu-latest` in both workflows. The
host-images job's "Make room" step runs only there.
