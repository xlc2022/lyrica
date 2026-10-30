#!/bin/bash
# Runs sd-server for the recipe host-api names in /serving/sdcpp.json:
# {"run": true, "attempt": "...", "args": [...]}, or {"run": false}.
# sd-server takes its model as start-up arguments and holds GPU memory for as
# long as it lives, so a new recipe means a new process, and none runs while
# no recipe is loaded. /status/sdcpp.json names the attempt it started, and
# its exit code if it exited, so host-api fails a load that can't start. It
# also says whether the card's FP16 tensor cores run at full rate (a CMP
# unlocked since boot, cmp-unlock.sh) or throttled, as tensor-probe found
# when the container started; host-api picks sd-server's precision and flash
# attention to suit.
# Like comfyui/gate.py, this has no listener and never sees the Docker socket.
#
# `gate.sh --health` is the container's health check: healthy while it reports.
set -u
STATE=${SDCPP_STATE:-/serving/sdcpp.json}
STATUS=${SDCPP_STATUS:-/status/sdcpp.json}
SERVER=${SDCPP_SERVER:-/app/sd-server}
PROBE=${SDCPP_PROBE:-/app/tensor-probe}

[ "${1:-}" = --health ] && { [ -f "$STATUS" ]; exit; }

pid='' running=null
tensor=$("$PROBE" 2>/dev/null)
[ "$tensor" = full ] || tensor=throttled
report() { jq -c --arg tensor "$tensor" '. + {tensor: $tensor}' <<<"$1" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"; }
stop() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  pid=''
}
trap 'stop; exit 0' TERM INT

report '{}'
while :; do
  want=$(jq -c 'if .run == true then {attempt: (.attempt | tostring), args: [.args[] | tostring]} else null end' "$STATE" 2>/dev/null || echo null)
  if [ "$want" != "$running" ]; then
    stop
    running=$want
    if [ "$want" = null ]; then
      report '{}'
    else
      # Each argument NUL-terminated, so none is split or globbed.
      mapfile -d '' args < <(jq -j '.args[] | (., "\u0000")' <<<"$want")
      "$SERVER" --listen-ip 0.0.0.0 --listen-port 8188 "${args[@]}" &
      pid=$!
      report "$(jq -c '{attempt}' <<<"$want")"
    fi
  elif [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"
    code=$?
    pid=''
    report "$(jq -c --argjson code "$code" '{attempt, exited: $code}' <<<"$running")"
  fi
  sleep 1 & wait $!
done
