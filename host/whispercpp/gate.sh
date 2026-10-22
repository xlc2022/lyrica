#!/bin/bash
# Runs whisper-server for the model host-api names in /serving/whisper.json:
# {"run": true, "attempt": "...", "args": [...]}, or {"run": false}.
# whisper-server takes its model as start-up arguments and holds GPU memory
# for as long as it lives, so a new model means a new process, and none runs
# while no model is loaded. /status/whisper.json names the attempt it
# started, and its exit code if it exited, so host-api fails a load that
# can't start. Like sdcpp/gate.sh, it has no listener and never sees the
# Docker socket.
#
# `gate.sh --health` is the container's health check: healthy while it reports.
set -u
STATE=${WHISPER_STATE:-/serving/whisper.json}
STATUS=${WHISPER_STATUS:-/status/whisper.json}
SERVER=${WHISPER_SERVER:-/whisper/whisper-server}

[ "${1:-}" = --health ] && { [ -f "$STATUS" ]; exit; }

pid='' running=null
report() { printf '%s' "$1" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"; }
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
      # Answers OpenAI's path; flash attention is faster on the CMP here.
      # Without --convert it takes WAV only and writes no files.
      "$SERVER" --host 0.0.0.0 --port 8080 --inference-path /v1/audio/transcriptions --flash-attn "${args[@]}" &
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
