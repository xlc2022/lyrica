#!/usr/bin/env bash
# Keeps host-api published on this machine's LAN address when DHCP (or a move
# to another network) gives the machine a new one. Docker binds a container's
# ports when it starts it: if the address in .env is gone by then, host-api
# runs with no published port at all, the dashboard's 127.0.0.1:7236 and the
# updater's way in included. Run as root by lyrica-host-lan.timer, at boot and
# every 5 minutes: with the address still there and bound, it does nothing;
# otherwise it takes the interface's new private IPv4 address (or, with no
# interface recorded, the one the default route uses), writes it to .env and
# starts host-api again on it. An IPv6 LAN address is left as it is. Usage: lan.sh
set -euo pipefail
cd "$(dirname "$0")"
[[ -f .env ]] || exit 0
val() { sed -n "s/^$1=//p" .env | tail -n 1; }
old=$(val LAN_ADDRESS)
[[ -n $old && $old != *:* ]] || exit 0
iface=$(val LAN_INTERFACE)
# As install.sh: a private or CGNAT address, since Docker's published ports skip the firewall.
private() { [[ $1 =~ ^10\. || $1 =~ ^192\.168\. || $1 =~ ^172\.(1[6-9]|2[0-9]|3[01])\. || $1 =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]; }
here() { ip -o -4 addr show | awk '{print $4}' | cut -d/ -f1 | grep -qxF "$1"; }
bound() { docker port lyrica-host-host-api-1 7443/tcp 2>/dev/null | grep -qxF "$1:7236"; }

new=$old
if ! here "$old"; then
  new=
  [[ -z $iface ]] || new=$(ip -o -4 addr show dev "$iface" scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]; exit}')
  [[ -n $new ]] || new=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  if [[ -z $new ]] || ! private "$new"; then
    echo "lan.sh: $old is no longer this machine's, and it has no private address in its place yet: host-api stays off the LAN" >&2
    exit 0
  fi
fi
bound "$new" && exit 0
docker inspect lyrica-host-host-api-1 >/dev/null 2>&1 || exit 0 # not installed, or removed: nothing to restart
if [[ $new != "$old" ]]; then
  echo "lan.sh: the LAN address moved from $old to $new"
  sed -i -e "s/^LAN_ADDRESS=.*/LAN_ADDRESS=$new/" -e "s/^LAN_BIND=.*/LAN_BIND=$new/" .env
else
  echo "lan.sh: host-api started before $old was up: starting it again"
fi
docker compose up -d --no-deps --no-build host-api
