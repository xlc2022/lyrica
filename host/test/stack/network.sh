#!/usr/bin/env bash
# Checks the stack's network layout on a running stack (see .github/workflows/ci.yml):
# the model servers' network has no route out, and only the machine itself gets the
# local dashboard. Run from host/ after install.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
compose() { docker compose -f compose.yaml -f compose.lan.yaml -f test/stack/compose.probe.yaml "$@"; }
compose up -d probe-models probe-outside >/dev/null 2>&1
trap 'compose rm -sf probe-models probe-outside >/dev/null 2>&1 || true' EXIT
failed=0
expect() { # expect yes|no "what" container command...
  local want=$1 what=$2; shift 2
  if compose exec -T "$@" >/dev/null 2>&1; then got=yes; else got=no; fi
  if [[ $got == "$want" ]]; then echo "ok: $what"; else echo "FAIL: $what (expected $want, got $got)"; failed=1; fi
}
expect no  "the models network can't reach the internet by address" probe-models nc -z -w 5 1.1.1.1 443
expect no  "the models network can't resolve or reach the internet by name" probe-models wget -q -T 5 -O /dev/null https://example.com
expect no  "the models network can't reach the machine's LAN address" probe-models nc -z -w 5 "$(sed -n 's/^LAN_ADDRESS=//p' .env)" 7236
expect yes "the models network reaches host-api" probe-models nc -z -w 5 host-api 7443
expect no  "the models network doesn't get the local dashboard" probe-models wget -q -T 5 -O /dev/null http://host-api:7080/dashboard/me
expect no  "the outside network doesn't get the local dashboard" probe-outside wget -q -T 5 -O /dev/null http://host-api:7080/dashboard/me
expect yes "the outside network reaches the internet" probe-outside nc -z -w 5 1.1.1.1 443
# fetch: the one route out, and nothing else.
tcp() { echo "require('net').connect({host:'$1',port:$2,timeout:5000}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"; }
expect yes "fetch reaches the internet" fetch node -e "$(tcp 1.1.1.1 443)"
expect no  "fetch can't reach the models network" fetch node -e "$(tcp probe-models 80)"
expect no  "another container on the outside network can't use fetch" probe-outside wget -q -T 5 -O /dev/null http://fetch:7300/record
expect yes "host-api can use fetch" host-api node -e "fetch('http://fetch:7300/record').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
curl -fsS -o /dev/null http://127.0.0.1:7236/dashboard/me && echo "ok: the machine gets the local dashboard on 127.0.0.1:7236" || { echo "FAIL: local dashboard"; failed=1; }
if docker ps --format '{{.Ports}}' | grep -q '0\.0\.0\.0:\|\[::\]:'; then echo "FAIL: a port is published on every interface"; failed=1; else echo "ok: nothing is published on every interface"; fi
exit $failed
