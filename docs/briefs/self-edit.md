# Brief: Self-editing

**Thread:** Self-editing. **Branch:** `feature/self-edit`. **Model:** Opus.
**Depends on:** Releases merged (update notes are what the updater
installs).

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Updates and
self-editing", "Persona" (the self-primer) and "Runtime", docs/workspace.md
"Grants" and "Network access from tools", docs/contracts.md
`core/workspace`.

## Goal

She can change her own code the way Claude's feature threads do, and
nothing she does reaches `main` or the server without review and Li's
Update (principle 6: trust her judgment, make review easy; AGENTS.md: keep
the boundaries structural).

## In scope

1. **The checkout.** Setup for an administrator: a folder owned by
   `lyrica` (for example `/srv/lyrica-src`) cloned from the repository,
   added to a user's **general** grant list. The grant check refuses it in
   a private list, and refuses `/opt/lyrica`, the snapshots folder and the
   update request folder like the runtime directory.
2. **Her GitHub token.** A field in her user's settings, stored encrypted in
   `user.db` like a machine key, never shown back. It is handed to the
   sandbox (as a git credential and `GH_TOKEN`) only in a general thread
   that has the checkout granted, and only while its internet switch is on
   or `github.com` is an allowed host. No new model-facing tool.
3. **Repository settings, written as a checklist for Li** (she owns the
   repository): her account as a collaborator with write; a fine-grained
   token for this repository only with contents and pull requests; `main`
   protected (pull requests only, the CI jobs including the boundary check
   required, one approval). Li's account may bypass the rules as
   administrator ("Do not allow bypassing" stays off), so Claude's PRs,
   which are authored as Li, keep merging as they do today. She pushes
   branches to the repository, never a fork, so her PRs run
   `.github/workflows/ci.yml` on the `lyrica-ci` runners like Claude's,
   with no first-time-contributor approval.
4. **The boundary check**, a job in `.github/workflows/ci.yml`: when the
   PR's author is her account, it fails if the diff touches any path in
   `.github/boundary-paths`, naming them. The list: `core/src/keyring.ts`,
   `core/src/models/`, `core/src/workspace/`, `core/src/store/memory.ts`
   (`openThreadView`), `daemon/src/auth.ts`, `daemon/deploy/`, the updater
   scripts and `.github/` (so the check and the list are covered too).
   Claude's PRs are untouched by it. The list and the job are in this PR.
5. **Update notes.** How she writes one: an annotated tag `update/<date>`
   on the `main` commit to install, its message listing the merged PRs
   since the running version, what each changes, any schema change and
   what a rollback would lose, and what to check afterwards. Describes
   code, never conversations. After a failed probation, a GitHub issue
   linked to the tag holds the post-mortem.
6. **The self-primer** gains one short section: one branch and one PR per
   piece of work, the review flow, update notes, that Li presses Update, and
   that rollbacks exist, and that boundary code is for a Claude thread:
   she describes the change, and one builds it. Persona files stay about
   her (principle 9).
7. **Docs in the same PR:** docs/workspace.md "Grants" (her own code) and
   "Thread settings" if the token changes them.

## Out of scope

Merging or deploying her own work, any tool for GitHub, private-pool code
work, and editing anything under `/opt/lyrica`.

## Tests

The token never reaches a private thread's sandbox or a thread without the
checkout; the boundary check fails her PR on a listed path and passes
Claude's; the grant check refuses the checkout in a private list and the
runtime, release, snapshot and request folders.

## After merging

Tell the standing Operator docs thread (Li's rule, 2026-10-11) by
cross-session message: the checkout setup, her GitHub account and token,
branch protection and the boundary check. Plus the merge notice to the project
chat.

## Handoff notes

(The thread fills this in if it stops before it's done.)
