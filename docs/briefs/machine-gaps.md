# Brief: Machine gaps (background commands, root steps, logging in as the user, model host install)

**Status:** Merged: A as #444 (212ca15), B as #450 (9a007f4), D as #453 (681407a), C as #454 (2536a81). Handoff notes below are history.

**Branch:** `claude/project-thread-46papz`, one pull request at a time.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md (Machines), docs/workspace.md
(Where the tools run, Machines, Approval, Tools), docs/delegation.md (child
wakes), docs/daemon.md (Subagents, child-thread notices), docs/ux.md,
host/README.md.

## Goal

A Remote Control session installed the model host on a shared workstation
that a friend of the user's mainly uses. Lyrica could already do each step: files and commands over SSH,
images, the tailnet, pairing, asking before risky steps. What she couldn't do
was the job around them:

- a tens-of-GB image download held her turn for its whole length;
- every root step went back to the user as a script to read and run, and she
  had no card for that;
- the machine had to be set up with root before she could reach it at all;
- nothing told her how the host install goes.

These four pieces move that job to her. Principles: 6 (the user is away, so
long work mustn't hold a turn and a root step must wait on a card, not a
5-minute prompt), 2 (the root step stays in the user's hands structurally:
she never runs sudo with a password and never writes sudoers), 8 (one new
tool each for A and B, prompt lines only where the thread has a machine).

## A. Background commands

- `bash` takes `background: true`. The call goes through the same approval as
  any `bash` (mode, machine limit, suspect commands, command rules), then
  starts and returns at once with a job id (`j1`, `j2`, … per thread), where
  it runs and the command. Her turn goes on or ends.
- Default time limit 4 hours (`JOB_LIMITS.timeoutS`), most 24 hours; at the
  limit the job is killed and reported as timed out. At most 4 running jobs
  per thread; a fifth is refused with the running ones listed.
- Jobs live in `lyricad`'s memory, in core's `Jobs` (`core/src/workspace/jobs.ts`),
  owned by `Workspace`, so they outlive the thread's session (which is
  disposed when idle). Output is what the target delivers (capped as for any
  command: the first 20 KB live, the end once it ends), at most 64 KB a job,
  in memory only. Nothing goes to disk.
- A new `jobs` tool: `list` (this thread's jobs: id, where, command, state,
  how long), `output` (a job's kept output so far), `stop` (kills it). Ended
  jobs are kept until 10 newer ones have ended in that thread.
- When a job ends (exit, killed, timed out, stopped by `lyricad`; a job she
  stopped herself leaves none, since 2026-11-04), `lyricad` delivers a
  notice into the thread (`status: "job"`), the same encrypted path a
  background subagent's result takes, with the exit code, how long it ran and
  its last 40 lines. An idle thread is woken once to carry on, through the
  same guards as a wake-up (a paused project or a child past the at-once
  limit waits; the notice stays in the thread). A busy thread gets it as a
  follow-up.
- Lock, a memory wipe and forgetting the thread stop its jobs; shutdown kills
  them with `lyricad` (sandboxes run with `--die-with-parent`, and an SSH
  job's helper exits with `lyricad`). A restart loses the record, so a job
  that was running then is never reported.
- Plan mode has neither `bash` nor `jobs`.
- Web: the notice reads **Background command** (`NOTICE_HEADS.job`), its
  text as given. No new control.

## B. Root steps on a card

- New tool `run_as_root({ machine, path, why, sudoers? })`. `path` is a
  script she already wrote on that machine with `write`. The tool reads it
  there (at most 16 KB), takes its SHA-256 and puts a card in the thread:
  **Run as root on <machine>**, the command to run, the hash, the script
  itself and her `why`. Options: **Done** (recommended) and **Not now**. A
  typed answer counts, as on any question card, so the user can paste the
  last lines.
- The command on the card copies the script, checks the copy's hash and
  runs the copy (docs/workspace.md, "Root steps"), so a script changed
  after the card was made, or during the run, doesn't reach root.
- It is a question card (one open per thread, Waiting on you, Notifications,
  push, answered in words or by tap), stored like `threads ask`; the card's
  words come from the tool's stored call and result, never from her text.
- `sudoers`: when the same root command will be needed again, she may offer
  lines for `/etc/sudoers.d/lyrica` instead. `checkSudoers` (core, pure)
  refuses a line that isn't `<account> ALL=(root) NOPASSWD: <program in a
  system folder> <fixed arguments, or "">`, or that holds a wildcard, a
  comment, `ALL`, a path she can write, a shell, an editor, an interpreter
  or a wrapper (the full list is in docs/workspace.md). It adds a warning to a
  line whose program can reach root anyway (package managers, `docker`,
  `systemctl edit`/`link`, `chmod`, `chown`, `cp`, `mv`, `tee`, `dd`,
  `install`, `rsync`, `tar`, `mount`). The card shows the lines, the warnings
  and, since the remote control tests (2026-11-04), the command that adds
  them: checked by `visudo -c` before it replaces the file, so the person
  pastes one command instead of opening visudo. She never writes
  sudoers herself: the existing floor refuses `/etc/sudoers*` to `write` and
  `edit`.
- Off in Plan mode. On a machine the tool counts as a `read` for the mode.

## D. Logging in as the user

- A machine may log in as the user's own account (`as_user`, `user.db` step
  18). Adding a machine offers **Account**: **Her own** (default) or **Mine**.
- Mine shows the warnings, and saving needs the machine's name typed:
  - she can read and change everything that account can: files, SSH keys,
    browser profiles, signed-in tools and their tokens;
  - groups count: `docker`, `sudo`, `wheel`, `lxd` membership is effectively
    root, and a cached sudo password works for her too;
  - commands aren't path-checked, so she could change your own
    `authorized_keys`;
  - in a general thread on a cloud model, what she reads there can reach
    the cloud.
- Allowed for general and private machines alike (the user's decision). A
  private machine keeps its rules: private threads only, so no cloud model.
- Setup for Mine needs no root: append the key line (still `restrict,from=`)
  to `~/.ssh/authorized_keys`. The machine starts at Ask, as every machine
  does. Its row carries a **Your account** badge, and her prompt line says
  the machine logs in as the person's own account.
- Changes DESIGN.md (each machine uses a dedicated account) and
  docs/workspace.md: PR review.
- From the remote control tests (2026-11-04): her own account added as Mine
  can't log in (her setup's Match block), so the test now says why; and a
  `write` or `edit` on the floor is refused before any card, not after it.
- Also from that run: a card nobody answered in time told her the person
  declined; now her result says nobody answered, so she says it timed out.
- And (2026-11-05): the setup block wrote `/etc/ssh/authorized_keys/<account>`
  and `sshd_config.d/lyrica.conf` over, so a second machine on the same
  account replaced the first's key (the tests' step 12 did exactly that, and
  lunasa-slave lost its key). It now adds the line beside any there and
  writes `lyrica-<account>.conf`; Replace key shows the block again when her
  login fails.
- Phase 2 (2026-11-10): the owner asked for the user's own Proxmox account as
  an option, with instructions. Done the same day: Account: Mine for Proxmox,
  a User field, a setup block for a separated token on that user, warnings,
  and the token checked against the user at Confirm.
- Phase 2's run on a real node (same day) passed but for two bugs, both
  fixed: `bash` and `read` on a Proxmox machine said it "isn't one of this
  thread's machines", so she asked the person to add a machine they had (the
  refusal now names the `proxmox` tool); and a Proxmox machine's row never
  showed a state or the Your account pill, since her calls recorded none and
  the API left both out. The owner also asked that she know how to add a
  machine when asked in chat: the built-in `add-machine` skill. Noticed on
  the way: a subagent that kept its parent's machines was told of Proxmox
  machines with no tool for them, and a custom role listing `proxmox` got
  the tool; subagents now get neither.
- Found reading that work (same day): a private machine whose address left
  the user's network was refused with "confirm it in Settings", and Settings
  had nothing to confirm: the row's **Use anyway** showed only once the
  machine was already accepted. A private Git account and MCP server had the
  same gap. The refusal is now each one's state, and Use anyway shows while
  it stands. The Add repository picker and Replace token (Git and MCP) also
  sent a private token without that check; they check first now.
- Phase 3, on the VM with no GPU (same day): asked to make it a model host,
  she read the skill, ran its checks as one read-only command, said nothing
  can run there and stopped, with nothing changed. Told to install anyway,
  she found the installer's `--no-gpu` in the operator guide and offered it
  with a question card; it is a test mode that serves no models, so the
  skill now says so and that it isn't a way round. The skill's "read the
  guide in the clone" also sent her looking for a clone she didn't have; it
  now says which clone. The install on a real GPU machine hasn't run yet.

## C. Model host install from a machine

- A built-in skill, `model-host` (`extension/src/model-host.md`), listed
  while the thread has an SSH machine and read with `read_memory`
  `s:model-host`: no new tool, so no tool-definition growth. It follows the
  steps of a hand-run install: check the card, driver and
  free disk; say which host images can run there; list the system-wide
  changes for a yes; hand the root steps over with `run_as_root`; start the
  image build and pull in the background (A); smoke test; pause; give the
  pairing code. On a shared machine, pause the host after testing and check
  that no container holds GPU memory.
- No change to `host/`.

## Out of scope

- An agent on the machine that dials out (SSH stays the only way in).
- Answering a sudo password prompt.
- Unloading text models after idle minutes (dropped by the user).
- Claude Code or Codex running on a machine.

## Handoff

Done: brief; A (background commands) merged in #444. B (root steps)
built after it, merged in #450 (stricter sudoers checks and a checked copy
of the script after review). Each grew the tool definitions by about 200
tokens; since #451 `daemon/test/context.test.ts` sizes its windows from
her first turn, so tool text needs no window change there. D (own account,
user step 18) merged in #453 (the account is fixed once added; root is
refused). C (the `model-host` built-in skill) merged in #454. All four are
built; none has run against a real GPU machine yet.
