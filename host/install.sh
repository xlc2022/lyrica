#!/usr/bin/env bash
# Installs or upgrades the Lyrica model host on this machine.
# Run it again at any time (after `git pull`, or to change a setting): it keeps
# .env's values as defaults, rebuilds and restarts the stack in place.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Usage: host/install.sh [options]
  --name NAME          This host's name, shown in Lyrica (default: lyrica-<hostname>)
  --lan ADDRESS        The LAN address to publish host-api on (default: detected)
  --no-lan             Don't publish on the LAN (Tailscale only)
  --models DIR         The models folder (default: /srv/models)
  --vendor nvidia|amd  The GPU vendor (default: detected)
  --tailscale NAME     Also join the tailnet as device NAME (asks for an auth key)
  --no-tailscale       Leave the tailnet
  --no-gpu             Skip the GPU checks (for testing the stack without a GPU)
  --yes                Don't ask questions; use defaults and flags
  --no-start           Write .env only
EOF
}

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "question" default
  local answer
  if [[ $YES == 1 ]]; then printf -v "$1" '%s' "$3"; return; fi
  read -r -p "$2 [$3]: " answer
  printf -v "$1" '%s' "${answer:-$3}"
}

# Defaults from an existing .env, so running again keeps the settings.
env_value() { [[ -f .env ]] && sed -n "s/^$1=//p" .env | tail -n 1 || true; }
NAME=$(env_value HOST_NAME)
LAN=$(env_value LAN_ADDRESS)
MODELS=$(env_value MODELS_DIR)
VENDOR=$(env_value GPU_VENDOR)
TS_HOSTNAME=$(env_value TS_HOSTNAME)
TS_AUTHKEY=$(env_value TS_AUTHKEY)
WANT_LAN=1
[[ -f .env && -z $LAN ]] && WANT_LAN=0
YES=0 START=1 CHECK_GPU=1

while [[ $# -gt 0 ]]; do
  case $1 in
    --name) NAME=$2; shift ;;
    --lan) LAN=$2; WANT_LAN=1; shift ;;
    --no-lan) WANT_LAN=0; LAN= ;;
    --models) MODELS=$2; shift ;;
    --vendor) VENDOR=$2; shift ;;
    --tailscale) TS_HOSTNAME=$2; shift ;;
    --no-tailscale) TS_HOSTNAME= TS_AUTHKEY= ;;
    --no-gpu) CHECK_GPU=0; VENDOR=none ;;
    --yes) YES=1 ;;
    --no-start) START=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

[[ $(uname -s) == Linux ]] || fail "the model host runs on Linux only."

# The container engine: Docker, or Podman with a compose provider.
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); ENGINE=docker
elif podman compose version >/dev/null 2>&1; then COMPOSE=(podman compose); ENGINE=podman
else fail "install Docker (with the compose plugin) or Podman with podman-compose first."
fi

# The GPU, its driver, and the container engine's GPU support.
if [[ $CHECK_GPU == 1 ]]; then
  if [[ -z $VENDOR || $VENDOR == none ]]; then
    if command -v nvidia-smi >/dev/null; then VENDOR=nvidia
    elif [[ -e /dev/kfd ]]; then VENDOR=amd
    else fail "no NVIDIA or AMD GPU found (no nvidia-smi, no /dev/kfd). Install the GPU driver first."
    fi
  fi
  case $VENDOR in
    nvidia)
      nvidia-smi -L >/dev/null 2>&1 || fail "nvidia-smi can't talk to the driver. Install or fix the NVIDIA driver."
      if [[ $ENGINE == docker ]]; then
        docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia || ls /etc/cdi/nvidia*.yaml /var/run/cdi/nvidia*.yaml >/dev/null 2>&1 ||
          fail "Docker has no NVIDIA support. Install nvidia-container-toolkit and run: sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker"
      else
        ls /etc/cdi/nvidia*.yaml /var/run/cdi/nvidia*.yaml >/dev/null 2>&1 ||
          fail "Podman needs NVIDIA's CDI spec. Install nvidia-container-toolkit and run: sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml"
      fi
      say "GPUs: $(nvidia-smi --query-gpu=name --format=csv,noheader | paste -sd, -)" ;;
    amd)
      [[ -e /dev/kfd ]] && compgen -G '/dev/dri/renderD*' >/dev/null || fail "no /dev/kfd or /dev/dri/renderD*: install the amdgpu driver (ROCm)."
      lsmod | grep -q '^amdgpu' || fail "the amdgpu kernel module isn't loaded." ;;
    *) fail "--vendor must be nvidia or amd." ;;
  esac
fi

# Settings.
[[ -n $NAME ]] || NAME="lyrica-$(hostname -s | tr '[:upper:]' '[:lower:]')"
ask NAME "Host name" "$NAME"
[[ $NAME =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail "the name must be lower-case letters, digits and dashes."

if [[ $WANT_LAN == 1 ]]; then
  [[ -n $LAN ]] || LAN=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  ask LAN "LAN address to publish host-api on" "${LAN:-}"
  [[ -n $LAN && $LAN != 0.0.0.0 && $LAN != "::" ]] || fail "give a LAN address (--lan), never every interface."
  [[ $LAN =~ ^127\. ]] && fail "a loopback address isn't a LAN address. The dashboard is always on 127.0.0.1:7236."
  ip -o addr show 2>/dev/null | grep -qw "inet ${LAN}" || ip -o addr show 2>/dev/null | grep -q "inet6 ${LAN}/" ||
    fail "$LAN isn't an address of this machine."
fi

[[ -n $MODELS ]] || MODELS=/srv/models
ask MODELS "Models folder" "$MODELS"
[[ -d $MODELS ]] || fail "$MODELS doesn't exist. Create it, or give another with --models."
MODELS=$(cd "$MODELS" && pwd -P)

if [[ -n $TS_HOSTNAME && -z $TS_AUTHKEY && $YES == 0 && ! -f .tailscale-joined ]]; then
  read -r -s -p "Tailscale auth key for $TS_HOSTNAME (from the admin console; used once): " TS_AUTHKEY
  echo
fi
[[ $WANT_LAN == 1 || -n $TS_HOSTNAME ]] || fail "with --no-lan, use --tailscale: otherwise nothing can reach the host."

FILES=compose.yaml
[[ $WANT_LAN == 1 ]] && FILES+=:compose.lan.yaml
[[ -n $TS_HOSTNAME ]] && FILES+=:compose.tailscale.yaml
VERSION=$(git describe --always --dirty 2>/dev/null || echo dev)

umask 077
cat > .env <<EOF
# Written by install.sh. Edit, then run install.sh again to apply.
HOST_NAME=$NAME
LAN_ADDRESS=$LAN
MODELS_DIR=$MODELS
GPU_VENDOR=$VENDOR
COMPOSE_PROFILES=$VENDOR
COMPOSE_FILE=$FILES
HOST_VERSION=$VERSION
TS_HOSTNAME=$TS_HOSTNAME
TS_AUTHKEY=$TS_AUTHKEY
EOF
say "Wrote host/.env."
[[ $START == 1 ]] || exit 0

"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d --remove-orphans

# Once Tailscale has joined, the auth key isn't needed: drop it from .env.
if [[ -n $TS_HOSTNAME && -n $TS_AUTHKEY ]]; then
  for _ in $(seq 60); do
    "${COMPOSE[@]}" exec -T tailscale tailscale status >/dev/null 2>&1 && break
    sleep 2
  done
  sed -i 's/^TS_AUTHKEY=.*/TS_AUTHKEY=/' .env
  touch .tailscale-joined
fi

for _ in $(seq 30); do
  ME=$(curl -fsS http://127.0.0.1:7236/dashboard/me 2>/dev/null) && break
  sleep 1
done
[[ -n ${ME:-} ]] || fail "host-api didn't start. See: ${COMPOSE[*]} logs host-api"

if [[ $ME == *'"passwordSet":false'* && $YES == 0 ]]; then
  say "Set a dashboard password, for opening it from another machine (Enter to skip)."
  read -r -s -p "Password (10 or more characters): " PASSWORD
  echo
  if [[ -n $PASSWORD ]]; then
    ESCAPED=${PASSWORD//\\/\\\\}
    ESCAPED=${ESCAPED//\"/\\\"}
    printf '{"password":"%s"}' "$ESCAPED" |
      curl -fsS -X POST -H 'content-type: application/json' --data @- http://127.0.0.1:7236/dashboard/password >/dev/null ||
      say "Couldn't set it; set it on the dashboard instead."
  fi
fi

FINGERPRINT=$(printf '%s' "$ME" | sed -n 's/.*"fingerprint":"\([0-9a-f]*\)".*/\1/p')
say ""
say "The model host is running."
say "  Dashboard here:   http://127.0.0.1:7236"
[[ $WANT_LAN == 1 ]] && say "  From the LAN:     https://$LAN:7236"
[[ -n $TS_HOSTNAME ]] && say "  Over Tailscale:   https://$TS_HOSTNAME.<your tailnet>.ts.net"
say "  Key fingerprint:  $FINGERPRINT"
say "To pair, open the dashboard, choose Pair with Lyrica, and paste the code into Lyrica's Add model host."
