# Brief: Command rules

**Branch:** `feature/command-rules`. **Built by:** Codex on the test machine.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Modes, in the message
box" and Machines, docs/workspace.md, docs/delegation.md, docs/ux.md.

## Goal

The user tells a project once which commands run unasked (`npm test`), always
ask (`git push`) or never run (`terraform apply`), as Codex's execpolicy does.
Principles 6 (fewer prompts for what the user trusts), 2 (forbid is enforced
in the hook, never by telling the model) and 8 (no new tool or process).

## In scope

**A. Matching** (new `core/src/workspace/rules.ts`, pure). A rule is
`{ prefix, decision: "allow" | "ask" | "forbid" }`; a prefix is 1 to 8 words
of at most 64 characters, no control characters. Export `simpleCommands` from
`core/src/workspace/machines.ts` and harden it: drop every quote and backslash
inside a word (`g"i"t` is `git`); what follows `find -exec`/`-execdir`/`-ok`
is a simple command too. `decide(command, rules)` works per simple command,
so `&&`, `;`, pipes, `$( )`, backticks, subshells and `bash -c` are seen
through. **Allow** matches when the rule's words are the command's first words
after dropping `VAR=value` assignments. **Ask** and **forbid** match when the
rule's program appears at any word of a simple command and the rule's other
words follow it in order, other words between allowed, so no wrapper list is
needed: `git -C x push`, `timeout 5 git push`, `nice`, `nohup`, `command`,
`exec`, `time`, `doas`, `sudo` and `FOO=1 git push` all hit forbid `git push`.
A false hit such as `echo git push` only costs her a refusal, since forbid
never binds the user. Most words wins; at equal length
forbid beats ask beats allow. Whole command: any part forbidden → forbid; else
any asked → ask; else every part allowed → allow; else none (the mode
decides). **Opaque** parts (a program word with `$`, a backtick or `*?[`;
`eval`, `source`, `.`; a shell without `-c`) can't be checked: in a project
with any forbid rule the command asks in every mode, and no rule allows it.
`alwaysAllowPrefix(command)`, for one non-opaque simple command whose program
isn't a shell, interpreter (`python*`, `node`, `perl`, `ruby`) or wrapper: the
program, plus its first argument if a plain subcommand (`^[a-z][a-z0-9:_-]*$`),
plus the next plain word when that subcommand is `run`, `exec` or `x` (npm,
pnpm, yarn, cargo, uv, poetry, bun): `git push origin main` → `git push`,
`npm run test` → `npm run test`, `ls -la` → `ls`; else none.

**B. Storage.** A user.db step in `core/src/migrations.ts` (next free version)
adds `project_settings.command_rules TEXT NOT NULL DEFAULT '[]'` (JSON), expand
only, with a migration test from every released user schema. `Projects.set`
uses `INSERT OR REPLACE`, which would wipe it: make it an upsert. At most 100
rules a project; a prefix saved again replaces its decision.
`WorkspaceSettings` gets `commandRules`, `setCommandRules`, `addCommandRule`.

**C. The hook** (`tool_call` in `extension/src/workspace.ts`).
`WorkspaceThread` gains `project?`, set by `daemon/src/hosted.ts` from
`view.own.projectOf` and passed down by `extension/src/delegate/runs.ts`, so
subagents at any depth carry it; `forThread` adds `commandRules()`, read on
every call. For `bash`: **forbid** blocks in every mode and place, no card:
"This project's rules forbid `<prefix>`. Ask the user to run it, or do it
another way." `user_bash` (the user's own) is never checked. **Ask** asks in
every mode. **Allow** skips the prompt of Ask and Accept edits in the sandbox
only (DESIGN keeps machines free of "allow from now on"); it never lifts a
suspect command, an irreversible call or the first-call-on-a-machine ask.

**D. Always allow.** `PermissionRequest.alwaysAllow?: string` is the prefix
lyricad computed for a sandbox `bash` request in a project thread.
`PermissionAnswer.alwaysAllow?: true` makes `answer` (hosted.ts) add that
stored prefix, never one the browser sends, as an allow rule to the thread's
project (a subagent's: the same project) and allow the call.

**E. Web**, per docs/ux.md. Project settings → General, an h3 **Commands**
after This chat: a row per rule (prefix in mono, a segmented Allow | Ask |
Forbid, an ✕), **Add rule**, the page's one Save; empty "No rules: commands
ask as the mode says." The command card adds a secondary **Always allow
`<prefix>`** between Allow and Deny.

**F. Docs.** DESIGN.md (a bullet under Modes), docs/workspace.md,
delegation.md, contracts.md, ux.md (both homes and the new names), web.md,
daemon.md, briefs/design.md's status table. The guarantee, once: "A forbid rule
refuses any command she writes that contains a matching command, however
chained or wrapped; it doesn't see inside scripts or programs she runs."

## Out of scope

Rules outside a project or per thread or user; rules for `write`, `edit` or MCP
tools; allow on machines; regex or glob rules; her proposing rules.

## Done when

`npm run typecheck` and `npm test` pass, with tests: forbid holds in Auto, in
the project chat and a project thread; a project thread's subagent is refused
by forbid and skips the prompt on allow; Always allow adds the rule, and the
next match runs unasked in Ask mode; `ls && git push`, `echo $(git push)`,
`bash -c 'git push'`, `sudo git push`, `timeout 5 git push`, `FOO=1 git push`,
`git -C . push` and `g"i"t push` are
refused under forbid `git push`; Always allow on `npm run test` adds
`npm run test`; `x=git; $x push` and ask rules ask in Auto.

## Handoff notes

Built by Codex on the test machine and pushed. UI review and PR review fixes
are applied.

**Left:** UI review screenshots at 1280 and 390 px, then CI and merge.
