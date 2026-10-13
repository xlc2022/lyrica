# Shared by lyrica-update, lyrica-snapshot, lyrica-restore and lyrica-rollback.
# install.sh installs it as /usr/local/lib/lyrica-update/common.sh (the NixOS
# module from the store), never an update, so a broken release can't break
# what removes it. See docs/daemon.md, "Updates".
# Logs commits, tags, check names and counts; never message text.

PREFIX=${LYRICA_PREFIX:-/opt/lyrica}
STATE=${LYRICA_STATE:-/var/lib/lyrica}
UPDATE=${LYRICA_UPDATE_DIR:-/var/lib/lyrica-update}
SNAPSHOTS=${LYRICA_SNAPSHOTS:-/var/lib/lyrica-snapshots}
SERVICE_USER=${LYRICA_USER:-lyrica}
BUILD_USER=${LYRICA_BUILD_USER:-lyrica-build}
SYSTEMCTL=${LYRICA_SYSTEMCTL:-systemctl}
# NixOS: releases are generations of this profile instead of folders under $PREFIX/releases.
PROFILE=${LYRICA_PROFILE:-/nix/var/nix/profiles/lyrica}
# Set (even empty, as the tests do) it decides; unset, /etc/NIXOS does.
if [ -n "${LYRICA_NIX+set}" ]; then NIX=$LYRICA_NIX; elif [ -e /etc/NIXOS ]; then NIX=1; else NIX=; fi
SOCKET=$STATE/update.sock
KEEP_RELEASES=5
KEEP_SNAPSHOTS=3
PIN_DAYS=30

ME=$(basename "$0")
say() { printf '%s: %s\n' "$ME" "$*" >&2; }
die() { say "$*"; exit 1; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Root, or the service user for snapshots and restores (tests run as a plain user named in LYRICA_USER).
need_root_or_service() {
  [ "$(id -u)" = 0 ] || [ "$(id -un)" = "$SERVICE_USER" ] || die "run this as root or as $SERVICE_USER"
}

lyricad_active() {
  local s
  s=$($SYSTEMCTL is-active lyricad 2>/dev/null || true)
  [ "$s" = active ] || [ "$s" = reloading ] || [ "$s" = deactivating ]
}

# Atomic JSON writes: a reader never sees half a file.
write_json() { # file, then jq arguments producing the new content from the old (or {})
  local file=$1 tmp; shift
  mkdir -p "$(dirname "$file")"
  tmp=$(mktemp "$file.XXXXXX")
  if [ -f "$file" ]; then jq "$@" "$file" >"$tmp"; else jq -n "$@" >"$tmp"; fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
}
releases_json() { [ -f "$UPDATE/releases.json" ] && cat "$UPDATE/releases.json" || echo '{}'; }

# The updater's state, for Administration → Updates.
set_state() { # state, then optional: tag commit error
  write_json "$UPDATE/state.json" --arg s "$1" --arg t "${2:-}" --arg c "${3:-}" --arg e "${4:-}" --arg at "$(now)" \
    '(. // {}) | .state = $s | .since = $at | del(.busy, .error, .tag, .commit)
     | if $t != "" then .tag = $t else . end | if $c != "" then .commit = $c else . end | if $e != "" then .error = $e else . end'
}

# --- The update socket (lyricad's update.sock: /health, /drain, /undrain) ---
sock() { curl -fsS --max-time 30 --unix-socket "$SOCKET" -X "$1" "http://lyricad$2" 2>/dev/null; }

# Drains: lyricad refuses new turns and reports what still works. Waits up to
# LYRICA_DRAIN_SECONDS (600) for nothing to be working, then undrains and fails.
drain() {
  local limit=${LYRICA_DRAIN_SECONDS:-600} waited=0 busy
  [ -S "$SOCKET" ] && lyricad_active || { say "lyricad isn't running: nothing to drain"; return 0; }
  while :; do
    busy=$(sock POST /drain) || { say "the update socket didn't answer the drain"; sock POST /undrain >/dev/null || true; return 1; }
    if [ "$(jq '.busy | length' <<<"$busy")" = 0 ]; then say "drained"; return 0; fi
    write_json "$UPDATE/state.json" --argjson b "$(jq '.busy' <<<"$busy")" '.busy = $b'
    if [ "$waited" -ge "$limit" ]; then
      say "gave up after ${limit}s with $(jq '.busy | length' <<<"$busy") still working; undrained"
      sock POST /undrain >/dev/null || true
      return 1
    fi
    sleep "${LYRICA_DRAIN_POLL:-5}"
    waited=$((waited + ${LYRICA_DRAIN_POLL:-5}))
  done
}

# --- Releases ---
# Debian: $PREFIX/releases/<commit> with RELEASE.json, and the current and previous symlinks.
# NixOS: generations of $PROFILE, each with lib/lyrica/RELEASE.json.
release_dir() { echo "$PREFIX/releases/$1"; }
release_info() { # commit → its RELEASE.json, as releases.json keeps it
  releases_json | jq -ce --arg c "$1" '[(.releases // [])[] | select(.commit == $c)][0] // empty'
}
current_commit() { releases_json | jq -r '.current // empty'; }
previous_commit() { releases_json | jq -r '.previous // empty'; }

# Whether a release (its RELEASE.json) reads databases that need `needed` ({self,user,pool}).
reads() { # release-json needed-json
  jq -n --argjson r "$1" --argjson n "$2" '[("self","user","pool") as $k | ($r.schema[$k] // 0) >= ($n[$k] // 0)] | all' | grep -qx true
}

# Points lyricad at a release. Debian: the current symlink (and previous). NixOS: the profile.
switch_to() { # commit
  local commit=$1 from
  from=$(current_commit)
  if [ -n "$NIX" ]; then
    local path
    path=$(jq -r --arg c "$commit" '.releases[] | select(.commit == $c) | .path' "$UPDATE/releases.json" | head -1)
    [ -n "$path" ] || die "no kept release $commit"
    nix-env -p "$PROFILE" --set "$path" >/dev/null
    printf 'LYRICA_BUILD=%s\n' "${commit:0:12}" >"$UPDATE/build.env"
  else
    [ -d "$(release_dir "$commit")" ] || die "no kept release $commit"
    ln -sfn "releases/$commit" "$PREFIX/.current.new" && mv -Tf "$PREFIX/.current.new" "$PREFIX/current"
    if [ -n "$from" ] && [ "$from" != "$commit" ]; then
      ln -sfn "releases/$from" "$PREFIX/.previous.new" && mv -Tf "$PREFIX/.previous.new" "$PREFIX/previous"
    fi
  fi
  write_json "$UPDATE/releases.json" --arg c "$commit" --arg f "$from" \
    '.current = $c | if $f != "" and $f != $c then .previous = $f else . end'
}

# Records a built release in releases.json.
add_release() { # commit folder-with-RELEASE.json
  write_json "$UPDATE/releases.json" --argjson r "$(cat "$2/RELEASE.json")" --arg p "$2" \
    '.releases = ([(.releases // [])[] | select(.commit != $r.commit)] + [{path: $p} + $r])'
}

# A release that ran may have raised its databases' min_reader: what any release must read from now on.
raise_min_reader() { # RELEASE.json
  write_json "$UPDATE/releases.json" --argjson r "$1" \
    '.minReader = (reduce ("self","user","pool") as $k ((.minReader // {}); .[$k] = ([(.[$k] // 0), ($r.minReader[$k] // 0)] | max)))'
}

# Keeps the newest KEEP_RELEASES, plus current and previous.
prune_releases() {
  local keep
  keep=$(releases_json | jq -r --argjson n "$KEEP_RELEASES" '
    [.current, .previous] + ([(.releases // [])[]] | sort_by(.builtAt) | reverse | .[:$n] | map(.commit)) | map(select(. != null)) | unique | .[]')
  for c in $(releases_json | jq -r '(.releases // [])[].commit'); do
    grep -qx "$c" <<<"$keep" && continue
    say "removing kept release $c"
    if [ -z "$NIX" ] && [ -d "$(release_dir "$c")" ]; then chmod -R u+w "$(release_dir "$c")"; rm -rf "$(release_dir "$c")"; fi
    if [ -n "$NIX" ]; then rm -rf -- "$UPDATE/releases/$c"; fi
    write_json "$UPDATE/releases.json" --arg c "$c" '.releases = [.releases[] | select(.commit != $c)]'
  done
  if [ -n "$NIX" ]; then nix-env -p "$PROFILE" --delete-generations "+$((KEEP_RELEASES + 1))" >/dev/null 2>&1 || true; fi
}

# --- Snapshots ---
# Each snapshot folder holds meta.json: { at, commit, minReader, kind, files: [{ path, size, sha256 }] }.
# releases.json lists them; `pinned` ones (taken before a contract, and set-aside
# folders) outlive the last KEEP_SNAPSHOTS until `released` and PIN_DAYS old.
prune_snapshots() {
  local cutoff
  cutoff=$(date -u -d "-$PIN_DAYS days" +%Y-%m-%dT%H:%M:%SZ)
  local keep
  keep=$(releases_json | jq -r --argjson n "$KEEP_SNAPSHOTS" --arg cut "$cutoff" '
    (.snapshots // []) as $s
    | ([$s[] | select(.kind == "snapshot")] | sort_by(.at) | reverse | .[:$n] | map(.dir))
      + [$s[] | select(.pinned and ((.released | not) or .at > $cut)) | .dir]
    | unique | .[]')
  for d in $(releases_json | jq -r '(.snapshots // [])[].dir'); do
    grep -qx "$d" <<<"$keep" && continue
    say "removing snapshot $(basename "$d")"
    rm -rf -- "$d"
    write_json "$UPDATE/releases.json" --arg d "$d" '.snapshots = [.snapshots[] | select(.dir != $d)]'
  done
}

# The databases and settings a snapshot holds, relative to $STATE: never the users' homes.
state_files() {
  (cd "$STATE" && find . -maxdepth 1 -type f \( -name '*.db' -o -name '*.json' -o -name name \) -printf '%P\n'
   cd "$STATE" && find users -mindepth 2 -maxdepth 2 -type f -name '*.db' 2>/dev/null) | sort
}

own_state_file() { # path
  if [ "$(id -u)" = 0 ]; then chown "$SERVICE_USER:$SERVICE_USER" "$1"; fi
  chmod 0600 "$1"
}

# install.sh just installed the current units: an update's stale-units report no longer holds.
clear_units_stale() { [ -f "$UPDATE/state.json" ] && write_json "$UPDATE/state.json" 'del(.unitsStale)' || true; }
