#!/usr/bin/env bash
# Installs, or removes, gpu-unlock on a Debian or Ubuntu model host: full-rate
# FP16/BF16 tensor math on GeForce RTX 20/30/40 cards, unlocked at every boot
# before the NVIDIA driver loads (docs/guides/model-hosts.md, "Full-rate
# tensor math"). Optional: install.sh and updates never run it. On NixOS, set
# services.lyrica-host.gpuUnlock.enable instead.
set -euo pipefail
cd "$(dirname "$0")"

# The upstream commit and NVIDIA's two inputs, as nix/gpu-unlock.nix pins them.
REPO=https://github.com/Zagitta/gpu-unlock
COMMIT=7eb51bccae0a0b7e599e084d971170e9a1e82d0c
VERSION=2.0.0
NV=610.43.03
NV_INPUTS=(
  "https://download.nvidia.com/XFree86/NVIDIA-kernel-module-source/NVIDIA-kernel-module-source-$NV.tar.xz 7e118923c7a23edc36114d63273a46e3e04e9af98695a42203e7ac2dfe9fc1dc"
  "https://download.nvidia.com/XFree86/Linux-x86_64/$NV/NVIDIA-Linux-x86_64-$NV-no-compat32.run e084451db730a6df29d3d74f655749c4d236e3c945f7d94b5205e84318fe2f90"
)
PACKAGES=(gpu-unlock-dkms gpu-unlock-firmware)
GRUB_DROPIN=/etc/default/grub.d/lyrica-gpu-unlock.cfg

usage() {
  cat <<'EOF'
Usage: host/gpu-unlock.sh [options]
  --remove   Remove gpu-unlock and its kernel parameter
  --yes      Don't ask before installing
EOF
}

say() { printf '%s\n' "$*"; }
fail() { printf 'gpu-unlock.sh: %s\n' "$*" >&2; exit 1; }

REMOVE=0 YES=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --remove) REMOVE=1 ;;
    --yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

[[ $(uname -s) == Linux ]] || fail "gpu-unlock runs on Linux only."
[[ ! -e /etc/NIXOS ]] || fail "on NixOS, set services.lyrica-host.gpuUnlock.enable = true and rebuild (host/README.md, \"On NixOS\")."
# shellcheck source=/dev/null
. /etc/os-release
[[ " ${ID:-} ${ID_LIKE:-} " == *" debian "* || " ${ID:-} ${ID_LIKE:-} " == *" ubuntu "* ]] ||
  fail "this script installs Debian packages; on ${ID:-this system}, see $REPO."

SUDO=()
[[ $(id -u) == 0 ]] || SUDO=(sudo)

# The kernel parameter that opts in. Without it the module, which loads on
# every boot, does nothing.
set_param() {
  if [[ $1 == on ]]; then
    "${SUDO[@]}" mkdir -p "$(dirname "$GRUB_DROPIN")"
    printf '%s\n' "# Written by Lyrica's host/gpu-unlock.sh; host/gpu-unlock.sh --remove deletes it." \
      'GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT gpu_unlock.targets=all"' |
      "${SUDO[@]}" tee "$GRUB_DROPIN" >/dev/null
  else
    "${SUDO[@]}" rm -f "$GRUB_DROPIN"
  fi
  "${SUDO[@]}" update-grub
}

if [[ $REMOVE == 1 ]]; then
  [[ -e $GRUB_DROPIN ]] && set_param off
  installed=()
  for p in "${PACKAGES[@]}"; do dpkg -s "$p" >/dev/null 2>&1 && installed+=("$p"); done
  [[ ${#installed[@]} -eq 0 ]] || "${SUDO[@]}" apt-get purge -y "${installed[@]}"
  grep -qw 'gpu_unlock.targets=[^ ]*' /proc/cmdline &&
    say "Removed. Reboot to load the cards without the unlock." || say "Removed."
  exit 0
fi

command -v update-grub >/dev/null ||
  say "No update-grub here: after installing, add gpu_unlock.targets=all to the kernel command line yourself."

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say "Fetching gpu-unlock $COMMIT..."
command -v git >/dev/null && command -v curl >/dev/null ||
  "${SUDO[@]}" apt-get install -y --no-install-recommends git curl ca-certificates
git init -q "$WORK/src"
git -C "$WORK/src" fetch -q --depth 1 "$REPO" "$COMMIT"
git -C "$WORK/src" checkout -q FETCH_HEAD
[[ $(git -C "$WORK/src" rev-parse HEAD) == "$COMMIT" ]] || fail "fetched the wrong commit."

# The cards it unlocks: NVIDIA display devices whose ID its recipes list.
SUPPORTED=$(grep -oE '\b[A-Z]{2}1[0-9]{2}\(0x[0-9a-fA-F]{4}\)' "$WORK/src/kernel/gpu_unlock/recipes.c" | grep -oiE '0x[0-9a-f]{4}' | tr '[:upper:]' '[:lower:]')
CARDS=()
for dev in /sys/bus/pci/devices/*; do
  [[ $(<"$dev/vendor") == 0x10de && $(<"$dev/class") == 0x03* ]] || continue
  if grep -qx "$(<"$dev/device")" <<<"$SUPPORTED"; then CARDS+=("$(basename "$dev")")
  else say "Not supported, left alone: $(basename "$dev") ($(<"$dev/device"))"
  fi
done
[[ ${#CARDS[@]} -gt 0 ]] || fail "no supported card here (GeForce RTX 20, 30 or 40; RTX 30 is the stable family)."
say "Supported cards: ${CARDS[*]}"

if [[ $YES == 0 ]]; then
  say "This builds and installs a kernel module that runs as root at every boot, before the"
  say "NVIDIA driver, and adds gpu_unlock.targets=all to the kernel command line. It takes effect"
  say "after a reboot; host/gpu-unlock.sh --remove undoes it."
  read -r -p "Install gpu-unlock? [y/N]: " answer
  [[ ${answer,,} == y || ${answer,,} == yes ]] || { say "Nothing installed."; exit 0; }
fi

[[ -d /lib/modules/$(uname -r)/build ]] ||
  "${SUDO[@]}" apt-get install -y "linux-headers-$(uname -r)" ||
  fail "no headers for kernel $(uname -r): install them, then run this again."
"${SUDO[@]}" apt-get install -y --no-install-recommends make python3 xz-utils zstd dpkg-dev
"${SUDO[@]}" apt-get build-dep -y "$WORK/src"

mkdir "$WORK/inputs"
for input in "${NV_INPUTS[@]}"; do
  read -r url sum <<<"$input"
  curl -fL --progress-bar --proto '=https' -o "$WORK/inputs/${url##*/}" "$url"
  printf '%s  %s\n' "$sum" "$WORK/inputs/${url##*/}" | sha256sum -c --quiet - || fail "${url##*/} doesn't match its pinned checksum."
done

make -C "$WORK/src" deb INPUTS="$WORK/inputs"
"${SUDO[@]}" apt-get install -y "$WORK/src/build/deb/gpu-unlock-dkms_${VERSION}_all.deb" "$WORK/src/build/deb/gpu-unlock-firmware_${VERSION}_all.deb"
command -v update-grub >/dev/null && set_param on

say ""
say "gpu-unlock is installed. Reboot, then check:"
say "  journalctl -k -b | grep gpu_unlock    (\"unlocked\" for each card)"
