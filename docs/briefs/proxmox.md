# Brief: Proxmox

**Thread:** Proxmox. **Branch:** `feature/proxmox`. **Model:** Opus.
**Depends on:** Machines merged (the `proxmox` kind extends its table and
API).

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Machines" and "What
she does", docs/contracts.md `core/workspace` and `extension`,
docs/workspace.md after Machines, and the Proxmox API reference for
`/nodes/{node}/qemu/{vmid}/status/*`, `/cluster/resources` and
`/nodes/{node}/qemu/{vmid}/snapshot`.

## Goal

Lyrica manages the user's VMs through Proxmox's API with a narrow token, never a
root shell on the hypervisor (principle 2: the smallest blast radius that
does the job; principle 6: start and stop are what the user asks for).

## In scope

1. **A Proxmox machine** is a machine of `kind: "proxmox"`: name, address
   (`https://host:8006`), the API token (`user@realm!tokenid=secret`) stored
   encrypted in `user.db` like a key, the pinned certificate fingerprint,
   pool and mode limit. The token is never shown to her or to anything she
   runs. Adding one goes through the same Add machine flow with Token in
   place of Key and the certificate fingerprint in place of the host key.
2. **The node that runs Lyrica's own VM is refused** where it can be told:
   an address that is this VM's default gateway, or a node whose
   `/cluster/resources` lists a VM whose MAC or name matches this machine's.
   The refusal says why. The owner adds that node later, by hand, when they decide.
3. **One tool, `proxmox`**, in `extension/src/proxmox.ts`: a schema plus
   one call into `core/workspace`, which makes the API call; nothing else
   lives in the extension, whose budget is about 8,000 lines
   (principle 8). The PR reports the extension's line count; if it goes
   over, it says what is removed or asks for the DESIGN change. Named
   actions: `status`, `list` (VMs and containers the token can see),
   `start`, `stop`, `shutdown`, `reboot`, `snapshots` (list only). Each is
   one API call, never a command. No `destroy`,
   no `create`, no console, no guest-agent file access, no snapshot
   creation or rollback in this version. Say the new tool total against the
   budget of 30 (count the registered tools; the number in the proposal was a guess).
4. **Modes.** `status`, `list` and `snapshots` are read-only and work in Plan
   mode. `start` and `shutdown` follow the machine's mode limit and the
   thread's mode like `bash` on a machine; `stop` and `reboot` are suspect
   actions (as DESIGN.md's Proxmox bullet says), so they ask with the
   warning in every mode until the user allows them in a thread.
5. **Setup text** on the Add machine page and in `lyrica admin proxmox add`:
   the `pveum` commands for a privilege-separated token with a custom role
   of `VM.Audit` and `VM.PowerMgmt` on the chosen VMs or pool, and
   `PVEAuditor` on `/`; a plain warning not to use the built-in `PVEVMUser`
   (console and guest-agent file rights run code in the guest) and never to
   grant `Sys.PowerMgmt`. The token's rights are the intersection of its own
   and its user's, so the user `lyrica@pve` gets the same roles.
6. **API:** the Machines routes accept `kind: "proxmox"` with `token` in
   place of a key; `POST …/machines/probe` returns the certificate
   fingerprint for a Proxmox address.
7. **Docs:** docs/workspace.md (a Proxmox section: what exists, the setup
   commands), docs/contracts.md.

## Out of scope

- LXC-specific actions beyond start, stop, shutdown, reboot and status.
- Backups, migration, storage, node power, cluster changes.
- A Proxmox mock in the UI; the Web: machines brief handles the rows and
  the page.

## Done when

- `npm run typecheck` and `npm test` pass in CI, with the Proxmox API
  faked in tests.
- Tests show that: the token never appears in the API, logs or thread
  entries; `destroy` isn't callable; `reboot` asks in Auto until allowed in
  that thread, and the allow reaches no other thread; Plan mode can `status`
  and not `start`; a certificate whose fingerprint changed fails with no
  fallback; the address of this VM's own node is refused.
- docs/workspace.md describes what exists and the PR lists its contract
  changes and the tool total.

## After merging

Tell the standing Operator docs thread (the owner's rule, 2026-10-11) by
cross-session message what changed that an operator does by hand (setup
steps, commands, config) and where, in addition to the merge notice to the
project chat.

## Handoff notes

(The thread fills this in if it stops before it's done.)
