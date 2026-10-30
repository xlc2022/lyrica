#!/usr/bin/env bash
# Installs, or removes, cmp100-unlock on a Debian or Ubuntu model host with a
# CMP 100-210 (PCI ID 10de:1df4 or 10de:1d84): full-rate tensor cores and PCIe Gen3,
# applied by a systemd unit at every boot, before Docker starts, and lost at
# power-off. The model servers notice the unlock when they start
# (host/README.md, "CMP 100-210"). install.sh offers it on such a host; updates
# never run it. On NixOS, set services.lyrica-host.cmpUnlock.enable instead.
set -euo pipefail
cd "$(dirname "$0")"

# The upstream commit nix/cmp-unlock.nix pins too; change both together.
REPO=https://github.com/mintoriakamoto/CMP100-210xFULLTENSORSxGEN3x1
COMMIT=8abaad2fe2903c8ea10fe88c04c2acc8778aebf2
DROPIN=/etc/systemd/system/cmp100-unlock.service.d/lyrica.conf

usage() {
  cat <<'EOF'
Usage: host/cmp-unlock.sh [options]
  --remove   Remove cmp100-unlock
  --yes      Don't ask before installing
EOF
}

say() { printf '%s\n' "$*"; }
fail() { printf 'cmp-unlock.sh: %s\n' "$*" >&2; exit 1; }

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

[[ $(uname -s) == Linux ]] || fail "cmp100-unlock runs on Linux only."
[[ ! -e /etc/NIXOS ]] || fail "on NixOS, set services.lyrica-host.cmpUnlock.enable = true and rebuild (host/README.md, \"On NixOS\")."
# shellcheck source=/dev/null
. /etc/os-release
[[ " ${ID:-} ${ID_LIKE:-} " == *" debian "* || " ${ID:-} ${ID_LIKE:-} " == *" ubuntu "* ]] ||
  fail "this script is for Debian and Ubuntu; on ${ID:-this system}, see $REPO."

SUDO=()
[[ $(id -u) == 0 ]] || SUDO=(sudo)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fetch() {
  say "Fetching cmp100-unlock $COMMIT..."
  command -v git >/dev/null || "${SUDO[@]}" apt-get install -y --no-install-recommends git ca-certificates
  git init -q "$WORK/src"
  git -C "$WORK/src" fetch -q --depth 1 "$REPO" "$COMMIT"
  git -C "$WORK/src" checkout -q FETCH_HEAD
  [[ $(git -C "$WORK/src" rev-parse HEAD) == "$COMMIT" ]] || fail "fetched the wrong commit."
}

if [[ $REMOVE == 1 ]]; then
  if [[ -e /etc/systemd/system/cmp100-unlock.service ]]; then
    fetch
    "${SUDO[@]}" bash "$WORK/src/uninstall.sh"
    "${SUDO[@]}" rm -f /usr/local/bin/cmp100-verify
  fi
  "${SUDO[@]}" rm -rf "$(dirname "$DROPIN")"
  "${SUDO[@]}" systemctl daemon-reload
  say "Removed. The card runs throttled again after a reboot."
  exit 0
fi

CARDS=()
for dev in /sys/bus/pci/devices/*; do
  if [[ $(<"$dev/vendor") == 0x10de && $(<"$dev/device") == 0x1@(df4|d84) ]]; then CARDS+=("$(basename "$dev")"); fi
done
[[ ${#CARDS[@]} -gt 0 ]] || fail "no CMP 100-210 (10de:1df4 or 10de:1d84) here."
say "CMP 100-210: ${CARDS[*]}"
[[ -d /sys/firmware/efi ]] && command -v mokutil >/dev/null && mokutil --sb-state 2>/dev/null | grep -q enabled &&
  fail "Secure Boot is on: the unlock's kernel module is unsigned and won't load. Turn Secure Boot off first."

if [[ $YES == 0 ]]; then
  say "This builds a kernel module and installs a unit that runs as root at every boot, before"
  say "Docker, to unlock the card's tensor cores and PCIe Gen3 ($REPO)."
  say "It keeps nouveau and nvidia_drm from loading (/etc/modprobe.d/cmp100-unlock.conf), so a"
  say "desktop drawn by an NVIDIA card here would lose its display. It takes effect after a"
  say "reboot; host/cmp-unlock.sh --remove undoes it."
  read -r -p "Install cmp100-unlock? [y/N]: " answer
  [[ ${answer,,} == y || ${answer,,} == yes ]] || { say "Nothing installed."; exit 0; }
fi

fetch
"${SUDO[@]}" bash "$WORK/src/install.sh" --no-enable
# Upstream stops nvidia-persistenced before it checks that nothing holds the
# GPUs, and leaves it stopped when it then refuses. Start it again then.
"${SUDO[@]}" mkdir -p "$(dirname "$DROPIN")"
printf '%s\n' "# Written by Lyrica's host/cmp-unlock.sh; host/cmp-unlock.sh --remove deletes it." \
  '[Service]' \
  "ExecStopPost=-/bin/sh -c '[ \"\$\$SERVICE_RESULT\" = success ] || ! systemctl is-enabled -q nvidia-persistenced.service || systemctl start --no-block nvidia-persistenced.service'" |
  "${SUDO[@]}" tee "$DROPIN" >/dev/null
"${SUDO[@]}" systemctl daemon-reload
"${SUDO[@]}" systemctl enable cmp100-unlock.service >/dev/null

say ""
say "cmp100-unlock is installed. Reboot, then check:"
say "  journalctl -u cmp100-unlock -b    (\"PASS\" for each card)"
say "  cmp100-bench                      (about 37 cycles per HMMA when unlocked, 512 when not)"
