# Brief: Claude Code on the owner's Claude plan

**Thread:** Subscription logins (Opus). The owner asked on 2026-10-12 for
Claude logins alongside API keys. Claude plan sign-in in other apps is
forbidden (docs/briefs/subscription-logins.md), so the same day they
approved this instead: the `claude` program in her sandbox, with its
permission prompts skipped and installed by default on NixOS. How it works
is in docs/workspace.md, "Claude Code"; this brief keeps the reasons and
what's left.

## Why

Anthropic's Claude Code legal page
(code.claude.com/docs/en/legal-and-compliance) forbids other apps from
offering Claude.ai sign-in, or collecting or relaying its tokens. It
allows a person to use the unmodified `claude` program with their own
plan. So Lyrica can't *speak* through the owner's Claude plan, but she can
hand Claude Code a coding job, the way she hands work to a subagent, and
the job runs on that plan. The owner notices it in the self-editing project
and in coding threads (principle 1). It is Anthropic's agent, not one of
ours (principle 3), and adds no model-facing tool (principle 8).

## Decisions

- **She decides when to use it**, from one prompt line, like a strong
  subagent: coding and repository jobs worth the plan, never conversation.
- **The owner's own sign-in.** `claude setup-token` runs on their own
  computer, in Anthropic's flow; Lyrica only keeps the token it prints.
- **Off by default per thread**, never in a private or local-only thread.
- **No prompts of its own** (`bypassPermissions`), the owner's explicit
  choice: the sandbox is the fence, and her `bash` call already went
  through the thread's mode and approval card.
- **Installed by default.** On NixOS, nixpkgs' `claude-code` is unfree;
  it is allowed by itself in its own import, so no machine configuration
  changes. On Debian and Ubuntu, `install.sh` installs the version NixOS
  packages.
- **Its notes stay encrypted:** `CLAUDE_CONFIG_DIR` is in the thread's
  folder of the encrypted home workspace.

## Built

- Settings → Claude Code (token, Remove, Not installed) and the thread
  drawer's Claude Code switch.
- `thread_workspaces.claude_code`, user step 4; the token in `settings`.
- `Workspace.claudeCodeFor` / `claudeEnv`: the token reaches a run's
  environment only in a general thread that isn't local-only along its
  chain, with the switch on, a token saved and `api.anthropic.com`
  reachable.
- The `claude` wrapper (`core/src/workspace/claude.sh`) and the prompt line.
- Tests: `core/test/claude-code.test.ts` (who gets the token; the
  wrapper), `daemon/test/claude-code.test.ts` (routes, local-only),
  the sandbox's PATH in `core/test/sandbox.test.ts`, the prompt line in
  `extension/test/workspace.test.ts`.

## Budgets

No model-facing tool. One schema step that only adds. About 150 lines of
code and two UI rows.

## Risks

- The plan's limits are shared with the owner's Claude app, and Anthropic
  says they assume "ordinary, individual usage". Heavy automated use could
  hit them or draw attention, and Anthropic can change its rules.
- What Claude Code reads goes to Anthropic under the owner's account
  settings.

## Open

- After deploy: a real run on the owner's plan, from a general thread and
  from a thread in the self-editing project.
- A long `claude -p` job holds her `bash` call until it ends; whether jobs
  need a time limit or to run in the background is for use to show.
