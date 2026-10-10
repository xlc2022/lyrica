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
  change. It holds nothing else: never the lyricad machine (Li's memory) or
  the model host (the host-stack job installs its own model host stack).
- One runner runs one job at a time. A weekly cron job clears Docker images
  and build cache unused for a week.

## Who can run code on it

Every job runs the code of the branch it checks, with root on the VM. The
repository is private, so only people with access to it can open a pull
request; the workflows' token is read-only. The repository must stay private
while it uses this runner.

## Going back to GitHub's runners

Change `runs-on: lyrica-ci` back to `ubuntu-latest` in both workflows. The
host-images job's "Make room" step runs only there.
