# Brief: Machines

**Thread:** Machines. **Branch:** `feature/machines`. **Model:** Opus.
**Runs alongside:** SSH helper ([ssh-helper.md](ssh-helper.md)), which
changes only `core/src/workspace/ssh.ts`'s transport; agree on the seam
before either touches it. **Followed by:** Proxmox and Web: machines.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Machines" and
"Modes, in the message box", docs/contracts.md `core/workspace` (the
planned Machines entries), docs/workspace.md, docs/daemon.md "Permission
prompts", and `/mnt/project-files/remote/proposal.md` for the reasoning.

## Goal

Lyrica works on the user's other computers over SSH the way she works in her
sandbox, confined by each machine's own account, starting at Ask on every
machine and loosened one at a time (principle 6, inside principle 2's
structural boundaries). The SSH targets that exist become machines.

## In scope

1. **Machines replace SSH targets** (`core/src/workspace/settings.ts`): the
   `ssh_targets` table gains `kind` (`ssh` now; `proxmox` is added by the
   Proxmox brief), `pool`, `limit` (`ask` | `acceptEdits` | `auto`, new
   machines `ask`), `off_network` and `last_used`. Existing rows migrate in
   place: `pool` general, `limit` ask. `addMachine(cfg, confirmedHostKey)`
   replaces `addSsh` and refuses a machine with no confirmed host key;
   `probeHostKey(address)` connects only to read the key and returns its
   fingerprint. A private machine whose address resolves outside the LAN,
   loopback and tailnet ranges (reuse the model endpoints' check) is
   accepted with `offNetwork: true`, which the UI shows and warns about.
   The resolved address is checked again on every connection and the flag
   updated; a private machine that has newly gone off network is refused
   until the user confirms again (`confirmOffNetwork(name)`), so a DNS change
   can't bypass the warning. `setMachinePool(name, pool)` removes the
   machine from every thread that grants it, so a machine is never reached
   from both pools; the UI warns before moving Private to General.
2. **Threads grant machines.** `ThreadWorkspace.target` becomes
   `machines: string[]`; the sandbox is always available. `setThread` refuses
   a machine of the other pool. `inheritSettings` gives a child a subset of
   its parent's machines and never more. `targetFor(t, machine?)`.
3. **Tools.** `read`, `write`, `edit` and `bash` take an optional `machine`
   argument naming a granted machine; the `workspace` prompt section lists
   the thread's machines with their limits. No new tool.
4. **Modes on a machine.** A call's mode is
   `stricterMode(effective(thread).mode, machine.limit)`, read on every call.
   Plan mode allows `read` on a machine and refuses the rest.
5. **Approvals bound to what was shown.** A permission request for a machine
   carries `{ machine, command | path, cwd }`; the answer applies to exactly
   that, anything different is denied, and a request still open when the
   turn ends is void.
6. **Suspect commands.** An exported `SUSPECT_COMMANDS` list (short; the
   patterns in DESIGN.md "Machines") checked on every `bash` call to a
   machine, in every mode. A match asks with `suspect: true` and the warning
   sentence. The answer may carry `allowInThread: true`, which stores that
   exact command in the thread's row so it no longer asks there, and only
   there. Document the list in docs/workspace.md and say it is a warning
   layer, not the boundary.
7. **Another place in the same turn.** The first call on a machine in a
   turn asks, whatever the modes, if anything earlier in the turn ran
   somewhere else: the sandbox or another machine.
8. **The floor.** `write` and `edit` on a machine refuse paths resolving to
   `~/.ssh/`, `/etc/ssh/` and `/etc/sudoers*` in every mode.
9. **The connection.** Strict key exchange required (`ssh2`'s
   `kex-strict-*`), no agent, no forwarding, as now. Output is capped as in
   the sandbox, stripped of terminal control sequences, and private-key
   blocks are replaced with `[private key removed]` before Pi sees them.
10. **Setup text.** The `authorized_keys` line Lyrica gives carries
    `restrict,from="<Lyrica's addresses>"`, and the Add machine page and
    `lyrica admin ssh add` print the two setup steps for the machine: the
    root-owned keys file (`AuthorizedKeysFile /etc/ssh/authorized_keys/%u`)
    and an exact-argv sudoers example. CLI: `lyrica admin ssh add` takes
    `--pool` and `--limit`, prints the fingerprint it sees and asks to
    confirm it.
11. **API** (`daemon/src/api.ts`, `routes.ts`): `/api/u/:userId/ssh` becomes
    `/machines`; `PATCH …/machines/:name` for pool (which drops the
    machine's grants from every thread), limit, root and address;
    `POST …/machines/:name/confirm-off-network`;
    `POST …/machines/probe`; `POST …/machines/:name/key` to replace the key.
    Thread settings carry `machines`. Permission events carry `machine` and
    `suspect`; answers may carry `allowInThread`.
12. **Docs:** docs/workspace.md (what exists, including the suspect list and
    the setup steps), docs/daemon.md, docs/contracts.md (the planned entries
    become current).

## Out of scope

- The web UI (Web: machines) and the Proxmox kind (Proxmox).
- Shared machines for other users, short-lived certificates, an installed
  agent.
- Any change to how the sandbox works.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests show that: a private thread can't grant a general machine and vice
  versa; a machine's limit holds at every depth and when a parent is
  narrowed later; a suspect command asks in Auto, and a per-thread allow
  reaches no other thread; an approval for one command doesn't cover a
  different one; an approval still pending at the turn's end is void, and
  with nobody to answer the call is denied; the first call on a machine
  after a sandbox command in the same turn asks in Auto; changing a
  machine's pool removes it from the threads that granted it; a private
  machine whose address newly resolves off network is refused until
  confirmed; a changed host key fails with no fallback; Plan mode reads
  on a machine and can't write or run; the floor refuses `~/.ssh/` in Auto;
  a private-key block in output is masked. SSH tests run against a local
  `sshd` in CI as the existing ones do.
- docs/workspace.md describes what exists, and the PR lists its contract
  changes.

## After merging

Tell the standing Operator docs thread (the owner's rule, 2026-10-11) by
cross-session message what changed that an operator does by hand (setup
steps, commands, config) and where, in addition to the merge notice to the
project chat.

## Handoff notes

(The thread fills this in if it stops before it's done.)
