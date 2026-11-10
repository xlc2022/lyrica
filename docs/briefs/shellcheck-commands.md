# Brief: ShellCheck before her commands run

**Status:** In review. **Thread:** Check Lyrica's bash commands with shellcheck.
**Branch:** `claude/project-thread-0zct1l`. **Model:** Opus.
**Read first:** AGENTS.md, docs/briefs/destructive-commands.md, docs/workspace.md
"Machines".

## Why

On 2026-11-10 the owner asked for ShellCheck inside Lyrica, so a bash call
she writes wrong (bad quoting, an unset variable in an `rm` path, a broken
glob) is caught before it runs and deletes something. The destructive guard
(#854) asks before a recursive delete, but it asks the person about what the
command says, not whether it says what she meant: `rm -rf "$build"/*` with
`build` never set is `rm -rf /*` once it runs, and a card reading
`rm -rf "$build"/*` doesn't show that. Principle 6: trust her, and make the
mistake hers to fix before anyone is asked.

## In scope

1. `malformedCommand(command)` in `core/src/workspace/shellcheck.ts`, called
   by the workspace gate for every `bash` call, sandbox or machine, after
   the Forbid rules and before the mode and any card. A hit is a refusal
   carrying ShellCheck's line, column, message and code.
2. What blocks: any parse error; and in a command that deletes or moves
   files, or a `cd` before one, SC2086, SC2046, SC2048, SC2068, SC2115,
   SC2114, SC2154, SC2164. Nothing else, and no warn-only tier: a warning
   after the command ran is too late, and one before it is a refusal anyway.
   She overrides a false hit with a `# shellcheck disable=` line, which the
   card shows.
3. Without ShellCheck (or on a failure or past 3 s) the check is skipped.
   install.sh installs it on Debian; NixOS puts `pkgs.shellcheck` on
   lyricad's PATH and in the default sandbox tools. CI installs it.
4. The shell's keywords (`then`, `do`, `!`…) are looked through, which also
   closes a gap in the suspect-command check (`if …; then rm -rf x; fi`
   wasn't read as `rm`).

## Out of scope

- A script she writes to a file and then runs, or a here-document fed to
  `bash`: ShellCheck sees only the call's own text.
- Commands the person types with `!`.

## Docs updated

docs/workspace.md (Machines), DESIGN.md (Machines), docs/contracts.md
(ThreadTools, machines.ts, shellcheck.ts), docs/guides/getting-started.md
(install.sh's packages, updates install no packages).

## Handoff

Done: the above, with tests in `core/test/shellcheck.test.ts` and
`extension/test/workspace.test.ts`. Next: PR review, then merge. Open:
whether a later release should check scripts she runs from a file.
