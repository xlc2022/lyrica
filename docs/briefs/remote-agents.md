# Brief: Coding agents on a machine, beside SSH

**Status:** Design only, nothing built. Waiting on the user's decisions
(below). Facts checked 2026-11-18 against the sources at the end.

**Read first:** AGENTS.md, PRINCIPLES.md (2, 6, 8), DESIGN.md "Machines"
(the Agentless rule), docs/workspace.md ("Machines", "Root steps",
"Claude Code", "Approval"), docs/delegation.md ("Roles", "Claude Code"),
[claude-delegate.md](claude-delegate.md), [machines.md](machines.md).

## The question

Claude Code, Codex and now LM Studio's Bionic each have a "Remote Control":
an agent runs on one computer and is steered from another. Lyrica works on
the user's other computers over SSH, one command at a time, each through
her mode and her approval cards. Should she also be able to hand a whole
job to an agent already on the machine, and if so, how?

## What each one is (checked 2026-11-18)

| | Claude Code Remote Control | Codex remote control | LM Studio Bionic Agent Remote Control |
| --- | --- | --- | --- |
| Shipped | Research preview; `claude remote-control`, `--rc`, `/rc` | `codex remote-control`, Codex CLI 0.130 (2026-05-08), experimental | Bionic 1.2.1, announced 2026-11-16 |
| Client | claude.ai/code and the Claude app only | The ChatGPT app's Remote (Codex) section | Another Bionic app, `@`-mention a device |
| Transport | Outbound HTTPS to the Anthropic API, which routes messages; no inbound port; transcript stored on Anthropic's servers | The app-server with its `remote_control` feature and local listeners off; the relay itself isn't documented | LM Link: end-to-end encrypted, built with Tailscale |
| Sign-in | A Claude plan's own sign-in. API keys aren't supported, and it's unavailable when `ANTHROPIC_BASE_URL` points elsewhere | The same ChatGPT account on both ends | A device network in Bionic; each host turns on "Allow remote agent control" |
| Approvals | Shown in the remote client | Shown on the phone: commands, file changes, network, connected tools | Not documented |
| Headless | Server mode, `--permission-mode`, `--spawn worktree` | Yes, it is headless | `llmster` daemon |
| Can Lyrica drive it? | **No.** No public client API, and Anthropic forbids third-party apps from relaying Claude plan credentials | **Not documented.** Pairing is in OpenAI's apps | **Not yet.** A beta "launch assistants headlessly and stream progress" API exists; its shape isn't published |

The rumour is right: LM Studio added it to Bionic, which is LM Studio's
separate agent app. Which systems Bionic runs on isn't stated in its docs.

**What they share:** each is built for its vendor's own app as the client,
through the vendor's relay or mesh. Lyrica can't be that client. But each
agent also has a documented local interface a program can drive, and Lyrica
already has an authenticated, host-key-checked pipe to every machine: SSH.

- **Codex app-server:** JSON-RPC 2.0 over stdio (WebSocket is experimental
  and unsupported). Approvals arrive as server requests:
  `item/commandExecution/requestApproval` (with `command`, `cwd`,
  `reason`), `item/fileChange/requestApproval`, and
  `item/permissions/requestApproval`. `approvalPolicy` (`on-request`,
  `never`) and `sandboxPolicy` (`readOnly`, `workspaceWrite`) are set per
  thread or turn. Codex runs on local models with `--oss`
  (`oss_provider = "lmstudio"` or `"ollama"`) or a `[model_providers.<id>]`
  with its own `base_url`.
- **Claude Code print mode:** `claude -p --output-format stream-json`,
  which Lyrica's `claude` role already uses in her sandbox. Permission
  prompts go to an Agent SDK host's `canUseTool` or a
  `--permission-prompt-tool` MCP tool; `--permission-prompts none` denies
  them. Channels can relay prompts too, but only in an interactive session
  with a development flag during the preview, so they don't fit.
- **Bionic:** nothing documented to build on yet.

## Recommendation

**Keep SSH as the base layer, and add "an agent on a machine" that runs
over it.** Lyrica never uses the vendors' relays. She starts the agent's
programmatic interface as one SSH command on the machine and talks to it on
that command's stdin and stdout. Vendor Remote Control stays the user's own
tool from their phone, and nothing here changes it.

Why this shape:

- **The trust stays where it is.** The same host-key check, `restrict` key,
  helper sandbox and account limits as every machine command. The agent
  runs as the machine's account, so it can do exactly what her `bash` there
  can do, no more.
- **Approvals can stay hers.** Codex sends each command with its folder
  before it runs, which is exactly what her machine cards are bound to
  (machine, command, folder). Her suspect-command check can read it too.
- **The sign-in stays the vendor's.** The user signs in to Claude Code or
  Codex on the machine with the vendor's own flow. Lyrica never holds,
  relays or sees those credentials, which is what Anthropic's terms ask.
- **No new tool** (principle 8). `delegate` gains a `machine` argument for
  the agent roles; `claude` exists, `codex` would be added. No new
  process in `lyricad`: the SSH helper per connection is already there.
- **Long jobs leave her context** (principle 6). She sends a brief and gets
  a report, as the `claude` role does today, instead of paying for every
  round trip.

### How it would work

1. **The machine drawer** shows an **Agent** row once Lyrica has found
   `claude` or `codex` on the machine's PATH (one `command -v` at
   connection). The user turns each on per machine; off by default. It
   needs a home in docs/ux.md before it's built, and the user's approval
   of the UI first.
2. **A run** is `delegate({ role: "codex" | "claude", machine, task })`.
   Lyrica writes the brief into the run's folder on the machine and starts
   the agent there in the folder the run names, as one SSH exec with no pty.
   It shows a run card and its tokens like any subagent, read from the
   agent's own stream.
3. **The machine's limit sets the agent's mode:**

   | Machine limit | Codex | Claude Code |
   | --- | --- | --- |
   | Ask | `approvalPolicy: on-request`, read-only sandbox; every command and file change becomes her card | Plan mode (read-only), as her read-only runs are today |
   | Accept edits | File changes accepted; every command is her card | `acceptEdits`; commands go to her card if the permission-prompt route works (decision 2) |
   | Auto | `approvalPolicy: never`, workspace-write | Its own `auto` mode |

   In every mode, a Codex command that matches her suspect list still
   comes to her as a card, and so does the first agent run on a machine in
   a turn after something ran elsewhere, as for her own commands.
4. **When the connection drops** the run stops, and `message` resumes it
   (`thread/resume` in Codex, `--resume` in Claude Code). Detaching jobs
   that outlive the connection is a later step.

### The hard rules

- **Local-only thread:** Claude Code is refused, as it is in the sandbox
  today. Codex is allowed only when Lyrica sets the model provider herself
  on the command line (`-c model_provider=…`) to one of the user's own
  model hosts on the LAN or tailnet, never trusting the machine's own
  config. Otherwise it is refused.
- **Private memory never reaches the cloud:** a cloud agent runs only from a
  general thread on a general machine. A private machine may run only a
  local-model Codex. The brief she writes is all that leaves the thread,
  as with the `claude` role today.
- **No plaintext memory:** both agents write their transcripts to the
  machine's disk in plaintext (`~/.claude/projects`, `~/.codex/sessions`),
  where Lyrica can't encrypt them. Today's sandbox Claude Code keeps its
  transcripts in her encrypted workspace. This needs the user's call
  (decision 3).
- **Agentless (DESIGN.md "Machines"):** nothing of Lyrica's is installed;
  she uses an agent the user already installed and signed in to. DESIGN.md
  would still say so in the same PR that builds it.

## Open decisions for the user

1. **Build it, and which agent first?** Recommended: Codex first, because
   its approvals map onto her cards one to one and it can run local
   models. Claude Code second.
2. **Claude Code's approvals.** Either Lyrica answers its permission prompts
   through the Agent SDK's `canUseTool`, with the process started over SSH
   (to be proved in a spike before building), or Claude Code on a machine
   only ever runs in plan mode or its own `auto` mode, with no per-command
   cards. Recommended: try the spike; fall back to the mode mapping.
3. **Transcripts on the machine.** Accept that a general machine keeps the
   agent's plaintext transcript of the brief and the work (it is that
   machine's own work), or point the agent's home at a per-run folder in
   memory (`$XDG_RUNTIME_DIR`) and delete it after, which also means
   signing in again per run. Recommended: accept it on general machines;
   refuse private machines anyway.
4. **Auto means trusting the agent's own fence.** At Auto, Claude Code's
   commands never reach her suspect check. Recommended: accept, the same
   trade the user made for Claude Code in the sandbox.
5. **LM Studio Bionic.** Recommended: wait until its headless API and
   remote approvals are documented, then look again. It would suit
   local-only threads.

## Out of scope

- Lyrica as a client of claude.ai/code, the ChatGPT app or Bionic.
- A Lyrica agent installed on machines.
- Jobs that outlive the SSH connection.

## Sources (read 2026-11-18)

- Claude Code Remote Control: https://code.claude.com/docs/en/remote-control
  (requirements, "Connection and security", server mode flags).
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
  (`--permission-prompt-tool`, `--permission-prompts`, stream-json).
- Agent SDK permissions: https://code.claude.com/docs/en/agent-sdk/permissions
  (`canUseTool`).
- Channels reference: https://code.claude.com/docs/en/channels-reference
  ("Relay permission prompts", "Test during the research preview").
- Claude Code legal: https://code.claude.com/docs/en/legal-and-compliance
  (no third-party relaying of Claude plan credentials; the unmodified
  binary with the user's own sign-in is allowed).
- Codex app-server: https://learn.chatgpt.com/docs/app-server (moved from
  developers.openai.com/codex/app-server): transports, approval requests,
  WebSocket auth.
- `codex remote-control`: openai/codex PR #21424,
  https://github.com/openai/codex/pull/21424, and the Codex changelog
  announcement of 0.130.0. The relay behind it isn't in OpenAI's docs.
- Codex Remote in the ChatGPT app:
  https://developers.openai.com/blog/mastering-codex-remote-for-engineering
- Codex local models: https://developers.openai.com/codex/config-advanced
  (`--oss`, `oss_provider`, `model_providers`).
- LM Studio: https://lmstudio.ai/blog/agent-remote-control,
  https://lmstudio.ai/changelog (Bionic 1.2.1, 2026-11-16),
  https://lmstudio.ai/docs/bionic.

## Handoff note

Done: research and this design. Next: the user's answers to the
decisions above; then, if yes, a Codex spike (app-server over an SSH exec
to a test machine, one approval round trip onto a card) before any brief
for building it.
