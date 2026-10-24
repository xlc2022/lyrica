#!/bin/sh
# Claude Code in a sandbox run of a thread that has it on (docs/workspace.md,
# "Claude Code"). Mounted as /run/lyrica/bin/claude, first on PATH. Runs the
# unmodified program. Its requests go to this run's relay in lyricad
# (ANTHROPIC_BASE_URL), and CLAUDE_CODE_OAUTH_TOKEN holds only the run's
# capability: the user's token never enters the sandbox. Its settings,
# transcripts and notes go to the thread's own folder for them
# (/run/lyrica/claude), in the encrypted home workspace but outside the
# folder its children and subagents see, so `claude -c` continues the
# thread's last job. It asks none of its own permission
# questions: the sandbox is the fence, and her bash call already went through
# the thread's mode.
real=
IFS=:
for dir in $PATH; do
  [ "$dir" = /run/lyrica/bin ] && continue
  if [ -x "$dir/claude" ]; then real=$dir/claude; break; fi
done
unset IFS
if [ -z "$real" ]; then
  echo "claude: Claude Code isn't installed on this server (docs/workspace.md, \"Claude Code\")" >&2
  exit 127
fi
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
export CLAUDE_CONFIG_DIR=/run/lyrica/claude
# Claude Code skips its permission prompts as root only when told it's sandboxed: she runs as lyricad's own uid, which may be root.
export IS_SANDBOX=1
# No update checks, telemetry or error reports: only the calls its work needs.
export DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# A read-only delegate run asks for Claude Code's own plan mode instead.
for arg in "$@"; do
  [ "$arg" = --permission-mode ] && exec "$real" "$@"
done
exec "$real" --permission-mode bypassPermissions "$@"
