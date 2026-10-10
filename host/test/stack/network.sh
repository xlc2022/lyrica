#!/usr/bin/env bash
# Checks the network layout on a running stack (see .github/workflows/ci.yml):
# nothing that sees prompts has a route out, and only the machine itself gets
# the local dashboard. Run after install.sh, with whatever compose set it chose.
set -euo pipefail
cd "$(dirname "$0")/../.."
COMPOSE_FILE="$(sed -n 's/^COMPOSE_FILE=//p' .env):test/stack/compose.probe.yaml"
export COMPOSE_FILE
compose() { docker compose "$@"; }
compose up -d probe-models >/dev/null 2>&1
trap 'compose rm -sf probe-models >/dev/null 2>&1 || true' EXIT
failed=0
expect() { # expect yes|no "what" container command...
  local want=$1 what=$2; shift 2
  if compose exec -T "$@" >/dev/null 2>&1; then got=yes; else got=no; fi
  if [[ $got == "$want" ]]; then echo "ok: $what"; else echo "FAIL: $what (expected $want, got $got)"; failed=1; fi
}
tcp() { echo "require('net').connect({host:'$1',port:$2,timeout:5000}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"; }
lan=$(sed -n 's/^LAN_ADDRESS=//p' .env)

expect no  "the models network can't reach the internet by address" probe-models nc -z -w 5 1.1.1.1 443
expect no  "the models network can't resolve or reach the internet by name" probe-models wget -q -T 5 -O /dev/null https://example.com
[[ -n $lan ]] && expect no "the models network can't reach the machine's LAN address" probe-models nc -z -w 5 "$lan" 7236
expect yes "the models network reaches host-api" probe-models nc -z -w 5 host-api 7443
expect no  "the models network doesn't get the local dashboard" probe-models wget -q -T 5 -O /dev/null http://host-api:7080/dashboard/me
expect no  "host-api can't reach the internet by address" host-api node -e "$(tcp 1.1.1.1 443)"
expect no  "host-api can't reach the internet by name" host-api node -e "$(tcp example.com 443)"
gateway=$(docker network inspect lyrica-host_edge --format '{{(index .IPAM.Config 0).Gateway}}')
if [[ -z $gateway ]]; then # some Docker versions leave it out when only the subnet is given: read the bridge
  edge_id=$(docker network inspect lyrica-host_edge --format '{{.Id}}')
  gateway=$(ip -4 -o addr show "br-${edge_id:0:12}" | awk '{print $4}' | cut -d/ -f1)
fi
# A port that does listen on this machine, so "blocked" isn't just "nothing there".
python3 -m http.server --bind "$gateway" 18765 >/dev/null 2>&1 &
listener=$!
sleep 1
if curl -fsS -o /dev/null "http://$gateway:18765/"; then
  expect no "host-api can't open a connection to this machine" host-api node -e "$(tcp "$gateway" 18765)"
else
  echo "FAIL: couldn't start a listener on $gateway"; failed=1
fi
kill $listener
if compose ps --services | grep -qx tailscale; then
  expect yes "tailscale reaches host-api" tailscale nc -z -w 5 host-api 7443
  expect no  "tailscale doesn't get the local dashboard" tailscale wget -q -T 5 -O /dev/null http://host-api:7080/dashboard/me
fi
curl -fsS -o /dev/null http://127.0.0.1:7236/dashboard/me && echo "ok: the machine gets the local dashboard on 127.0.0.1:7236" || { echo "FAIL: local dashboard"; failed=1; }
if docker ps --format '{{.Ports}}' | grep -q '0\.0\.0\.0:\|\[::\]:'; then echo "FAIL: a port is published on every interface"; failed=1; else echo "ok: nothing is published on every interface"; fi
if [[ $(docker network inspect lyrica-host_edge --format '{{len .Containers}}') == 1 ]]; then echo "ok: host-api is alone on its bridge"; else echo "FAIL: something else is on host-api's bridge"; failed=1; fi
exit $failed
