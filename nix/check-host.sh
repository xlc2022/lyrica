#!/usr/bin/env bash
# Checks a NixOS host running services.lyrica (docs/daemon.md, "On NixOS"). Run as root
# after `lyrica admin init` and `systemctl start lyricad`. Prints one line per
# check and "All checks passed." at the end, or stops at the first failure.
set -uo pipefail
ok() { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = 0 ] || bad "run as root"
systemctl is-active --quiet lyrica-caddy && ok "lyrica-caddy is running" || bad "lyrica-caddy isn't running: journalctl -u lyrica-caddy"
systemctl is-active --quiet lyricad && ok "lyricad is running" || bad "lyricad isn't running: journalctl -u lyricad"
pid=$(systemctl show -p MainPID --value lyricad)
grep -q '^NoNewPrivs:[[:space:]]*0' "/proc/$pid/status" && ok "lyricad has NoNewPrivs 0" || bad "lyricad has NoNewPrivs set: homes and sandboxes won't work"
[ -u /run/wrappers/bin/fusermount3 ] && ok "fusermount3 is setuid" || bad "/run/wrappers/bin/fusermount3 isn't setuid"
[ -S /run/lyrica-caddy/admin.sock ] && ok "Caddy's admin socket exists" || bad "no /run/lyrica-caddy/admin.sock"
tools=$(systemctl show -p Environment --value lyricad | tr ' ' '\n' | sed -n 's/^LYRICA_SANDBOX_TOOLS=//p')
[ -d "$tools/bin" ] && ok "sandbox tools at $tools" || bad "LYRICA_SANDBOX_TOOLS isn't set on lyricad"
out=$(runuser -u lyrica -- "$tools/bin/bwrap" --unshare-all --die-with-parent --ro-bind /nix/store /nix/store \
  --ro-bind "$tools" /usr --symlink usr/bin /bin --proc /proc --dev /dev -- /bin/sh -c 'echo sandbox-ok' 2>&1)
[ "$out" = sandbox-ok ] && ok "a sandbox runs as lyrica" || bad "bwrap as lyrica failed: $out"
out=$(runuser -u lyrica -- "$tools/bin/pasta" --config-net -- "$tools/bin/true" 2>&1) && ok "pasta runs as lyrica" || bad "pasta as lyrica failed: $out"
if journalctl -u lyricad -b --no-pager | grep -q "network is off for every thread"; then
  bad "the self-test failed: journalctl -u lyricad -b | grep 'network is off'"
fi
ok "the self-test hasn't refused network (it runs at unlock)"
"$tools/bin/curl" -fsS -o /dev/null http://127.0.0.1:7340/ && ok "lyricad answers on 127.0.0.1:7340" || bad "nothing answers on 127.0.0.1:7340"
echo "All checks passed."
