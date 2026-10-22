# Brief: Machine gaps (background commands, root steps, logging in as the user, model host install)

**Status:** Building. Four pull requests, in this order: A, B, D, C.

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
- When a job ends (exit, killed, timed out, stopped), `lyricad` delivers a
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
- The command on the card checks the hash before running: `echo '<sha256>
  <path>' | sha256sum -c - && sudo bash <path>`, so a script changed after
  the card was made doesn't run.
- It is a question card (one open per thread, Waiting on you, Notifications,
  push, answered in words or by tap), stored like `threads ask`; the card's
  words come from the tool's stored call and result, never from her text.
- `sudoers`: when the same root command will be needed again, she may offer
  lines for `/etc/sudoers.d/lyrica` instead. `checkSudoers` (core, pure)
  refuses a line that isn't `<account> ALL=(root) NOPASSWD: /absolute/program
  [fixed arguments]`, or that holds `*`, `?`, `[`, `ALL` as the command, a
  shell, an editor, an interpreter, `sudo` or `su`. It adds a warning to a
  line whose program can reach root anyway (package managers, `docker`,
  `systemctl edit`/`link`, `chmod`, `chown`, `cp`, `mv`, `tee`, `dd`,
  `install`, `rsync`, `tar`, `mount`). The card shows the lines, the warnings
  and `visudo -f /etc/sudoers.d/lyrica` then `visudo -c`. She never writes
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

## C. Model host install from a machine

- A guide (`extension/src/host-install.md`), offered by one prompt line when
  the thread has an SSH machine, and read with `read_guide({ name:
  "model-host" })`. It follows the steps of a hand-run install: check the card, driver and
  free disk; say which host images can run there; list the system-wide
  changes for a yes; get the code onto the machine (a read-only deploy key
  the user adds); hand the root steps over with `run_as_root`; start the
  image pull in the background (A); smoke test; pause; show the pairing
  code. On a shared machine, pause the host after testing and check that no
  container holds GPU memory.
- No change to `host/`.

## Out of scope

- An agent on the machine that dials out (SSH stays the only way in).
- Answering a sudo password prompt.
- Unloading text models after idle minutes (dropped by the user).
- Claude Code or Codex running on a machine.

## Handoff

Done: brief; A (background commands) in its pull request. The tool
definitions grew by about 200 tokens, so `daemon/test/context.test.ts`'s
edge-compaction window went from 12,500 to 12,700. Next: B.
