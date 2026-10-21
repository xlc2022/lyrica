#!/usr/bin/env bash
# Stops what earlier jobs left running on this runner (docs/ci.md, "Leftovers").
# A cancelled job can orphan its test servers, browsers and sandbox helpers:
# they outlive the runner's own cleanup, and enough of them use up the
# runner's threads, so Chromium can't start ("pthread_create: Resource
# temporarily unavailable", "spawn EAGAIN"). A leftover is a process of this
# user whose parent is init or the user's systemd, and whose command is one
# the jobs start; it goes with everything under it. The running job is never
# a leftover: its processes descend from the runner.
set -euo pipefail

# Process names (ps comm) the jobs start; tsx and npx run as node.
LEFTOVER='^(node|lyricad|headless_shell|chrome.*|vitest|gocryptfs|passt|bwrap|sshd)$'
me=$(id -u)
user_systemd=" $(pgrep -u "$me" -x systemd | tr '\n' ' ' || true)"

tree() { echo "$1"; for c in $(pgrep -P "$1" || true); do tree "$c"; done; }

roots=()
while read -r pid ppid comm; do
  [[ $comm =~ $LEFTOVER ]] || continue
  if [[ $ppid == 1 || $user_systemd == *" $ppid "* ]]; then roots+=("$pid"); fi
done < <(ps -u "$me" -o pid=,ppid=,comm=)

threads=$(ps -L -u "$me" --no-headers 2>/dev/null | wc -l)
echo "threads of $(id -un) before: $threads (limit $(ulimit -u))"
if ((${#roots[@]} == 0)); then echo "no leftovers"; exit 0; fi

pids=()
for r in "${roots[@]}"; do while read -r p; do pids+=("$p"); done < <(tree "$r"); done
echo "stopping ${#roots[@]} leftovers (${#pids[@]} processes): $(ps -o comm= -p "$(IFS=,; echo "${roots[*]}")" | sort | uniq -c | awk '{printf "%s %s, ", $1, $2}' | sed 's/, $//')"
kill -TERM "${pids[@]}" 2>/dev/null || true
for _ in $(seq 10); do
  alive=$( (ps -o pid= -p "$(IFS=,; echo "${pids[*]}")" 2>/dev/null || true) | wc -l)
  ((alive == 0)) && break
  sleep 1
done
kill -KILL "${pids[@]}" 2>/dev/null || true
echo "threads of $(id -un) after: $(ps -L -u "$me" --no-headers 2>/dev/null | wc -l)"
