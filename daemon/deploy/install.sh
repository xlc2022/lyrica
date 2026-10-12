#!/bin/bash
# Installs or upgrades Lyrica on Debian or Ubuntu (in the LXC container or VM):
# the service users, lyricad's code and unit, her own tailscaled, and the
# built-in Caddy, built from pinned versions with the DNS plugins in
# daemon/src/web/providers.ts. A first install ends with the setup page's
# addresses, certificate fingerprint and code.
# Run as root from a checkout of the repository. Running it again upgrades in
# place: the code is replaced, and Caddy is rebuilt only if a pin changed.
set -euo pipefail

# --- Pins ---
GO_VERSION=1.27.2
# sha256 of golang.org/toolchain@v0.0.1-go$GO_VERSION.linux-<arch>.zip from proxy.golang.org.
GO_SHA256_amd64=3a467ed067f27cd55bf3a702f8e2bf12479f53c9d8ae0de548f48ebcb3c67796
GO_SHA256_arm64=b5d2cb7bfe76d9cb10141eff26ad2c591c752bce8bf4dd9f24521bb6b5994dfb
XCADDY_VERSION=v0.4.7
CADDY_VERSION=v2.11.7

PREFIX=/opt/lyrica
STATE=/var/lib/lyrica
CADDY=/usr/local/bin/lyrica-caddy
STAMP=/usr/local/lib/lyrica-caddy.stamp
SRC=$(cd "$(dirname "$0")/../.." && pwd)

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$SRC/daemon/src/web/providers.ts" ] || die "run it from a checkout of the repository"
. /etc/os-release
case " $ID ${ID_LIKE:-} " in *" debian "*|*" ubuntu "*) ;; *) die "this script is for Debian or Ubuntu" ;; esac
ARCH=$(dpkg --print-architecture)
case "$ARCH" in amd64) GO_SHA256=$GO_SHA256_amd64 ;; arm64) GO_SHA256=$GO_SHA256_arm64 ;; *) die "no pinned Go for $ARCH" ;; esac

# --- Packages ---
say "Installing packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  bubblewrap gocryptfs fuse3 passt nftables openssl ca-certificates curl unzip rsync imagemagick >/dev/null
command -v node >/dev/null || die "install Node.js 22.6 or later (for example from NodeSource), then run this again"
# 22.6 for the SSH helper, which runs with type stripping.
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 6) ? 0 : 1)' \
  || die "Node.js $(node -v) is too old: lyricad needs 22.6 or later"

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
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends tailscale >/dev/null
  # The package enables the host's own tailscaled; a host that had none keeps none.
  if [ -d /run/systemd/system ]; then systemctl disable --now --quiet tailscaled 2>/dev/null || true; fi
fi

# --- Users ---
# lyrica runs lyricad; lyrica-caddy runs Caddy. The lyrica-caddy group shares
# Caddy's admin socket and TLS log with lyricad, and with nobody else.
getent group lyrica-caddy >/dev/null || groupadd --system lyrica-caddy
id lyrica-caddy >/dev/null 2>&1 || useradd --system --gid lyrica-caddy --home-dir /var/lib/lyrica-caddy --no-create-home --shell /usr/sbin/nologin lyrica-caddy
id lyrica >/dev/null 2>&1 || useradd --system --user-group --home-dir "$STATE" --no-create-home --shell /usr/sbin/nologin lyrica
# lyricad gets the lyrica-caddy group from its unit (SupplementaryGroups), not from /etc/group.

# --- lyricad's code ---
say "Installing lyricad into $PREFIX..."
mkdir -p "$PREFIX"
if [ "$SRC" != "$PREFIX" ]; then
  rsync -a --delete --exclude .git --exclude node_modules --exclude runtime "$SRC/" "$PREFIX/"
fi
(cd "$PREFIX" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$PREFIX"
chmod -R a+rX,go-w "$PREFIX"
install -d -o lyrica -g lyrica -m 0700 "$STATE"
# `lyrica` on the PATH runs the CLI as the lyrica user with her state folder.
sed -e "s|@CLI@|$PREFIX/bin/lyrica|" -e "s|@STATE@|$STATE|" "$PREFIX/daemon/deploy/lyrica" >/usr/local/bin/lyrica
chmod 0755 /usr/local/bin/lyrica

# --- The built-in Caddy ---
MODULES=$(sed -n 's/.*module: "\([^"]*\)".*/\1/p' "$PREFIX/daemon/src/web/providers.ts" | sort)
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

install -d -m 0755 /etc/lyrica
# Only Caddy's first start: its admin API on the group-only socket. lyricad loads the rest.
printf '%s\n' '{"admin":{"listen":"unix//run/lyrica-caddy/admin.sock|0660"}}' >/etc/lyrica/caddy.json
chmod 0644 /etc/lyrica/caddy.json

# --- Units ---
install -m 0644 "$PREFIX/daemon/deploy/lyrica-caddy.service" /etc/systemd/system/lyrica-caddy.service
install -m 0644 "$PREFIX/daemon/deploy/lyricad.service" /etc/systemd/system/lyricad.service
install -m 0644 "$PREFIX/daemon/deploy/lyrica-tailscaled.service" /etc/systemd/system/lyrica-tailscaled.service
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable --quiet lyrica-caddy lyrica-tailscaled lyricad
  if [ "$CADDY_CHANGED" = yes ]; then systemctl restart lyrica-caddy; else systemctl start lyrica-caddy; fi
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
say "Done. lyricad listens on 127.0.0.1:7340; 'lyrica admin setup-code' prints the setup page's code until Lyrica is set up."
