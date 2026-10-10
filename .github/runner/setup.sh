#!/usr/bin/env bash
# Makes this machine Lyrica's CI runner: a GitHub Actions self-hosted runner
# labelled lyrica-ci, running as a systemd service (see docs/ci.md).
#
# Run it as root on a fresh Ubuntu 24.04 VM that holds nothing else:
#   sudo bash setup.sh TOKEN
# TOKEN is the one shown on
# https://github.com/xlc2022/lyrica/settings/actions/runners/new (valid for an
# hour). Running it again is safe: a configured runner keeps its registration.
set -euo pipefail
REPO=xlc2022/lyrica
LABEL=lyrica-ci
RUNNER_USER=runner
DIR=/home/$RUNNER_USER/actions-runner

fail() { printf 'setup.sh: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || fail "run it as root (sudo bash setup.sh TOKEN)."
. /etc/os-release
[[ $ID == ubuntu ]] || echo "Warning: CI expects Ubuntu 24.04, like GitHub's ubuntu-latest; this is $PRETTY_NAME."
case $(uname -m) in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) fail "unsupported architecture $(uname -m)." ;;
esac

# What the jobs expect to find. They install the rest themselves with sudo,
# as they do on GitHub's runners.
apt-get update
apt-get install -y curl git jq python3 iptables docker.io docker-compose-v2 docker-buildx

# The jobs run as an ordinary user with passwordless sudo and Docker, as on
# GitHub's runners: the sandbox tests refuse to run as root, and the model
# host's install needs sudo. This makes the VM the jobs' to change, which is
# why it holds nothing else.
id -u "$RUNNER_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$RUNNER_USER"
usermod -aG docker "$RUNNER_USER"
echo "$RUNNER_USER ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/$RUNNER_USER
chmod 440 /etc/sudoers.d/$RUNNER_USER

# The runner, checked against the hash in its release notes. It updates itself after this.
if [[ ! -x $DIR/config.sh ]]; then
  release=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)
  version=$(jq -r .tag_name <<<"$release")
  version=${version#v}
  sha=$(jq -r .body <<<"$release" | sed -n "s/.*BEGIN SHA linux-$ARCH -->\([0-9a-f]\{64\}\)<.*/\1/p")
  [[ -n $sha ]] || fail "couldn't find the runner's checksum in release $version."
  tarball=actions-runner-linux-$ARCH-$version.tar.gz
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$tarball" "https://github.com/actions/runner/releases/download/v$version/$tarball"
  echo "$sha  $tmp/$tarball" | sha256sum -c -
  install -d -o "$RUNNER_USER" -g "$RUNNER_USER" "$DIR"
  sudo -u "$RUNNER_USER" tar xzf "$tmp/$tarball" -C "$DIR"
  rm -rf "$tmp"
fi
cd "$DIR"
./bin/installdependencies.sh

if [[ ! -f .runner ]]; then
  TOKEN=${1:-}
  [[ -n $TOKEN ]] || { read -r -s -p "Registration token: " TOKEN; echo; }
  sudo -u "$RUNNER_USER" ./config.sh --unattended --replace \
    --url "https://github.com/$REPO" --token "$TOKEN" \
    --name "$(hostname -s)" --labels "$LABEL"
fi
[[ -f .service ]] || ./svc.sh install "$RUNNER_USER"
./svc.sh start

# Image builds and old stacks pile up: clear what no job has used for a week.
cat >/etc/cron.weekly/lyrica-ci-prune <<'PRUNE'
#!/bin/sh
docker system prune -af --filter until=168h >/dev/null
docker builder prune -af --filter until=168h >/dev/null
PRUNE
chmod 755 /etc/cron.weekly/lyrica-ci-prune

echo "Done. The runner should show as Idle on https://github.com/$REPO/settings/actions/runners"
