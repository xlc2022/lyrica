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
  --amd-backend rocm|vulkan
                       AMD only: ROCm (llama.cpp, vLLM and images) or Vulkan
                       (llama.cpp only, for GPUs ROCm doesn't support, such as
                       Vega or the Radeon 780M). Default: ROCm if it supports
                       every GPU, else Vulkan
  --hsa-override VER   AMD with ROCm only: run the GPU as a close one ROCm
                       supports, e.g. 11.0.0 for a 780M. "none" to clear
  --tailscale NAME     Also join the tailnet as device NAME (asks for an auth key)
  --no-tailscale       Leave the tailnet
  --no-gpu             No GPU and no model servers: host-api alone (for testing)
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
EDGE_SUBNET=$(env_value EDGE_SUBNET)
HOST_API_IP=$(env_value HOST_API_IP)
LAN_GIVEN=0
MODELS=$(env_value MODELS_DIR)
VENDOR=$(env_value GPU_VENDOR)
AMD_BACKEND=$(env_value GPU_BACKEND)
HSA_OVERRIDE=$(env_value HSA_OVERRIDE_GFX_VERSION)
AMD_FLAGS=0 APU_ONLY=0 DISCRETE_SUPPORTED=0
NVIDIA_CDI=0
COMFY_GPU=$(env_value COMFY_GPU)
TS_HOSTNAME=$(env_value TS_HOSTNAME)
TS_AUTHKEY=$(env_value TS_AUTHKEY)
WANT_LAN=1
[[ -f .env && -z $LAN ]] && WANT_LAN=0
YES=0 START=1 CHECK_GPU=1

while [[ $# -gt 0 ]]; do
  case $1 in
    --name) NAME=$2; shift ;;
    --lan) LAN=$2; WANT_LAN=1; LAN_GIVEN=1; shift ;;
    --no-lan) WANT_LAN=0; LAN= ;;
    --models) MODELS=$2; shift ;;
    --vendor) VENDOR=$2; shift ;;
    --amd-backend) AMD_BACKEND=$2; AMD_FLAGS=1; shift ;;
    --hsa-override) HSA_OVERRIDE=$2; AMD_FLAGS=1; [[ $HSA_OVERRIDE == none ]] && HSA_OVERRIDE=; shift ;;
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

# The container engine: Docker, with its iptables firewall backend.
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose)
elif podman compose version >/dev/null 2>&1; then
  fail "Podman isn't supported yet: host-api's egress rules need Docker's DOCKER-USER chain. Install Docker with the compose plugin."
else fail "install Docker (with the compose plugin) first."
fi

# The gfx targets the llama.cpp ROCm image is built for (its
# .devops/rocm.Dockerfile at the pinned build). vLLM's and ComfyUI's ROCm
# images cover no more than these.
ROCM_TARGETS=" gfx908 gfx90a gfx942 gfx1030 gfx1100 gfx1101 gfx1102 gfx1150 gfx1151 gfx1200 gfx1201 "
# Integrated GPUs (as in host/src/gpus.ts). With a discrete GPU beside them,
# host-api leaves them out by default, so they don't decide ROCm or Vulkan.
APU_TARGETS=" gfx902 gfx909 gfx90c gfx1033 gfx1035 gfx1036 gfx1037 gfx1103 gfx1150 gfx1151 gfx1152 gfx1153 "

# Each AMD GPU's gfx target, from the KFD topology (gfx_target_version 110003 is gfx1103).
amd_targets() {
  local f v
  for f in /sys/class/kfd/kfd/topology/nodes/*/properties; do
    v=$(awk '$1 == "gfx_target_version" { print $2 }' "$f" 2>/dev/null)
    [[ -n $v && $v != 0 ]] || continue
    printf 'gfx%d%x%x\n' $((v / 10000)) $((v / 100 % 100)) $((v % 100))
  done
}

# ROCm or Vulkan: ROCm when it supports every GPU (or an override is set),
# else Vulkan, which runs llama.cpp on any of them.
choose_amd_backend() {
  local targets unsupported=() t discrete=0
  targets=$(amd_targets)
  for t in $targets; do
    [[ $APU_TARGETS == *" $t "* ]] && continue
    discrete=1
    [[ $ROCM_TARGETS == *" $t "* ]] && DISCRETE_SUPPORTED=1
  done
  [[ -n $targets && $discrete == 0 ]] && APU_ONLY=1
  for t in $targets; do
    [[ $ROCM_TARGETS == *" $t "* ]] && continue
    [[ $discrete == 1 && $APU_TARGETS == *" $t "* ]] && { say "The integrated $t is left out by default (it can be included on the dashboard)."; continue; }
    unsupported+=("$t")
  done
  [[ -n $targets ]] && say "AMD GPUs: $(paste -sd, - <<<"$targets")"
  if [[ -z $AMD_BACKEND ]]; then
    if [[ ! -e /dev/kfd ]]; then AMD_BACKEND=vulkan; say "No /dev/kfd (no ROCm kernel support): using Vulkan."
    elif [[ ${#unsupported[@]} -eq 0 || -n $HSA_OVERRIDE ]]; then AMD_BACKEND=rocm
    else
      AMD_BACKEND=vulkan
      say "ROCm doesn't support ${unsupported[*]}: using Vulkan, which serves llama.cpp models only (no vLLM, no images)."
      [[ " ${unsupported[*]} " == *" gfx1103 "* ]] && say "  A 780M (gfx1103) may run ROCm as gfx1100: install.sh --amd-backend rocm --hsa-override 11.0.0"
      [[ ${#unsupported[@]} -lt $(wc -w <<<"$targets") ]] && say "  For ROCm on the supported GPUs only: install.sh --amd-backend rocm, then leave the others out on the dashboard."
    fi
  fi
  case $AMD_BACKEND in
    rocm) [[ -e /dev/kfd ]] || fail "ROCm needs /dev/kfd: install the amdgpu driver with ROCm support, or use --amd-backend vulkan." ;;
    vulkan) [[ -z $HSA_OVERRIDE ]] || { say "--hsa-override is for ROCm; ignoring it with Vulkan."; HSA_OVERRIDE=; } ;;
    *) fail "--amd-backend must be rocm or vulkan." ;;
  esac
  [[ -z $HSA_OVERRIDE || $HSA_OVERRIDE =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "--hsa-override looks like 11.0.0."
  [[ -n $HSA_OVERRIDE && $DISCRETE_SUPPORTED == 1 ]] &&
    say "Warning: the override applies to every GPU, including the discrete GPU ROCm already supports, which it may break. Leave it unset unless every GPU needs it."
  say "AMD backend: $AMD_BACKEND${HSA_OVERRIDE:+ (HSA_OVERRIDE_GFX_VERSION=$HSA_OVERRIDE)}"
}

# The GPU, its driver, and the container engine's GPU support.
if [[ $CHECK_GPU == 1 ]]; then
  if [[ -z $VENDOR || $VENDOR == none ]]; then
    if command -v nvidia-smi >/dev/null; then VENDOR=nvidia
    elif [[ -e /dev/kfd ]] || lsmod | grep '^amdgpu' >/dev/null; then VENDOR=amd
    else fail "no NVIDIA or AMD GPU found (no nvidia-smi, no amdgpu driver). Install the GPU driver first."
    fi
  fi
  case $VENDOR in
    nvidia)
      nvidia-smi -L >/dev/null 2>&1 || fail "nvidia-smi can't talk to the driver. Install or fix the NVIDIA driver."
      # Docker's nvidia runtime, or else the toolkit's CDI devices (NixOS).
      if ! docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
        compgen -G '/etc/cdi/nvidia*' >/dev/null || compgen -G '/var/run/cdi/nvidia*' >/dev/null ||
          fail "Docker has no NVIDIA support. Install nvidia-container-toolkit and run: sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker"
        NVIDIA_CDI=1
      fi
      say "GPUs: $(nvidia-smi --query-gpu=name --format=csv,noheader | paste -sd, -)" ;;
    amd)
      compgen -G '/dev/dri/renderD*' >/dev/null || fail "no /dev/dri/renderD*: install the amdgpu driver."
      lsmod | grep '^amdgpu' >/dev/null || fail "the amdgpu kernel module isn't loaded."
      choose_amd_backend ;;
    *) fail "--vendor must be nvidia or amd." ;;
  esac
fi

# Settings.
[[ -n $NAME ]] || NAME="lyrica-$(hostname -s | tr '[:upper:]' '[:lower:]')"
ask NAME "Host name" "$NAME"
[[ $NAME =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail "the name must be lower-case letters, digits and dashes."

# A private, ULA or CGNAT (tailnet) address: what "the LAN" can mean.
private() {
  [[ $1 =~ ^10\. || $1 =~ ^192\.168\. || $1 =~ ^172\.(1[6-9]|2[0-9]|3[01])\. || $1 =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. || ${1,,} =~ ^f[cd][0-9a-f]{2}: ]]
}

if [[ $WANT_LAN == 1 ]]; then
  if [[ -z $LAN ]]; then
    LAN=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
    # Docker's published ports skip the firewall, so a guess must be private.
    private "${LAN:-}" || LAN=
  fi
  ask LAN "LAN address to publish host-api on" "${LAN:-}"
  [[ $LAN_GIVEN == 1 || $YES == 0 ]] || private "$LAN" || fail "$LAN isn't a private address. Give it with --lan if you mean it."
  [[ -n $LAN && $LAN != 0.0.0.0 && $LAN != "::" ]] || fail "give a LAN address (--lan), never every interface."
  [[ $LAN =~ ^127\. ]] && fail "a loopback address isn't a LAN address. The dashboard is always on 127.0.0.1:7236."
  # grep -q stops reading early; under pipefail the writer's SIGPIPE would fail the check on a busy machine.
  ip -o addr show 2>/dev/null | grep -w "inet ${LAN}" >/dev/null || ip -o addr show 2>/dev/null | grep "inet6 ${LAN}/" >/dev/null ||
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
if [[ $VENDOR != amd ]]; then
  [[ $AMD_FLAGS == 0 ]] || fail "--amd-backend and --hsa-override are for AMD GPUs only."
  AMD_BACKEND= HSA_OVERRIDE=
fi
# An APU alone on ROCm: llama.cpp uses unified memory to reach the shared memory.
UNIFIED=
[[ $VENDOR == amd && $AMD_BACKEND == rocm && $APU_ONLY == 1 ]] && UNIFIED=1
[[ $VENDOR == nvidia ]] && FILES+=:compose.nvidia.yaml
[[ $VENDOR == nvidia && $NVIDIA_CDI == 1 ]] && FILES+=:compose.cdi.yaml
[[ $VENDOR == amd && $AMD_BACKEND == vulkan ]] && FILES+=:compose.vulkan.yaml
[[ $VENDOR == amd && $AMD_BACKEND != vulkan ]] && FILES+=:compose.amd.yaml
[[ -n $HSA_OVERRIDE ]] && FILES+=:compose.hsa.yaml
[[ -n $UNIFIED ]] && FILES+=:compose.apu.yaml
RENDER_GID=$(getent group render 2>/dev/null | cut -d: -f3 || true)
[[ $WANT_LAN == 1 ]] && FILES+=:compose.lan.yaml
[[ -n $TS_HOSTNAME ]] && FILES+=:compose.tailscale.yaml
VERSION=$(git describe --always --dirty 2>/dev/null || echo dev)
LAN_BIND=$LAN
[[ $LAN == *:* ]] && LAN_BIND="[$LAN]"

# host-api's own bridge, alone on it, at a fixed address the egress rules name.
if [[ -z $EDGE_SUBNET ]]; then
  for net in 172.31.236 10.236.236 192.168.236; do
    ip route 2>/dev/null | grep -q "^$net\." && continue
    EDGE_SUBNET=$net.0/29 HOST_API_IP=$net.2
    break
  done
  [[ -n $EDGE_SUBNET ]] || fail "no free subnet for host-api's bridge; set EDGE_SUBNET and HOST_API_IP in host/.env."
fi

umask 077
cat > .env <<EOF
# Written by install.sh. Edit, then run install.sh again to apply.
HOST_NAME=$NAME
LAN_ADDRESS=$LAN
LAN_BIND=$LAN_BIND
EDGE_SUBNET=$EDGE_SUBNET
HOST_API_IP=$HOST_API_IP
MODELS_DIR=$MODELS
GPU_VENDOR=$VENDOR
GPU_BACKEND=$AMD_BACKEND
HSA_OVERRIDE_GFX_VERSION=$HSA_OVERRIDE
LLAMA_UNIFIED_MEMORY=$UNIFIED
COMFY_GPU=${COMFY_GPU:-0}
RENDER_GID=${RENDER_GID:-}
COMPOSE_FILE=$FILES
HOST_VERSION=$VERSION
TS_HOSTNAME=$TS_HOSTNAME
TS_AUTHKEY=$TS_AUTHKEY
EOF
say "Wrote host/.env."
[[ $START == 1 ]] || exit 0

SUDO=()
[[ $(id -u) == 0 ]] || SUDO=(sudo)

# host-api may start no connection: apply the rules before it starts, and keep
# them across reboots and Docker restarts with a systemd unit.
command -v iptables >/dev/null || fail "iptables is needed to keep host-api without a route out."
[[ $(docker info --format '{{.FirewallBackend.Driver}}' 2>/dev/null) == nftables ]] &&
  fail "Docker uses its nftables firewall backend, which egress.sh doesn't support yet. Use the iptables backend."
"${SUDO[@]}" ./egress.sh apply "$HOST_API_IP"
if [[ -e /etc/NIXOS ]]; then
  # NixOS's /etc is read-only: services.lyrica-host declares the unit (nix/host-module.nix).
  systemctl cat lyrica-host-egress.service >/dev/null 2>&1 ||
    fail "add services.lyrica-host to this machine's NixOS configuration (host/README.md, \"On NixOS\"), rebuild, and run install.sh again."
  [[ $(systemctl show -p ExecStart --value lyrica-host-egress.service) == *"$PWD/egress.sh"* ]] ||
    fail "services.lyrica-host.checkout doesn't name this clone ($(dirname "$PWD")). Set it, rebuild, and run install.sh again."
  "${SUDO[@]}" systemctl restart lyrica-host-egress.service
elif [[ -d /run/systemd/system ]]; then
  sed "s#@HOST_DIR@#$PWD#g" lyrica-host-egress.service | "${SUDO[@]}" tee /etc/systemd/system/lyrica-host-egress.service >/dev/null
  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl enable --now lyrica-host-egress.service >/dev/null
else
  say "No systemd here: run host/egress.sh apply after every reboot or Docker restart."
fi

mkdir -p "$MODELS/lyrica"
"${COMPOSE[@]}" build
# fetch writes downloads as its own user (10001), into lyrica/ only.
"${COMPOSE[@]}" run --rm --no-deps -T --user 0 --cap-add CHOWN --entrypoint chown fetch 10001:10001 /models/lyrica
"${COMPOSE[@]}" up -d --remove-orphans

# Once Tailscale has joined, the auth key isn't needed: drop it from .env.
if [[ -n $TS_HOSTNAME && -n $TS_AUTHKEY ]]; then
  JOINED=0
  for _ in $(seq 60); do
    if "${COMPOSE[@]}" exec -T tailscale tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then JOINED=1; break; fi
    sleep 2
  done
  if [[ $JOINED == 1 ]]; then
    sed -i 's/^TS_AUTHKEY=.*/TS_AUTHKEY=/' .env
    touch .tailscale-joined
  else
    say "Tailscale hasn't joined yet; the auth key stays in host/.env until it does. See: ${COMPOSE[*]} logs tailscale"
  fi
fi

# Self-test: host-api must not reach anything outside, by address or by name.
for target in "host:'1.1.1.1',port:443" "host:'example.com',port:443"; do
  if "${COMPOSE[@]}" exec -T host-api node -e "require('net').connect({${target},timeout:5000}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))" 2>/dev/null; then
    "${COMPOSE[@]}" stop host-api >/dev/null
    fail "host-api could open a connection to the internet (${target}), so it was stopped. Check host/egress.sh's rules."
  fi
done

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
