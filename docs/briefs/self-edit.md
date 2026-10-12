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
nothing she does reaches `main` or the server without review and the owner's
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
3. **Repository settings, written as a checklist for the owner** (she owns the
   repository): her account as a collaborator with write; a fine-grained
   token for this repository only with contents and pull requests; `main`
   protected (pull requests only, the CI jobs required, one approval); a
   ruleset that lets her account create and update only `lyrica/*`
   branches and `update/*` tags. The owner's account may bypass the rules as
   administrator ("Do not allow bypassing" stays off), so Claude's PRs,
   which are authored as the owner, keep merging as they do today. She pushes
   branches to the repository, never a fork, so her PRs run
   `.github/workflows/ci.yml` on the `lyrica-ci` runners like Claude's,
   with no first-time-contributor approval.
4. **`CODEOWNERS`**, in this PR, naming `@xlc2022` for the boundary code:
   `core/src/keyring.ts`, `core/src/models/`, `core/src/workspace/`,
   `core/src/store/memory.ts` (`openThreadView`), `daemon/src/auth.ts`,
   `daemon/deploy/`, the updater scripts and `.github/`. It makes GitHub
   ask for the owner's review on such a PR; it is not required for merging,
   because Claude's approvals come from the same account. The rule is the
   reviewers': PR review asks the owner in the project before approving a PR of
   hers that touches these paths.
5. **Update notes.** How she writes one: an annotated tag `update/<date>`
   on the `main` commit to install, its message listing the merged PRs
   since the running version, what each changes, any schema change and
   what a rollback would lose, and what to check afterwards. Describes
   code, never conversations. After a failed probation, a GitHub issue
   linked to the tag holds the post-mortem.
6. **The self-primer** gains one short section: one branch and one PR per
   piece of work, the review flow, update notes, that the owner presses Update, and
   that rollbacks exist, and that a PR touching boundary code says so
   first and waits for the owner. Persona files stay about
   her (principle 9).
7. **Docs in the same PR:** docs/workspace.md "Grants" (her own code) and
   "Thread settings" if the token changes them.

## Out of scope

Merging or deploying her own work, any tool for GitHub, private-pool code
work, and editing anything under `/opt/lyrica`.

## Tests

The token never reaches a private thread's sandbox or a thread without the
checkout; the grant check refuses the checkout in a private list and the
runtime, release, snapshot and request folders.

## After merging

Tell the standing Operator docs thread (the owner's rule, 2026-10-11) by
cross-session message: the checkout setup, her GitHub account and token,
branch protection, the branch ruleset and `CODEOWNERS`. Plus the merge notice to the project
chat.

## Handoff notes

**Superseded in part (2026-10-12).** The owner asked for repositories per project
and several Git accounts before PR #141 merged, so items 1 and 2 above are
replaced by [repositories.md](repositories.md): no administrator-named
checkout and no `lyrica admin code`; her token is one Git account among
several, and her repository one entry in her project's Repositories list.
Items 3 to 7 stand; the self-primer's section (item 6) sits on top of the
Git guide that brief adds. #141 is reworked from that brief.
