#!/usr/bin/env bash
# lyrica-host-update [--request | --tag update/<name>]
# Updates this model host to one of Lyrica's releases, run as root by
# lyrica-host-update.service when host-api writes a request (Lyrica's Models
# page, Update), or by hand. install.sh installs it as
# /usr/local/sbin/lyrica-host-update; an update never replaces it, so a broken
# release can't break what takes it back. In order: fetch main and the update
# tags with the read-only deploy key; refuse a tag that isn't annotated or
# whose commit isn't on main; pause host-api (running jobs finish, up to 10
# minutes, else resume and change nothing); check the commit out; run
# install.sh; probation (host-api answers with the new commit within 5
# minutes), else check the old commit out and run install.sh again. The host
# ends paused only if it was paused before. One run at a time.
# Logs commits, tags and step names; never prompts or model output. See host/README.md, "Updates".
set -euo pipefail

ME=$(basename "$0")
say() { printf '%s: %s\n' "$ME" "$*" >&2; }
die() { say "$*"; exit 1; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

HOST_DIR=${LYRICA_HOST_DIR:?set LYRICA_HOST_DIR to the host folder of the checkout}
UPDATE=${LYRICA_HOST_UPDATE_DIR:-/var/lib/lyrica-host-update}
REPO=$UPDATE/repo.git
KEY=${LYRICA_HOST_DEPLOY_KEY:-/etc/lyrica-host/deploy-key}
KNOWN=${LYRICA_HOST_KNOWN_HOSTS:-/etc/lyrica-host/known_hosts}
API=${LYRICA_HOST_API:-http://127.0.0.1:7236}
INSTALL=${LYRICA_HOST_INSTALL:-$HOST_DIR/install.sh}
DRAIN_SECONDS=${LYRICA_HOST_DRAIN_SECONDS:-600}
PROBATION_SECONDS=${LYRICA_HOST_PROBATION_SECONDS:-300}
POLL=${LYRICA_HOST_POLL:-2}

[ "$(id -u)" = 0 ] || [ -n "${LYRICA_TEST:-}" ] || die "run this as root"
CHECKOUT=$(cd "$HOST_DIR/.." && pwd)
OWNER=$(stat -c %U "$CHECKOUT")
mkdir -p "$UPDATE/status"
exec 9>"$UPDATE/update.lock"
case "${1:-}" in
  --request) flock 9 ;;
  *) flock -n 9 || die "an update is already running" ;;
esac

# Atomic writes: host-api never reads half a file.
write_json() { # file, then jq arguments producing the new content from the old (or {})
  local file=$1 tmp; shift
  tmp=$(mktemp "$file.XXXXXX")
  if [ -f "$file" ]; then jq "$@" "$file" >"$tmp"; else jq -n "$@" >"$tmp"; fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
}
STATE_FILE=$UPDATE/status/state.json
set_state() { # state, then optional: tag error
  write_json "$STATE_FILE" --arg s "$1" --arg t "${2:-}" --arg e "${3:-}" --arg at "$(now)" \
    '(. // {}) | .state = $s | .since = $at | del(.tag, .error)
     | if $t != "" then .tag = $t else . end | if $e != "" then .error = $e else . end'
}
fail() { # step: the update stops here, and the running commit is untouched
  set_state failed "$TAG" "$1"
  die "update ${TAG:-} failed: $1"
}

# The checkout belongs to whoever cloned it: git runs as them, so root never owns a file in it.
as_owner() { if [ "$(id -u)" = 0 ] && [ "$OWNER" != root ]; then runuser -u "$OWNER" -- "$@"; else "$@"; fi; }
work() { as_owner git -C "$CHECKOUT" "$@"; }

api() { curl -fsS --max-time 10 -X "$1" "$API$2" 2>/dev/null; }
host_state() { api GET /host/v1/status | jq -r '.state // empty' 2>/dev/null || true; }
host_commit() { api GET /host/v1/status | jq -r '.commit // empty' 2>/dev/null || true; }

TAG=
case "${1:-}" in
  --request)
    f=$UPDATE/inbox/request.json
    [ -e "$f" ] || [ -L "$f" ] || exit 0
    # Written by host-api, read by root: a small regular file, never a link.
    if [ -L "$f" ] || [ ! -f "$f" ] || [ "$(stat -c %s "$f")" -gt 1024 ]; then rm -f -- "$f"; die "refused a malformed request"; fi
    TAG=$(jq -r '.tag // empty' "$f" 2>/dev/null || true)
    rm -f -- "$f" ;;
  --tag) TAG=${2:-} ;;
  *) die "usage: $ME --request | --tag update/<name>" ;;
esac
[[ $TAG =~ ^update/[A-Za-z0-9._-]{1,64}$ ]] || fail "not an update tag"

# --- Fetch, and check the tag ---
set_state fetching "$TAG"
[ -d "$REPO" ] || fail "no deploy repository (run install.sh)"
GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN" \
  git --git-dir="$REPO" fetch --quiet --prune --force origin '+refs/heads/main:refs/heads/main' '+refs/tags/update/*:refs/tags/update/*' \
  || fail "fetch"
[ "$(git --git-dir="$REPO" cat-file -t "refs/tags/$TAG" 2>/dev/null)" = tag ] || fail "not an annotated update tag"
COMMIT=$(git --git-dir="$REPO" rev-parse "$TAG^{commit}")
git --git-dir="$REPO" merge-base --is-ancestor "$COMMIT" main || fail "not on main"
[ -z "$(work status --porcelain --untracked-files=no)" ] || fail "the checkout has local changes"
OLD=$(work rev-parse HEAD)
if [ "$COMMIT" = "$OLD" ]; then set_state idle; say "${COMMIT:0:12} is already running"; exit 0; fi
say "updating to ${COMMIT:0:12} ($TAG) from ${OLD:0:12}"

# --- Pause: running jobs finish first ---
set_state draining "$TAG"
BEFORE=$(host_state)
WAS_PAUSED=; [ "$BEFORE" = paused ] && WAS_PAUSED=1
resume() { [ -n "$WAS_PAUSED" ] || api POST /host/v1/resume >/dev/null || true; }
if [ -z "$WAS_PAUSED" ]; then
  api POST /host/v1/pause >/dev/null || fail "pause"
  waited=0
  until [ "$(host_state)" = paused ]; do
    [ "$waited" -lt "$DRAIN_SECONDS" ] || { resume; fail "drain"; }
    sleep "$POLL"; waited=$((waited + POLL))
  done
fi

# --- Switch, install, probation ---
switch() { # commit: check it out and install it; true once host-api answers with it
  work -c advice.detachedHead=false checkout --quiet --detach "$1" || return 1
  # install.sh reads the commit with git as root, in the owner's checkout.
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$CHECKOUT" "$INSTALL" --yes </dev/null || return 1
  # install.sh rewrites .env; it stays the checkout owner's.
  [ "$(id -u)" != 0 ] || [ "$OWNER" = root ] || chown "$OWNER" "$HOST_DIR/.env" 2>/dev/null || true
  local waited=0
  until [ "$(host_commit)" = "$1" ]; do
    [ "$waited" -lt "$PROBATION_SECONDS" ] || return 1
    sleep "$POLL"; waited=$((waited + POLL))
  done
}
set_state building "$TAG"
work fetch --quiet "$REPO" "$COMMIT" || { resume; fail "fetch"; }
if switch "$COMMIT"; then
  resume
  write_json "$STATE_FILE" --arg s idle --arg at "$(now)" --arg t "$TAG" --arg c "$COMMIT" \
    '(. // {}) | .state = $s | .since = $at | del(.tag, .error) | .last = {tag: $t, commit: $c, at: $at, ok: true}'
  say "running ${COMMIT:0:12} ($TAG)"
  exit 0
fi

say "${COMMIT:0:12} didn't come up; going back to ${OLD:0:12}"
set_state rolling-back "$TAG"
switch "$OLD" || say "${OLD:0:12} didn't come up either: run $HOST_DIR/install.sh by hand"
resume
write_json "$STATE_FILE" --arg at "$(now)" --arg t "$TAG" --arg c "$COMMIT" \
  '(. // {}) | .state = "failed" | .since = $at | .tag = $t | .error = "probation" | .last = {tag: $t, commit: $c, at: $at, ok: false}'
die "update $TAG failed: probation; rolled back to ${OLD:0:12}"
