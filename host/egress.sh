#!/usr/bin/env bash
# host-api sees every prompt, so it may not start a connection anywhere:
# replies to connections made to it pass, everything it starts is dropped,
# both to other machines (FORWARD, through DOCKER-USER) and to this one
# (INPUT). DNS for outside names goes out from its namespace too, so it is
# dropped the same way. Docker never flushes DOCKER-USER, but a reboot or a
# firewall reload does, so lyrica-host-egress.service runs this after Docker
# starts. Usage: egress.sh apply|remove [host-api address]
set -euo pipefail
cd "$(dirname "$0")"
ip=${2:-$(sed -n 's/^HOST_API_IP=//p' .env)}
[[ -n $ip ]] || { echo "egress.sh: no HOST_API_IP in host/.env" >&2; exit 1; }
chain=LYRICA-HOST-API
case ${1:-apply} in
  apply)
    # Before Docker starts, its chain may not exist yet: make it; Docker keeps it.
    iptables -N DOCKER-USER 2>/dev/null || true
    iptables -N "$chain" 2>/dev/null || iptables -F "$chain"
    iptables -A "$chain" -s "$ip" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
    iptables -A "$chain" -s "$ip" -j DROP
    for parent in DOCKER-USER INPUT; do
      iptables -C "$parent" -j "$chain" 2>/dev/null || iptables -I "$parent" 1 -j "$chain"
    done ;;
  remove)
    for parent in DOCKER-USER INPUT; do iptables -D "$parent" -j "$chain" 2>/dev/null || true; done
    iptables -F "$chain" 2>/dev/null || true
    iptables -X "$chain" 2>/dev/null || true ;;
  *) echo "usage: egress.sh apply|remove" >&2; exit 2 ;;
esac
