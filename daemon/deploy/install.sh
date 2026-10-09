#!/bin/sh
# Installs or upgrades Lyrica on Debian or Ubuntu (in the LXC container or VM):
# the service users, lyricad's code and unit, and the built-in Caddy, built
# from pinned versions with the DNS plugins in daemon/src/web/providers.ts.
# Run as root from a checkout of the repository. Running it again upgrades in
# place: the code is replaced, and Caddy is rebuilt only if a pin changed.
set -eu

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
  bubblewrap gocryptfs fuse3 passt nftables openssl ca-certificates curl unzip rsync >/dev/null
command -v node >/dev/null || die "install Node.js 22 or later (for example from NodeSource), then run this again"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js $NODE_MAJOR is too old: lyricad needs 22 or later"

# --- Users ---
# lyrica runs lyricad; lyrica-caddy runs Caddy. The lyrica-caddy group shares
# Caddy's admin socket and TLS log with lyricad, and with nobody else.
getent group lyrica-caddy >/dev/null || groupadd --system lyrica-caddy
id lyrica-caddy >/dev/null 2>&1 || useradd --system --gid lyrica-caddy --home-dir /var/lib/lyrica-caddy --no-create-home --shell /usr/sbin/nologin lyrica-caddy
id lyrica >/dev/null 2>&1 || useradd --system --user-group --home-dir "$STATE" --no-create-home --shell /usr/sbin/nologin lyrica
usermod -a -G lyrica-caddy lyrica

# --- lyricad's code ---
say "Installing lyricad into $PREFIX..."
mkdir -p "$PREFIX"
if [ "$SRC" != "$PREFIX" ]; then
  rsync -a --delete --exclude .git --exclude node_modules --exclude runtime "$SRC/" "$PREFIX/"
fi
(cd "$PREFIX" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$PREFIX"
chmod -R go-w "$PREFIX"
install -d -o lyrica -g lyrica -m 0700 "$STATE"

# --- The built-in Caddy ---
MODULES=$(grep -o 'module: "[^"]*"' "$PREFIX/daemon/src/web/providers.ts" | sed 's/module: "\(.*\)"/\1/' | sort)
WANT="caddy $CADDY_VERSION go $GO_VERSION xcaddy $XCADDY_VERSION $(printf '%s ' $MODULES)"
if [ -x "$CADDY" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$WANT" ]; then
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
  # Modules come from proxy.golang.org at the pinned versions, checked against sum.golang.org.
  env GOROOT="$GOROOT" PATH="$GOROOT/bin:$BUILD/bin:$PATH" GOPATH="$BUILD/gopath" GOCACHE="$BUILD/cache" \
    GOBIN="$BUILD/bin" GOTOOLCHAIN=local GOFLAGS=-mod=mod HOME="$BUILD" \
    sh -c 'go install "github.com/caddyserver/xcaddy/cmd/xcaddy@$1" && shift && v=$1 && out=$2 && shift 2 &&
      for m in "$@"; do set -- "$@" --with "$m"; shift; done && xcaddy build "$v" --output "$out" "$@"' \
    sh "$XCADDY_VERSION" "$CADDY_VERSION" "$BUILD/caddy" $MODULES >"$BUILD/build.log" 2>&1 \
    || { tail -20 "$BUILD/build.log" >&2; die "building Caddy failed"; }
  install -m 0755 "$BUILD/caddy" "$CADDY"
  mkdir -p "$(dirname "$STAMP")"
  printf '%s' "$WANT" >"$STAMP"
  CADDY_CHANGED=yes
fi
install -d -m 0755 /etc/lyrica
# Only Caddy's first start: its admin API on the group-only socket. lyricad loads the rest.
printf '%s\n' '{"admin":{"listen":"unix//run/lyrica-caddy/admin.sock|0660"}}' >/etc/lyrica/caddy.json
chmod 0644 /etc/lyrica/caddy.json

# --- Units ---
install -m 0644 "$PREFIX/daemon/deploy/lyrica-caddy.service" /etc/systemd/system/lyrica-caddy.service
install -m 0644 "$PREFIX/daemon/deploy/lyricad.service" /etc/systemd/system/lyricad.service
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable --quiet lyrica-caddy lyricad
  if [ "$CADDY_CHANGED" = yes ]; then systemctl restart lyrica-caddy; else systemctl start lyrica-caddy; fi
  if [ -f "$STATE/self.db" ]; then
    systemctl restart lyricad
    say "lyricad restarted."
  else
    say "Next: create self.db and the first administrator, then start lyricad:"
    say "  sudo -u lyrica env LYRICA_HOME=$STATE $PREFIX/bin/lyrica admin init"
    say "  systemctl start lyricad"
  fi
else
  say "systemd isn't running here: the units are installed but not started."
fi
say "Done. Set up web access in the control panel (Administration → Web access)."
