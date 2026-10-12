#!/bin/sh
# gh and tea in a sandbox run with repositories (docs/workspace.md, "Git
# accounts and repositories"). Mounted as /run/lyrica/bin/gh and .../tea,
# first on PATH. Each picks the one account whose repository this clone's
# origin is, from the LYRICA_GIT_* environment, so two accounts on one host
# never mix; outside such a clone the client runs with no token. tea reads
# logins only from a file, so that file is written under /tmp, the run's own
# tmpfs, and is gone when the run ends.
tool=${0##*/}
PATH=${PATH#/run/lyrica/bin:}
export PATH
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_HOST
export XDG_CONFIG_HOME=/tmp/lyrica-forge
rm -rf "$XDG_CONFIG_HOME"
mkdir -p -m 700 "$XDG_CONFIG_HOME"
export GH_CONFIG_DIR="$XDG_CONFIG_HOME/gh"

origin=$(git remote get-url origin 2>/dev/null) || origin=
origin=${origin#https://}
case $origin in *@*/*) origin=${origin#*@} ;; esac
origin=${origin%/}
origin=${origin%.git}
origin=$(printf %s "$origin" | tr 'A-Z' 'a-z')

i=0
while [ -n "$origin" ] && [ "$i" -lt "${LYRICA_GIT_COUNT:-0}" ]; do
  eval "repo=\$LYRICA_GIT_REPO_$i kind=\$LYRICA_GIT_KIND_$i"
  if [ "$repo" = "$origin" ]; then
    eval "token=\$LYRICA_GIT_TOKEN_$i user=\$LYRICA_GIT_USER_$i"
    host=${repo%%/*}
    if [ "$tool" = gh ] && [ "$kind" = github ]; then
      if [ "$host" = github.com ]; then export GH_TOKEN="$token"
      else export GH_HOST="$host" GH_ENTERPRISE_TOKEN="$token"; fi
    elif [ "$tool" = tea ] && { [ "$kind" = gitea ] || [ "$kind" = forgejo ]; }; then
      mkdir -p -m 700 "$XDG_CONFIG_HOME/tea"
      umask 077
      quoted=$(printf %s "$token" | sed "s/'/''/g")
      printf "logins:\n- name: '%s'\n  url: 'https://%s'\n  token: '%s'\n  user: '%s'\n  default: true\n" \
        "$host" "$host" "$quoted" "$user" > "$XDG_CONFIG_HOME/tea/config.yml"
    fi
    break
  fi
  i=$((i + 1))
done
exec "$tool" "$@"
