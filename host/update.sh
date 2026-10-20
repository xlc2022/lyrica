#!/usr/bin/env bash
# lyrica-host-update [--request | --tag update/<name> | --models DIR]
# Updates this model host to one of Lyrica's releases, or moves it to another
# models folder, run as root by lyrica-host-update.service when host-api
# writes a request (Lyrica's Models page: Update, or the host's models
# folder), or by hand. install.sh installs it as
# /usr/local/sbin/lyrica-host-update; an update never replaces it, so a broken
# release can't break what takes it back. In order: fetch main and the update
# tags with the read-only deploy key; refuse a tag that isn't annotated or
# whose commit isn't on main; pause host-api (running jobs finish, up to 10
# minutes, else resume and change nothing); unpack the commit from the
# updater's own repository into a root-owned tree under /opt/lyrica-host;
# run that tree's install.sh, with the settings carried over; probation
# (host-api answers with the new commit within 5 minutes), else install the
# commit before from its own tree the same way. Root never runs code from a
# person's checkout. The host ends paused only if it was paused before. One
# run at a time. A new models folder is the running commit installed again
# the same way, with --models: root checks the folder first (a folder that
# exists, outside the system's and the host's own files), and goes back to
# the old folder if the host doesn't come up on it.
# Logs commits, tags and step names; never prompts or model output. See host/README.md, "Updates".
set -euo pipefail

ME=$(basename "$0")
say() { printf '%s: %s\n' "$ME" "$*" >&2; }
die() { say "$*"; exit 1; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

UPDATE=${LYRICA_HOST_UPDATE_DIR:-/var/lib/lyrica-host-update}
REPO=$UPDATE/repo.git
RELEASES=${LYRICA_HOST_RELEASES:-/opt/lyrica-host}
KEY=${LYRICA_HOST_DEPLOY_KEY:-/etc/lyrica-host/deploy-key}
KNOWN=${LYRICA_HOST_KNOWN_HOSTS:-/etc/lyrica-host/known_hosts}
API=${LYRICA_HOST_API:-http://127.0.0.1:7236}
DRAIN_SECONDS=${LYRICA_HOST_DRAIN_SECONDS:-600}
PROBATION_SECONDS=${LYRICA_HOST_PROBATION_SECONDS:-300}
POLL=${LYRICA_HOST_POLL:-2}
KEEP=3

[ "$(id -u)" = 0 ] || [ -n "${LYRICA_TEST:-}" ] || die "run this as root"
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
set_state() { # state, then optional: tag error (and the models folder asked for, from $MODELS)
  write_json "$STATE_FILE" --arg s "$1" --arg t "${2:-}" --arg e "${3:-}" --arg m "${MODELS:-}" --arg at "$(now)" \
    '(. // {}) | .state = $s | .since = $at | del(.tag, .error, .models)
     | if $t != "" then .tag = $t else . end | if $e != "" then .error = $e else . end
     | if $m != "" then .models = $m else . end'
}
fail() { # step: the update stops here, and the running commit is untouched
  set_state failed "$TAG" "$1"
  die "${MODELS:+models folder }update ${TAG:-${MODELS:-}} failed: $1"
}

api() { curl -fsS --max-time 10 -X "$1" "$API$2" 2>/dev/null; }
host_state() { api GET /host/v1/status | jq -r '.state // empty' 2>/dev/null || true; }
host_commit() { api GET /host/v1/status | jq -r '.commit // empty' 2>/dev/null || true; }
host_models() { api GET /host/v1/status | jq -r '.modelsFolder.path // empty' 2>/dev/null || true; }
rgit() { git --git-dir="$REPO" "$@"; }

TAG= MODELS=
case "${1:-}" in
  --request)
    f=$UPDATE/inbox/request.json
    [ -e "$f" ] || [ -L "$f" ] || exit 0
    # Written by host-api, read by root: a small regular file, never a link.
    if [ -L "$f" ] || [ ! -f "$f" ] || [ "$(stat -c %s "$f")" -gt 8192 ]; then rm -f -- "$f"; die "refused a malformed request"; fi
    TAG=$(jq -r '.tag // empty' "$f" 2>/dev/null || true)
    MODELS=$(jq -r '.models // empty' "$f" 2>/dev/null || true)
    rm -f -- "$f" ;;
  --tag) TAG=${2:-} ;;
  --models) MODELS=${2:-} ;;
  *) die "usage: $ME --request | --tag update/<name> | --models DIR" ;;
esac
[ -n "$TAG" ] && [ -n "$MODELS" ] && { MODELS=; fail "not one request"; }
[ -n "$MODELS" ] || [[ $TAG =~ ^update/[A-Za-z0-9._-]{1,64}$ ]] || fail "not an update tag"

# The installed host folder, as install.sh last recorded it: a checkout the
# first time, a tree under $RELEASES after an update. Root only reads its settings.
HOST_DIR=$(cat "$UPDATE/current" 2>/dev/null || true)
[ -n "$HOST_DIR" ] && [ -f "$HOST_DIR/.env" ] || fail "no installed host (run install.sh)"
# The commit to go back to, from the installed folder's settings: root's to choose, not host-api's.
OLD=$(sed -n 's/^HOST_COMMIT=\([0-9a-f]\{40\}\)$/\1/p' "$HOST_DIR/.env" | tail -n 1)
OLD_MODELS=$(sed -n 's/^MODELS_DIR=//p' "$HOST_DIR/.env" | tail -n 1)

# --- A models folder: checked by root, whatever host-api checked ---
# It must exist, and hold none of the host's own files (its settings, the
# updater, its releases) nor lie in the system's: every model server reads it.
inside() { [ "$1" = "$2" ] || [[ $1 == "$2"/* ]]; } # path, folder
if [ -n "$MODELS" ]; then
  [[ $MODELS == /* && ${#MODELS} -le 4096 && $MODELS != *[[:cntrl:]]* ]] || fail "not a folder"
  [ -d "$MODELS" ] || fail "not a folder"
  MODELS=$(realpath -e -- "$MODELS") || fail "not a folder"
  [ -d "$MODELS" ] || fail "not a folder"
  [ "$MODELS" != / ] || fail "a system folder"
  for sys in /bin /boot /dev /etc /lib /lib32 /lib64 /libx32 /proc /root /run /sbin /sys /usr /var/lib/docker /var/lib/containerd /var/log; do
    inside "$MODELS" "$sys" && fail "a system folder"
  done
  for own in "$UPDATE" "$RELEASES" "$(dirname "$KEY")" "$HOST_DIR"; do
    own=$(realpath -m -- "$own")
    inside "$own" "$MODELS" && fail "holds the host's own files"
    inside "$MODELS" "$own" && fail "holds the host's own files"
  done
  # Downloads go into its lyrica/ subfolder: a real folder, never a link.
  [ ! -L "$MODELS/lyrica" ] && { [ ! -e "$MODELS/lyrica" ] || [ -d "$MODELS/lyrica" ]; } || fail "its lyrica subfolder isn't a folder"
  if [ "$MODELS" = "$OLD_MODELS" ]; then set_state idle; say "$MODELS is already the models folder"; exit 0; fi
  [ -n "$OLD" ] && [ -n "$OLD_MODELS" ] || fail "no installed host (run install.sh)"
fi

# --- Fetch, and check the tag (or, for a models folder, have the running commit) ---
set_state fetching "$TAG"
[ -d "$REPO" ] || fail "no deploy repository (run install.sh)"
fetch() {
  GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN" \
    rgit fetch --quiet --prune --force origin '+refs/heads/main:refs/heads/main' '+refs/tags/update/*:refs/tags/update/*'
}
if [ -n "$MODELS" ]; then
  # Root installs only trees from its own repository, so it needs the running commit there.
  rgit cat-file -e "$OLD^{commit}" 2>/dev/null || fetch || fail "fetch"
  rgit cat-file -e "$OLD^{commit}" 2>/dev/null || fail "not on main"
  COMMIT=$OLD
  say "moving the models folder from $OLD_MODELS to $MODELS"
else
  fetch || fail "fetch"
  [ "$(rgit cat-file -t "refs/tags/$TAG" 2>/dev/null)" = tag ] || fail "not an annotated update tag"
  COMMIT=$(rgit rev-parse "$TAG^{commit}")
  rgit merge-base --is-ancestor "$COMMIT" main || fail "not on main"
  if [ "$COMMIT" = "$OLD" ]; then set_state idle; say "${COMMIT:0:12} is already running"; exit 0; fi
  say "updating to ${COMMIT:0:12} ($TAG) from ${OLD:0:12}"
fi

# --- Pause: running jobs finish first ---
set_state draining "$TAG"
WAS_PAUSED=; [ "$(host_state)" = paused ] && WAS_PAUSED=1
resume() { [ -n "$WAS_PAUSED" ] || api POST /host/v1/resume >/dev/null || true; }
if [ -z "$WAS_PAUSED" ]; then
  api POST /host/v1/pause >/dev/null || fail "pause"
  waited=0
  until [ "$(host_state)" = paused ]; do
    [ "$waited" -lt "$DRAIN_SECONDS" ] || { resume; fail "drain"; }
    sleep "$POLL"; waited=$((waited + POLL))
  done
fi

# --- Trees, install, probation ---
tree() { # commit: its root-owned tree's host folder, unpacked from the updater's repository
  local dir=$RELEASES/$1 tmp
  if [ ! -d "$dir" ]; then
    mkdir -p "$RELEASES"; chmod 0755 "$RELEASES"
    tmp=$(mktemp -d "$RELEASES/.new.XXXXXX")
    rgit archive "$1" | tar -x -C "$tmp" || { rm -rf "$tmp"; return 1; }
    chmod -R go-w "$tmp"; chmod 0755 "$tmp"
    mv "$tmp" "$dir"
  fi
  printf '%s/host\n' "$dir"
}
# Settings are plain files root reads, never runs: .env (install.sh writes it
# afresh from the values it knows) and Tailscale's joined mark.
carry() { # from, to
  local f
  [ "$1" -ef "$2" ] && return 0
  for f in .env .tailscale-joined; do
    if [ -f "$1/$f" ] && [ ! -L "$1/$f" ]; then install -m 0600 "$1/$f" "$2/$f"; fi
  done
}
switch() { # commit, version, then optional models folder: install it from its tree; true once host-api answers with it
  local dir waited=0 version=$2
  dir=$(tree "$1") || return 1
  carry "$HOST_DIR" "$dir"
  # A models folder alone keeps the version the running install recorded.
  [ -n "${3:-}" ] && version=$(sed -n 's/^HOST_VERSION=//p' "$dir/.env" | tail -n 1)
  ( cd "$dir" && LYRICA_HOST_UPDATING=1 LYRICA_HOST_COMMIT=$1 LYRICA_HOST_VERSION=${version:-$2} "${LYRICA_HOST_INSTALL:-./install.sh}" --yes ${3:+--models "$3"} </dev/null ) || return 1
  until [ "$(host_commit)" = "$1" ] && { [ -z "${3:-}" ] || [ "$(host_models)" = "$3" ]; }; do
    [ "$waited" -lt "$PROBATION_SECONDS" ] || return 1
    sleep "$POLL"; waited=$((waited + POLL))
  done
  printf '%s\n' "$dir" >"$UPDATE/current"
  HOST_DIR=$dir
}
prune() { # keeps the newest $KEEP trees, and the running one; drops half-unpacked ones
  local keep running d
  rm -rf -- "$RELEASES"/.new.*
  running=$(dirname "$(cat "$UPDATE/current")")
  keep=$(ls -1td "$RELEASES"/*/ 2>/dev/null | head -n "$KEEP" || true)
  for d in "$RELEASES"/*/; do
    d=${d%/}
    [ -d "$d" ] || continue
    [ "$d" = "$running" ] || grep -qxF "$d/" <<<"$keep" || rm -rf -- "$d"
  done
}

set_state building "$TAG"
# What ran, for the record: a tag, or a models folder.
last() { # ok
  jq -n --arg t "$TAG" --arg c "$COMMIT" --arg m "$MODELS" --arg at "$(now)" --argjson ok "$1" \
    '{commit: $c, at: $at, ok: $ok} + (if $m != "" then {models: $m} else {tag: $t} end)'
}
if switch "$COMMIT" "$TAG" "$MODELS"; then
  resume
  prune
  write_json "$STATE_FILE" --arg s idle --arg at "$(now)" --argjson l "$(last true)" \
    '(. // {}) | .state = $s | .since = $at | del(.tag, .error, .models) | .last = $l'
  if [ -n "$MODELS" ]; then say "the models folder is $MODELS"; else say "running ${COMMIT:0:12} ($TAG)"; fi
  exit 0
fi

if [ -n "$MODELS" ]; then
  say "the host didn't come up on $MODELS; going back to $OLD_MODELS"
  set_state rolling-back "$TAG"
  switch "$OLD" "${OLD:0:12}" "$OLD_MODELS" || say "it didn't come up on $OLD_MODELS either: run install.sh in $HOST_DIR by hand"
else
  say "${COMMIT:0:12} didn't come up; going back to ${OLD:0:12}"
  set_state rolling-back "$TAG"
  if [ -z "$OLD" ] || ! rgit cat-file -e "$OLD^{commit}" 2>/dev/null; then
    say "${OLD:0:12} isn't in the updater's repository: run install.sh in $HOST_DIR by hand"
  elif ! switch "$OLD" "${OLD:0:12}"; then
    say "${OLD:0:12} didn't come up either: run install.sh in $HOST_DIR by hand"
  fi
fi
resume
write_json "$STATE_FILE" --arg at "$(now)" --arg t "$TAG" --arg m "$MODELS" --argjson l "$(last false)" \
  '(. // {}) | .state = "failed" | .since = $at | del(.tag, .models) | .error = "probation" | .last = $l
   | if $m != "" then .models = $m else .tag = $t end'
die "${MODELS:+models folder }update ${TAG:-$MODELS} failed: probation; went back"
