#!/bin/bash
# Installs or upgrades Lyrica on Debian or Ubuntu (in the LXC container or VM):
# the service users, her own tailscaled, the built-in Caddy (built from
# pinned versions with the DNS plugins in daemon/src/web/providers.ts) and
# lyricad. Run as root from a git checkout of the repository (not inside
# /opt/lyrica). Each run builds the checkout's commit into its own release,
# /opt/lyrica/releases/<commit>, snapshots her databases and switches
# /opt/lyrica/current to it, as an update does; Caddy is rebuilt only if a pin
# changed. It also installs the updater (lyrica-update and its units), which
# no update replaces. It asks whether to run SearXNG for her web search in
# Docker (LYRICA_SEARXNG=yes or no answers ahead). A first install ends with the setup page's addresses,
# certificate fingerprint and code. See docs/daemon.md, "Deployment" and "Updates".
set -euo pipefail

# --- Pins ---
GO_VERSION=1.27.2
# sha256 of golang.org/toolchain@v0.0.1-go$GO_VERSION.linux-<arch>.zip from proxy.golang.org.
GO_SHA256_amd64=3a467ed067f27cd55bf3a702f8e2bf12479f53c9d8ae0de548f48ebcb3c67796
GO_SHA256_arm64=b5d2cb7bfe76d9cb10141eff26ad2c591c752bce8bf4dd9f24521bb6b5994dfb
XCADDY_VERSION=v0.4.7
CADDY_VERSION=v2.11.7
# The SearXNG image, by tag and digest, and its port on 127.0.0.1.
SEARXNG_IMAGE=docker.io/searxng/searxng:2026.10.16-8252c0bf6@sha256:3619192d55f19eaec4b01892bdf10f80c67e8592fafd14b26ca504e52229210f
SEARXNG_PORT=8888

PREFIX=/opt/lyrica
STATE=/var/lib/lyrica
# The updater fetches update tags from here with a read-only deploy key.
REPO_URL=${LYRICA_REPO:-git@github.com:xlc2022/lyrica.git}
# GitHub's published SSH host key, so the updater never trusts a first answer.
GITHUB_HOST_KEY="github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
CADDY=/usr/local/bin/lyrica-caddy
STAMP=/usr/local/lib/lyrica-caddy.stamp
SRC=$(cd "$(dirname "$0")/../.." && pwd)

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$SRC/daemon/src/web/providers.ts" ] || die "run it from a checkout of the repository"
case "$SRC/" in "$PREFIX"/*) die "run it from a checkout outside $PREFIX, such as /root/lyrica" ;; esac
. /etc/os-release
case " $ID ${ID_LIKE:-} " in *" debian "*|*" ubuntu "*) ;; *) die "this script is for Debian or Ubuntu" ;; esac
ARCH=$(dpkg --print-architecture)
case "$ARCH" in amd64) GO_SHA256=$GO_SHA256_amd64 ;; arm64) GO_SHA256=$GO_SHA256_arm64 ;; *) die "no pinned Go for $ARCH" ;; esac

# --- Asked first, so the rest runs unattended ---
# SearXNG for her web search (docs/guides/searxng.md). Once set up, every run
# keeps it at this script's pin; nothing here installs Docker.
if [ -f /etc/lyrica/searxng/settings.yml ]; then
  SEARXNG=yes
else
  case "${LYRICA_SEARXNG:-}" in
    yes|no) SEARXNG=$LYRICA_SEARXNG ;;
    "")
      if [ -t 0 ]; then
        read -r -p "Run SearXNG in Docker on this machine for her web search? [Y/n] " answer
        case "$answer" in [nN]*) SEARXNG=no ;; *) SEARXNG=yes ;; esac
      else
        SEARXNG=no
        say "Not setting up SearXNG: there's no terminal to ask. LYRICA_SEARXNG=yes sets it up."
      fi ;;
    *) die "LYRICA_SEARXNG is yes or no" ;;
  esac
fi
if [ "$SEARXNG" = yes ] && ! command -v docker >/dev/null; then
  SEARXNG=no
  say "Not setting up SearXNG: Docker isn't installed. Install Docker, then run this again to add it."
fi

# --- Packages ---
say "Installing packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  bubblewrap gocryptfs fuse3 passt nftables openssl ca-certificates curl unzip rsync imagemagick \
  build-essential python3 git gh openssh-client jq >/dev/null
# tea, Gitea's and Forgejo's client, isn't packaged everywhere; git alone still works with those accounts.
apt-get install -y -qq --no-install-recommends tea >/dev/null 2>&1 \
  || say "tea isn't packaged here: threads with a Gitea or Forgejo account use git alone until it's installed."
command -v node >/dev/null || die "install Node.js 22.6 or later (for example from NodeSource), then run this again"
# 22.6 for the SSH helper, which runs with type stripping.
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 6) ? 0 : 1)' \
  || die "Node.js $(node -v) is too old: lyricad needs 22.6 or later"

# --- A browser for her screenshots ---
# Principle 1: render HTML/SVG diagrams offline in the thread sandbox.
# Playwright's headless Chromium, at the version this checkout's Playwright
# expects, with the libraries it needs; her sandbox sees it as
# /usr/local/bin/chromium-headless-shell (web/e2e/shot.ts). Ubuntu ships
# Chromium only as a snap, so Debian and Ubuntu both get this one. IBM Plex is
# the web UI's font.
apt-get install -y -qq --no-install-recommends fonts-ibm-plex >/dev/null 2>&1 \
  || say "fonts-ibm-plex isn't packaged here: her screenshots use a fallback font."
BROWSERS=/usr/local/lib/lyrica-chromium
PW_VERSION=$(jq -r '.devDependencies["@playwright/test"]' "$SRC/web/package.json")
if [ "$(cat "$BROWSERS/version" 2>/dev/null)" != "$PW_VERSION" ]; then
  say "Installing headless Chromium for screenshots..."
  PLAYWRIGHT_BROWSERS_PATH=$BROWSERS npx -y "playwright@$PW_VERSION" install --with-deps chromium-headless-shell >/dev/null \
    || die "installing headless Chromium failed"
  SHELL_BIN=$(find "$BROWSERS" -type f \( -name headless_shell -o -name chrome-headless-shell \) -perm -u+x | sort -V | tail -1)
  [ -n "$SHELL_BIN" ] || die "headless Chromium installed, but its binary isn't in $BROWSERS"
  ln -sfn "$SHELL_BIN" /usr/local/bin/chromium-headless-shell
  printf '%s\n' "$PW_VERSION" >"$BROWSERS/version"
fi

# --- Claude Code ---
# Anthropic's `claude` program, for threads with Claude Code on
# (docs/workspace.md, "Claude Code"). The version NixOS 26.05 packages, in
# /usr/local, where her sandbox finds it. An update leaves it as it is.
CLAUDE_CODE_VERSION=2.1.223
if [ "$(/usr/local/bin/claude --version 2>/dev/null | cut -d' ' -f1)" != "$CLAUDE_CODE_VERSION" ]; then
  say "Installing Claude Code..."
  npm install -g --prefix /usr/local --no-audit --no-fund --loglevel=error "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" >/dev/null \
    || say "installing Claude Code failed: threads can't use it until it's installed."
fi

# --- Codex ---
# OpenAI's `codex` program, which makes ChatGPT Images with the user's own
# Codex sign-in (docs/models.md, "Image canvases"), in /usr/local, where
# Lyrica's sandbox finds it. An update leaves it as it is.
CODEX_VERSION=0.163.0
if [ "$(/usr/local/bin/codex --version 2>/dev/null | awk '{print $NF}')" != "$CODEX_VERSION" ]; then
  say "Installing Codex..."
  npm install -g --prefix /usr/local --no-audit --no-fund --loglevel=error "@openai/codex@$CODEX_VERSION" >/dev/null \
    || say "installing Codex failed: ChatGPT Images can't work until it's installed."
fi

# --- Tailscale ---
# Her own tailscaled (lyrica-tailscaled.service, below) runs the package's
# binaries. Installed from Tailscale's repository only when they're missing; a
# host's own tailscaled.service is left as it is.
if ! command -v tailscale >/dev/null || [ ! -x /usr/sbin/tailscaled ]; then
  say "Installing Tailscale from its repository..."
  case "$ID" in debian|ubuntu) TS_DIST=$ID ;; *) die "no Tailscale repository for $ID: install the tailscale package, then run this again" ;; esac
  [ -n "${VERSION_CODENAME:-}" ] || die "can't tell this release's codename for Tailscale's repository"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL "https://pkgs.tailscale.com/stable/$TS_DIST/$VERSION_CODENAME.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL "https://pkgs.tailscale.com/stable/$TS_DIST/$VERSION_CODENAME.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
  # Whether the host's own tailscaled.service was on before: if so, it stays exactly as it was.
  TS_WAS=$(systemctl is-enabled tailscaled 2>/dev/null || true)
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends tailscale >/dev/null
  # The package enables the host's own tailscaled; a host that had none on keeps none on.
  if [ -d /run/systemd/system ] && [ "$TS_WAS" != enabled ]; then systemctl disable --now --quiet tailscaled 2>/dev/null || true; fi
fi

# --- Users ---
# lyrica runs lyricad; lyrica-caddy runs Caddy. The lyrica-caddy group shares
# Caddy's admin socket and TLS log with lyricad, and with nobody else.
getent group lyrica-caddy >/dev/null || groupadd --system lyrica-caddy
id lyrica-caddy >/dev/null 2>&1 || useradd --system --gid lyrica-caddy --home-dir /var/lib/lyrica-caddy --no-create-home --shell /usr/sbin/nologin lyrica-caddy
id lyrica >/dev/null 2>&1 || useradd --system --user-group --home-dir "$STATE" --no-create-home --shell /usr/sbin/nologin lyrica
# lyrica-build builds releases and runs their smoke tests: no access to her data.
id lyrica-build >/dev/null 2>&1 || useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin lyrica-build
# lyricad gets the lyrica-caddy group from its unit (SupplementaryGroups), not from /etc/group.

# --- The updater (never replaced by an update) ---
install -d -m 0755 /usr/local/lib/lyrica-update /var/lib/lyrica-update
install -d -m 0700 /var/lib/lyrica-snapshots
install -m 0644 "$SRC/daemon/deploy/updater/common.sh" /usr/local/lib/lyrica-update/common.sh
for t in lyrica-update lyrica-snapshot lyrica-restore lyrica-rollback; do
  install -m 0755 "$SRC/daemon/deploy/updater/$t" "/usr/local/sbin/$t"
done
install -d -m 0755 /etc/lyrica
if [ ! -f /etc/lyrica/deploy-key ]; then
  ssh-keygen -q -t ed25519 -N "" -C "lyrica-update@$(hostname)" -f /etc/lyrica/deploy-key
  NEW_DEPLOY_KEY=yes
fi
chmod 0600 /etc/lyrica/deploy-key
printf '%s\n' "$GITHUB_HOST_KEY" >/etc/lyrica/known_hosts
if [ ! -d "$PREFIX/repo.git" ]; then
  git init -q --bare "$PREFIX/repo.git"
  git --git-dir="$PREFIX/repo.git" remote add origin "$REPO_URL"
fi
git --git-dir="$PREFIX/repo.git" fetch -q "$SRC" HEAD

# --- lyricad's code: a release ---
# The common functions the updater uses: releases.json, switching, snapshots.
. /usr/local/lib/lyrica-update/common.sh
say() { printf '%s\n' "$*"; }
COMMIT=$(git -C "$SRC" rev-parse HEAD 2>/dev/null) || die "run it from a git checkout: a release is named by its commit"
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || die "the checkout has uncommitted changes: a release is exactly one commit"
REL="$PREFIX/releases/$COMMIT"
mkdir -p "$PREFIX/releases"
# Before releases, the code was /opt/lyrica itself: set it aside (not a release to go back to).
if [ -d "$PREFIX/bin" ] && [ ! -L "$PREFIX/current" ]; then
  mkdir -p "$PREFIX/before-releases"
  for f in "$PREFIX"/* "$PREFIX"/.[!.]*; do
    case "$(basename "$f")" in releases|repo.git|before-releases|build) ;; *) [ -e "$f" ] && mv "$f" "$PREFIX/before-releases/" ;; esac
  done
  say "The code from before releases is in $PREFIX/before-releases; delete it once this release runs."
fi
if [ -f "$REL/RELEASE.json" ]; then
  say "Release ${COMMIT:0:12} is already built."
else
  say "Building release ${COMMIT:0:12} (npm and the web UI, a few minutes)..."
  WORK="$PREFIX/build/$COMMIT"
  rm -rf "$WORK"; mkdir -p "$WORK/src" "$WORK/home"
  git -C "$SRC" archive "$COMMIT" | tar -x -C "$WORK/src"
  chown -R lyrica-build:lyrica-build "$WORK"
  runuser -u lyrica-build -- env -i HOME="$WORK/home" PATH=/usr/local/bin:/usr/bin:/bin npm_config_cache="$WORK/home/.npm" \
    sh -c 'cd "$1" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent && npm prune --omit=dev --no-audit --no-fund --loglevel=error' \
    sh "$WORK/src" >"$WORK/build.log" 2>&1 || { tail -20 "$WORK/build.log" >&2; die "building the release failed"; }
  (cd "$WORK/src" && runuser -u lyrica-build -- env -i HOME="$WORK/home" PATH=/usr/local/bin:/usr/bin:/bin node bin/lyrica version --json) \
    | jq --arg c "$COMMIT" --arg at "$(now)" '{commit: $c, builtAt: $at, version, schema, minReader}' >"$WORK/RELEASE.json"
  mv "$WORK/RELEASE.json" "$WORK/src/RELEASE.json"
  chown -R root:root "$WORK/src"
  chmod -R a+rX,a-w "$WORK/src"
  mv -T "$WORK/src" "$REL"
  rm -rf "$WORK"
fi
add_release "$COMMIT" "$REL"
if [ "$(current_commit)" != "$COMMIT" ]; then
  # As an update does: turns finish, then a snapshot from a clean stop, then the switch.
  if [ -f "$STATE/self.db" ]; then
    if [ -d /run/systemd/system ]; then drain || die "lyricad stayed busy for 10 minutes; run this again later"; systemctl stop lyricad; fi
    lyrica-snapshot --commit "$(current_commit || true)" >/dev/null
  fi
  switch_to "$COMMIT"
  raise_min_reader "$(cat "$REL/RELEASE.json")"
fi
prune_releases
install -d -o lyrica -g lyrica -m 0700 "$STATE"
# `lyrica` on the PATH runs the CLI as the lyrica user with her state folder.
sed -e "s|@CLI@|$PREFIX/current/bin/lyrica|" -e "s|@STATE@|$STATE|" "$REL/daemon/deploy/lyrica" >/usr/local/bin/lyrica
chmod 0755 /usr/local/bin/lyrica

# --- The built-in Caddy ---
MODULES=$(sed -n 's/.*module: "\([^"]*\)".*/\1/p' "$REL/daemon/src/web/providers.ts" | sort)
[ -n "$MODULES" ] || die "found no DNS plugins in daemon/src/web/providers.ts"
WANT="caddy $CADDY_VERSION go $GO_VERSION xcaddy $XCADDY_VERSION $(printf '%s ' $MODULES)"
if [ -x "$CADDY" ] && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$WANT" ]; then
  say "Caddy is up to date."
  CADDY_CHANGED=no
else
  say "Building Caddy $CADDY_VERSION with the DNS plugins (a few minutes)..."
  BUILD=$(mktemp -d)
  trap 'rm -rf "$BUILD"' EXIT
  curl -fsSL -o "$BUILD/go.zip" "https://proxy.golang.org/golang.org/toolchain/@v/v0.0.1-go$GO_VERSION.linux-$ARCH.zip"
  echo "$GO_SHA256  $BUILD/go.zip" | sha256sum -c --quiet - || die "the Go toolchain's checksum doesn't match"
  unzip -q "$BUILD/go.zip" -d "$BUILD/go"
  GOROOT="$BUILD/go/golang.org/toolchain@v0.0.1-go$GO_VERSION.linux-$ARCH"
  # A clean environment: modules come only from proxy.golang.org at the pinned
  # versions, checked against sum.golang.org, whatever root's Go settings say.
  env -i GOROOT="$GOROOT" PATH="$GOROOT/bin:$BUILD/bin:/usr/bin:/bin" HOME="$BUILD" GOPATH="$BUILD/gopath" GOCACHE="$BUILD/cache" \
    GOBIN="$BUILD/bin" GOENV=off GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOTOOLCHAIN=local GOFLAGS=-mod=mod \
    sh -c 'go install "github.com/caddyserver/xcaddy/cmd/xcaddy@$1" && shift && v=$1 && out=$2 && shift 2 &&
      for m in "$@"; do set -- "$@" --with "$m"; shift; done && xcaddy build "$v" --output "$out" "$@"' \
    sh "$XCADDY_VERSION" "$CADDY_VERSION" "$BUILD/caddy" $MODULES >"$BUILD/build.log" 2>&1 \
    || { tail -20 "$BUILD/build.log" >&2; die "building Caddy failed"; }
  install -m 0755 "$BUILD/caddy" "$CADDY"
  mkdir -p "$(dirname "$STAMP")"
  printf '%s' "$WANT" >"$STAMP"
  CADDY_CHANGED=yes
fi
# Caddy binds its addresses even before they're up (Tailscale at boot, a DHCP
# renewal), instead of failing to start.
printf 'net.ipv4.ip_nonlocal_bind = 1\n' >/etc/sysctl.d/60-lyrica.conf
sysctl -q -w net.ipv4.ip_nonlocal_bind=1 || say "Couldn't set net.ipv4.ip_nonlocal_bind here; Caddy may need a restart once Tailscale is up."

# Only Caddy's first start: its admin API on the group-only socket. lyricad loads the rest.
printf '%s\n' '{"admin":{"listen":"unix//run/lyrica-caddy/admin.sock|0660"}}' >/etc/lyrica/caddy.json
chmod 0644 /etc/lyrica/caddy.json

# --- SearXNG (when asked for) ---
# Runs as lyrica-searxng.service, published on 127.0.0.1 only. Its address
# waits in $STATE/searxng-address, and lyricad stores it as Administration's
# SearXNG address while none is set.
if [ "$SEARXNG" = yes ]; then
  install -d -m 0700 /etc/lyrica/searxng /var/cache/lyrica-searxng
  if [ ! -f /etc/lyrica/searxng/settings.yml ]; then
    umask 077
    sed "s|@SECRET@|$(openssl rand -hex 32)|" "$SRC/daemon/deploy/searxng-settings.yml" >/etc/lyrica/searxng/settings.yml
    umask 022
  fi
  printf 'SEARXNG_IMAGE=%s\nSEARXNG_PORT=%s\n' "$SEARXNG_IMAGE" "$SEARXNG_PORT" >/etc/lyrica/searxng.env
  say "Fetching SearXNG..."
  docker pull -q "$SEARXNG_IMAGE" >/dev/null || die "fetching the SearXNG image failed"
  install -m 0644 "$SRC/daemon/deploy/lyrica-searxng.service" /etc/systemd/system/lyrica-searxng.service
  printf 'http://127.0.0.1:%s\n' "$SEARXNG_PORT" >"$STATE/searxng-address"
  chown lyrica:lyrica "$STATE/searxng-address"
  chmod 0600 "$STATE/searxng-address"
fi

# --- Units ---
for u in lyrica-caddy.service lyricad.service lyrica-tailscaled.service lyrica-update.service lyrica-update.path lyrica-rollback.service lyrica-probation.service; do
  install -m 0644 "$SRC/daemon/deploy/$u" "/etc/systemd/system/$u"
done
clear_units_stale
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable --quiet lyrica-caddy lyrica-tailscaled lyricad lyrica-update.path lyrica-probation
  systemctl start lyrica-update.path
  if [ "$CADDY_CHANGED" = yes ]; then systemctl restart lyrica-caddy; else systemctl start lyrica-caddy; fi
  if [ "$SEARXNG" = yes ]; then
    systemctl enable --quiet lyrica-searxng
    systemctl restart lyrica-searxng
    ANSWERED=no
    for _ in $(seq 1 30); do
      curl -fsS -o /dev/null "http://127.0.0.1:$SEARXNG_PORT/healthz" 2>/dev/null && { ANSWERED=yes; break; }
      sleep 1
    done
    if [ "$ANSWERED" = yes ]; then say "SearXNG answers on 127.0.0.1:$SEARXNG_PORT."
    else say "SearXNG hasn't answered yet (journalctl -u lyrica-searxng); Administration → Web search will say when it does."; fi
  fi
  systemctl start lyrica-tailscaled || say "Her tailscaled didn't start (journalctl -u lyrica-tailscaled); Administration → Tailnet will say so."
  if [ -f "$STATE/self.db" ]; then
    systemctl restart lyricad
    say "lyricad restarted."
  else
    # Without self.db lyricad starts setting up: a one-time code, and Direct on this machine's addresses.
    systemctl restart lyricad
    for _ in $(seq 1 30); do [ -f "$STATE/setup-code" ] && break; sleep 1; done
    say ""
    say "Set Lyrica up in a browser. Your browser will warn about the certificate once;"
    say "check that its SHA-256 fingerprint is the one below before going on."
    /usr/local/bin/lyrica admin setup-code || say "No setup code yet: run 'lyrica admin setup-code' once lyricad is up (journalctl -u lyricad)."
    say ""
  fi
else
  say "systemd isn't running here: the units are installed but not started."
fi
if [ "${NEW_DEPLOY_KEY:-}" = yes ]; then
  say "For Administration → Updates, add this as a read-only deploy key of $REPO_URL:"
  cat /etc/lyrica/deploy-key.pub
fi
say "Running release ${COMMIT:0:12}. Go back with: sudo lyrica-rollback"
say "Done. lyricad listens on 127.0.0.1:7340; 'lyrica admin setup-code' prints the setup page's code until Lyrica is set up."
