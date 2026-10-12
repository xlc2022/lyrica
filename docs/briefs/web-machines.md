# Brief: Web: machines

**Thread:** Web: machines. **Branch:** `feature/web-machines`. **Model:**
Fable. **Depends on:** Machines and Proxmox merged.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Machines",
docs/ux.md (the four Machines rows in section 6 and the names in section
4), docs/web.md, docs/daemon.md "Permission prompts", and the API types the
Machines and Proxmox PRs added. The UI review thread has already shaped
every control here; its notes are in `/mnt/project-files/remote/proposal.md`
under "What the user sees and approves". Send it screenshots before the PR.

## Goal

Adding a machine, granting it to a thread and approving what she does
there are as quiet and familiar as the rest of the interface, and the user sees
the fingerprint before anything is trusted.

## In scope

1. **Machines**, a section of Settings where SSH targets are today: rows as
   docs/ux.md describes (name; facts line in mono: address, pool, "SSH ·
   key" or "Proxmox API · token", "up to Accept edits"; at most one state:
   Online, Unreachable with the duration in mono, Key changed, Off network;
   none if never probed). The row opens the drawer: address, root, pool, **Mode limit**
   as the message box's three-item mode list. ⋯: **Replace key**, Remove
   (dialog with its one sentence).
2. **Add machine**, a page: one h1, a kind segment (SSH | Proxmox), steps as
   sections with eyebrows (Name and address, Key or Token, Test,
   Fingerprint). One primary on the page, the current step's action (Copy,
   then Test, then Confirm); a done step's button becomes secondary.
   Confirm is the last step and nothing is saved before it; a test on an
   unsaved machine still proves the key and shows the fingerprint. The setup
   commands in a code block, the fingerprint in mono, no captions. Replace
   key and a Key changed row open it at the Fingerprint step. An off-network
   private machine gets a dialog with the consequence, Add anyway primary
   and Cancel, before Confirm saves it.
3. **The thread.** The "where commands run" select in the thread's Settings
   drawer becomes one Machines row next to Folders: the sandbox plus the
   granted machines. The header's facts line shows the machines' names in
   mono beside the folders; the model picker stays the only chip. In the
   mode menu, a mode above a granted machine's limit reads "Asks on
   <machine>" in its description line; the mode word itself is unchanged.
4. **Cards and markers.** The permission card puts the machine's name first
   in its title and the command or path in mono. A suspect request shows one
   plain warning sentence above the command and a third, secondary choice,
   **Allow in this thread**; Allow stays the one primary; no third colour.
   The pending bar covers it as it does every approval. Each remote call is
   a marker naming the machine.
5. **Phones:** everything at 390 px, the drawer and page full screen, no
   horizontal scroll.
6. **Docs:** docs/web.md.

## Out of scope

- Any change to the back end beyond what the API already offers; if
  something is missing, say so to the Machines or Proxmox thread.
- A dashboard for machines, usage graphs, or a terminal.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- The PR's checklist from docs/ux.md section 10 is filled in, with
  screenshots at 1280 and 390 of the Machines section, the Add machine page
  at the Fingerprint step, the thread drawer, the mode menu with "Asks on",
  and the suspect-command card, in light and dark.
- UI review has said verified.

## After merging

Tell the standing Operator docs thread (the owner's rule, 2026-10-11) by
cross-session message what changed that an operator does by hand (setup
steps, commands, config) and where, in addition to the merge notice to the
project chat.

## Handoff notes

(The thread fills this in if it stops before it's done.)
