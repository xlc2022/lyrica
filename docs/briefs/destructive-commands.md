# Brief: Guard against destructive commands

**Status:** Merged as #854 (33d4809). **Thread:** Guard against destructive commands.
**Branch:** `claude/project-thread-2w0npl`. **Model:** Fable.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Machines" and "Modes",
docs/workspace.md "Machines", "Project command rules" and "Approval",
docs/ux.md rows 331, 334 and 335.

## Why

On 2026-11-09 the owner asked how other coding agents guard against `rm
-rf` and how Lyrica compares. The comparison showed one honest gap: in her
own sandbox a thread in Auto mode could run `rm -rf` on a read-write grant,
`git push --force` or `git reset --hard` with no card at all, while the
suspect-command check ran only on SSH machines and only for sweeping
deletes. Codex refuses or asks about every forced `rm`; Claude Code has deny
rules. Her edits are snapshotted so they can be undone; commands can't be,
so the one place she needs a warning is right before one of these. The
owner chose three changes (01:14Z).

## In scope

1. **Suspect commands in the sandbox too.** `SUSPECT_COMMANDS` entries gain
   `everywhere`; `suspectCommand(command, where)` applies every rule on a
   machine and only the `everywhere` ones in the sandbox. New `everywhere`
   rules: any recursive `rm`; `git push` with `--force…`, `-f` or `+ref`;
   `git reset --hard`, `git checkout -- …`/`.`/`-f`, `git switch -f` or
   `--discard-changes`, `git restore` of the working tree; `git clean` (not
   a `-n` dry run); `git branch -D`, `git push --delete`, `git stash
   drop|clear`. The sweeping-delete rule is `everywhere` as well. The gate
   asks with the warning in every mode; **Allow in this thread** stores the
   exact command under `SANDBOX_ALLOW` (`:sandbox`, no machine's name has a
   colon). An Allow rule doesn't lift it, and the card offers no Always
   allow for a suspect command. Principle 6 (trust her, make review easy):
   one card, once per exact command per thread, for the handful of
   commands nothing can take back.
2. **Default Forbid rules.** `DEFAULT_COMMAND_RULES` (`git push --force`,
   `git push -f`, `rm -rf /`, `rm -fr /`), seeded by
   `WorkspaceSettings.seedCommandRules` wherever the daemon makes a
   project, only when it has no rules. Existing projects are untouched.
   Because any Forbid rule makes opaque commands ask, a new project's
   `bash script.sh` or `eval` asks in every mode; the person removes the
   rules in Project settings → Commands if that is wrong for them. A
   program named by a variable the same line plainly sets
   (`L=/…/ld-linux-x86-64.so.2; "$L" …`) is read as its value, not as
   opaque, and the dynamic loader is a wrapper (`knownValues`, `LOADER`;
   docs/workspace.md, Project command rules), so such read-only calls
   don't ask in Auto mode.
3. **`cd` on the same line.** `suspectCommand` follows `cd`/`pushd` through
   the chain (absolute, home or relative to a known folder) and resolves a
   later relative `rm` target against it, so `cd / && rm -rf *` is read as
   `rm -rf /*`. A `cd` inside `bash -c` is treated as if it affected what
   follows on the line: a false warning, never a missed one.

## Out of scope

- Snapshotting what a command deletes, or seeing inside a script she writes
  and then runs: the sandbox's mounts and the machine account are the
  boundary (DESIGN.md "Machines").
- Changing the card's layout: the sandbox reuses the remote card's warning
  and third choice.

## Docs updated

docs/workspace.md (Machines, Project command rules, Approval), DESIGN.md
(Machines), docs/contracts.md (ThreadTools, machines.ts, rules.ts),
docs/ux.md (rows 331 and 334), docs/daemon.md (command rules).

## Handoff

Done: the three changes above, with tests in `core/test/machines.test.ts`,
`core/test/command-rules.test.ts`, `extension/test/workspace.test.ts` and
`daemon/test/command-rules.test.ts`. Next: PR review and UI review of the
PR, then merge. Open: whether `git rebase` or `git commit --amend` on a
pushed branch deserve a warning too; left out, since the reflog keeps them.
