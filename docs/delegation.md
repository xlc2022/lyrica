# Delegation: subagents

**Status: proposal for review.** Lyrica's own `delegate`, built on Pi's SDK,
covering the `pi-subagents` features that make sense for her. See DESIGN.md
History for why we don't use the package itself.

## What every run is

- A subagent is a Pi session inside `lyricad`, never a separate process.
- Its thread is an ordinary thread nested under its parent. It inherits "Do
  not log" and the parent's workspace settings, or narrower ones.
- Its model comes from the router, so private and local-only rules hold for
  every subagent.
- It has read-only memory (`recall`, `read_memory`) and the workspace tools
  its role allows.

## Features

| Feature | In Lyrica | Notes |
|---|---|---|
| Single delegation | yes | `delegate({ task, role?, tier? })`, which waits for the result. |
| Roles | yes | scout, researcher, reviewer, worker, oracle (adapted from `pi-subagents`, MIT). Each sets a prompt, a default tier, and whether it may write. |
| Custom roles | yes | Users add or override roles in settings: prompt, default tier, tools, read-only, thinking level. |
| Model choice | yes | By tier, following the rule. A role or a single run may name another model, if the thread's router allows it. |
| Parallel runs | yes | `tasks: [...]` in one call, up to a per-thread concurrency limit. Results come back together. |
| Chains | yes | `chain: [...]`: each step gets the previous step's output. |
| Review loop | yes | Worker, then reviewer, then worker, up to N rounds, stopping when the reviewer approves. |
| Council | yes | The same question to several models in parallel (oracle role), then one synthesis. Models come from the thread's allowed list. |
| Saved workflows | yes | Named chains, loops and councils stored in settings and run by name. |
| Background runs | yes | `background: true` returns a run ID at once. When the run finishes, its result arrives in the parent thread as a message she sees on her next turn. |
| Status, wait, stop, steer | yes | On a run ID: check it, wait for it, stop it, or send it a message mid-run. |
| Child asks parent | yes | A subagent can stop with a question ("needs a decision"). The parent, and you, see it. A background run pauses until it's answered. |
| Separate worktrees for parallel writers | yes | Two writers never share a folder. In a git repository, each parallel writer gets its own `git worktree` in the home workspace. Otherwise they run one at a time. |
| Limits | yes | Depth (default 1, configurable up to 3), concurrency, total runs per request, and a timeout per run. |
| Cost and tokens | yes | Per run and per parent thread, shown in the UI. |
| Live view | yes (Web) | Subagent threads stream live under their parent, with status, elapsed time, tokens, and stop and steer buttons. The Web thread draws it; Delegation provides the events. |
| Durable across restarts | no | A background run that is interrupted by a `lyricad` restart is marked **interrupted**. Its thread is kept and can be resumed by hand. Nothing pretends it finished. |
| External coding CLIs as subagents (Claude Code, Codex) | no, for now | They would send her work to other tools and vendors outside the router. They could come back later as endpoints. |
| Watchdog, LSP checks | no | Use the reviewer role or a review loop instead. |
| Terminal fleet views (Herdr, Ghostty) | no | Lyrica's live view is the web UI. |
| Missions and schedules | later | These belong with `lyricad`'s scheduler (sleep's), once it exists. |

## Tools

To stay within the tool budget, delegation is **one** tool:
`delegate({ action?, ... })`.
- The default action runs work.
- The other actions are `status`, `wait`, `stop`, `steer` and `answer` (reply
  to a child's question), each on a run ID.

## Honest limits

- A subagent can only be as private as its parent.
- Stopping a run stops future model calls and tool calls. A command already
  running in the sandbox is killed with it.
- Effects that already happened, such as files written or remote commands
  run, are not undone.
