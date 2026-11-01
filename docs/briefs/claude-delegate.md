# Brief: Claude Code as a delegate role

**Status:** Merged as #513 (f24b269).

**Thread:** Agent loop (Opus). The owner approved this on 2026-10-23,
after asking how Claude Code fits her workflows. Today she runs
`claude -p` through her own `bash` (docs/workspace.md, "Claude Code"): the
call holds her turn, she gets back only what it printed, and nothing in
the thread shows the job. This brief makes Claude Code one of her
`delegate` roles, with a brief file in and a report file out.

## Why

- **The owner notices it** (principle 1): a Claude Code job gets a run
  card in the thread, its own status and its tokens under the run, like
  her other subagents.
- **Small models handle it** (principle 6): `delegate wait` and the
  delivered result are the polling path she already uses, instead of a
  long blocking `bash` call whose output she has to parse.
- **She stays the planner.** Claude Code still has none of her tools. She
  uses memory, threads and wake-ups between runs and hands it the coding.
- **No new tool** (principle 8): one more role in `delegate`, and the
  prompt line changes rather than grows.

## Decisions

- **Role `claude`, writes: yes.** Offered only where
  `Workspace.claudeCodeFor` allows Claude Code today: a general thread
  that isn't local-only along its chain, the switch on, a token saved, and
  `api.anthropic.com` reachable. Elsewhere the role isn't listed, and
  naming it fails the run before any thread is made, with the reason.
- **Not a Pi session.** The run's subagent is one `claude -p` process in
  the parent's sandbox, started through the same wrapper and per-run relay
  as today, so the token still never enters the sandbox. It gets a
  subagent thread (`createThread({ parent, subagent: true })`) holding its
  task and its result, so `status`, the card and continuing work as for
  any subagent. Claude Code's own transcript stays in the thread's
  encrypted `claude/` folder.
- **Background by default.** A `claude` task always runs in the
  background, since jobs worth the plan run long. `wait`, `status` and
  `stop` work as for other runs; `stop` kills the process group.
- **Brief in, report out.** The tool writes the task to `BRIEF.md` in a
  folder for the subagent under the thread's `claude/` folder, telling it
  to follow the repository's own instructions (AGENTS.md, CLAUDE.md) and
  run its checks; Claude Code reads those itself. Claude Code is told to read it
  and, before ending, write `REPORT.md` there: what changed, what's left,
  the checks it ran and their results. The run's result is `REPORT.md`,
  or Claude Code's last message (`--output-format stream-json`) when
  there's no report, as a read-only run always answers, since plan mode
  writes none. Both files stay in the encrypted workspace.
- **Continuing:** `message` on a finished run resumes that run's Claude
  Code session (`--resume <session_id>` from its JSON), with the message
  as the new prompt, and writes a fresh `REPORT.md`.
- **Narrowing:** `folders` narrows the mounts as for any writer. A
  read-only role or `readOnly: true` runs it with `--permission-mode plan`
  (Claude Code's read-only mode). `internet: false` is refused, since
  Claude Code needs Anthropic. Plan mode has no `delegate` writers, so no
  Claude Code, as today.
- **Plan limits:** a run stopped by the Claude plan's usage limit fails
  saying so, and its thread waits for the reset like any plan's (below).
- **The prompt line** (`CLAUDE_CODE_LINE`) points at the role instead of
  `bash`. The `claude` command stays on the sandbox's PATH, so a
  repository's own scripts and the person can still call it.
- **Usage** stays the "Claude Code" row in the thread's Tokens, and the run
  card shows the run's own tokens from Claude Code's answer.
- **Where it works:** in the sandbox's working folder, under the writer
  lock like any writer subagent, not in a worktree of its own.

## Built

- `extension/src/delegate/claude.ts`: the role's body (`claudeBody`),
  `BRIEF.md`/`REPORT.md`, resume, stop, the limit message.
- `runs.ts`: `Subagent` works through a `SubagentBody` (Pi's or Claude
  Code's); `Delegation.claudeCode`; the role refused where it's off or
  offline. `roles.ts`: the built-in `claude` role, which a user's own
  role can't replace. `tool.ts`: listed only where it's on; always in the
  background.
- `claude.sh` keeps a mode the call gives (plan mode for a read-only run);
  `ExecutionTarget.run` takes a `cwd`.
- `CLAUDE_CODE_LINE` points at the role.
- Tests: `extension/test/claude-delegate.test.ts`, the wrapper's mode in
  `core/test/claude-code.test.ts`.

## Built after (the owner's word, 2026-10-24)

- **Live output:** `--output-format stream-json`; its words, tool calls and
  cut tool results go into the subagent's thread as they come, and the run
  card reloads on each.
- **The Claude plan's wait:** the relay reports Anthropic's usage-limit
  refusal with its reset; a stopped run makes its parent wait with the
  plan-limit card and notification ("Claude Code"), and Fall back hands
  the job to the coder role. The claude role is refused until the reset.

## Built after (the owner's word, 2026-10-31)

- **Any job the person asks Claude for.** The owner asked for a Claude Opus
  second opinion and she ran the oracle on the paid `claude-opus-latest`,
  since a step's model is matched in words against the thread's models and
  Claude Code isn't one. Now a model that means Claude in words
  (`meansClaude`) runs the step on Claude Code in the role it asked for,
  read-only in plan mode where the role is, with `--model` from the alias
  (docs/delegation.md, "Claude Code"). A Claude on a paid endpoint named in
  words is refused until the person singles it out, or she names its whole
  label after checking with them. A read-only run answers in its last
  message, since plan mode writes no report.

## Out of scope

- Her tools inside Claude Code through a local MCP server (option 3 in the
  thread): it would cross the private-memory boundary and needs its own
  design.
- Claude as one of her chat models on the Claude plan: Anthropic forbids
  other apps from using its sign-in (docs/briefs/claude-code.md).
