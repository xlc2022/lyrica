#!/bin/bash
# Removes what install.sh put on a Debian or Ubuntu host: her units, the
# code and tool prefix under /opt/lyrica (every program installed there for
# her sandboxes, eBay's MCP server included), the updater, the CLI, Caddy
# and the kiwix start script under /usr/local, /etc/lyrica, the caches and
# the SearXNG container. It keeps her data: /var/lib/lyrica (every user's
# memories and threads), the update snapshots, Caddy's certificates, her
# Tailscale node, the Wikipedia ZIM files and the three service users, and
# says so. `--purge` deletes those too, for good. It never removes an apt
# package (bubblewrap, Node, tailscale, kiwix-tools and the rest), since
# other things may use them. Run as root, from a checkout or from
# /opt/lyrica/current/daemon/deploy. See docs/guides/getting-started.md,
# "Uninstall".
set -euo pipefail

PREFIX=/opt/lyrica
PURGE=no
case "${1:-}" in
  --purge) PURGE=yes ;;
  "") ;;
  *) echo "usage: $0 [--purge]" >&2; exit 2 ;;
esac
[ "$(id -u)" = 0 ] || { echo "run this as root" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

UNITS="lyricad lyrica-caddy lyrica-tailscaled lyrica-searxng lyrica-kiwix lyrica-update.path lyrica-update lyrica-probation lyrica-rollback"
if [ -d /run/systemd/system ]; then
  say "Stopping her services..."
  # shellcheck disable=SC2086
  systemctl disable --now --quiet $UNITS 2>/dev/null || true
fi
for u in $UNITS; do
  case "$u" in *.path) rm -f "/etc/systemd/system/$u" ;; *) rm -f "/etc/systemd/system/$u.service" ;; esac
done
rm -f /etc/sysctl.d/60-lyrica.conf
[ -d /run/systemd/system ] && systemctl daemon-reload

if command -v docker >/dev/null 2>&1; then
  docker rm -f lyrica-searxng >/dev/null 2>&1 || true
fi

say "Removing her code, tools, updater, CLI and Caddy..."
# The whole prefix: releases, the bare repository, and tools/ with every
# program an operator installed there for her sandboxes.
rm -rf "$PREFIX" /etc/lyrica \
  /usr/local/lib/lyrica-update /usr/local/lib/lyrica-caddy.stamp \
  /usr/local/bin/lyrica /usr/local/bin/lyrica-caddy \
  /usr/local/sbin/lyrica-kiwix-start /usr/local/sbin/lyrica-update \
  /usr/local/sbin/lyrica-snapshot /usr/local/sbin/lyrica-restore /usr/local/sbin/lyrica-rollback \
  /var/cache/lyrica-searxng /var/cache/lyrica-tailscale
# Copies an install from before 2026-11-01 left in /usr/local, and eBay's
# MCP server where the guide of that day said to put it.
rm -rf /usr/local/lib/lyrica-chromium /usr/local/bin/chromium-headless-shell
for pkg in @anthropic-ai/claude-code @openai/codex @ebay/npm-public-api-mcp; do
  [ -d "/usr/local/lib/node_modules/$pkg" ] && npm uninstall -g --prefix /usr/local --loglevel=error "$pkg" >/dev/null 2>&1 || true
done

DATA="/var/lib/lyrica /var/lib/lyrica-snapshots /var/lib/lyrica-update /var/lib/lyrica-caddy /var/lib/lyrica-tailscale /var/lib/lyrica-kiwix"
if [ "$PURGE" = yes ]; then
  say "Deleting her data, the snapshots, Caddy's certificates, her Tailscale node and the ZIM files..."
  # shellcheck disable=SC2086
  rm -rf $DATA
  for u in lyrica lyrica-build lyrica-caddy; do userdel "$u" 2>/dev/null || true; done
  groupdel lyrica-caddy 2>/dev/null || true
  say "Done. Her node is still listed in your tailnet's admin console, and the deploy key in the repository on GitHub: remove those by hand."
else
  say "Done. Kept, since they hold her data or were not installed by install.sh:"
  for d in $DATA; do [ -e "$d" ] && say "  $d"; done
  say "  the lyrica, lyrica-build and lyrica-caddy users"
  say "Run $0 --purge to delete those too; copy /var/lib/lyrica first if anyone may want their memories back."
fi
say "apt packages (bubblewrap, gocryptfs, passt, nftables, Node, tailscale, kiwix-tools, ...) stay; remove them with apt only if nothing else uses them."
