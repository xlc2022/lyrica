# Brief: Git accounts and repositories

**Thread:** Self-editing build (the rework of PR #141). **Branch:** the
PR's own. **Model:** Opus; the two screens are Fable's (UI review judges
them against the app mockup, version 29). **Depends on:** Releases (#136)
merged, which it is.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Updates and
self-editing" (Git accounts and repositories, Git etiquette, Her own code),
"Machines" (the pool and own-network rules this copies) and "Projects",
docs/contracts.md `core/workspace` (the planned Git accounts entries),
docs/ux.md (the Git account and A thread's repositories rows), docs/web.md
"Thread settings drawer" and "Project settings page", PR #141 as it stands,
and `/mnt/project-files/repositories/proposal.md` for the reasoning and
Li's decisions (2026-10-12).

## Goal

She works on code the way Claude's threads do here: a project lists
repositories, every thread of it clones its own copy, and her credentials
come from a list of Git accounts that covers several GitHub accounts and
self-hosted Forgejo or Gitea (principle 6 within principle 2's structural
boundaries; principle 1: what Li sets up once lives in one place). This
replaces #141's administrator-named checkout and `lyrica admin code`. What
#141 built for the token's handling, `CODEOWNERS`, the self-primer and `gh`
in the sandbox carries over.

## In scope

1. **Git accounts** (`core/src/workspace/settings.ts`): a `git_accounts`
   table in `user.db` as a numbered expand step in `core/src/migrations.ts`
   (name, kind, host, account, token encrypted like a machine's key, pool,
   off_network, state, since); the thread row's `repositories` column is
   a numbered expand step too, so the test from every released schema
   covers both. `addGitAccount` checks the token against the host first
   (`probeGitAccount`: GitHub's and Gitea's `user` endpoints; Other only
   checks that the host answers git) and saves nothing on failure. A GitHub
   account is general only; a private account's host must resolve on this
   machine's network (reuse the private machines' check), with `offNetwork`
   set and rechecked on every use, and `confirmOffNetwork` as for machines.
   Changing the pool, or removing the account, drops its repositories from
   every thread. The state is updated on each use and shown as Signed in,
   Token rejected or Unreachable.
2. **Repositories on threads.** A thread's row carries `repositories:
   { name, account }[]`; `setThread` refuses one whose account is of the
   other pool; `inheritSettings` gives a child a subset, never more;
   `effective()` keeps only what every ancestor grants, and a parent's
   change narrows running children at once (the folder-narrowing path).
   A project's threads inherit the project chat's list. She may add a
   repository to a thread herself, from an account of its pool; that asks
   the thread's user with an approval card.
3. **Clones.** `cloneFor(t)` clones each repository into the thread's
   folder in the encrypted home workspace at `repos/<name>` at the thread's
   first turn and fetches at the start of later turns, in the sandbox,
   with the credential of that run. A clone goes only with its thread:
   when a repository leaves the thread (removed from it or its project,
   narrowed away by a parent, its account removed or moved to the other
   pool) the credential stops at once and the clone stays, since it may
   hold her unpushed commits and she deletes only what she downloaded;
   the sweep that removes a deleted thread's folder removes its clones.
   Two threads never share a working tree.
4. **Credentials in the environment only.** `forgeEnv(t)` replaces #141's
   single-token version: one git credential per repository URL
   (`credential.useHttpPath`, through a helper fed from the environment,
   never a file on disk), plus each GitHub token keyed by host and account
   and each Gitea or Forgejo login. Empty unless the thread's pool is the
   account's, the thread has the repository, and the run can reach the
   host (internet on, or the host in allowed hosts; a private thread has
   no internet, so an allowed host). Never argv, never a file, with the
   one exception in item 8.
   Two accounts on one host never mix: `GH_TOKEN` is one value, so it is
   not set; the `gh` wrapper picks the token by the current repository's
   `origin` remote (host and owner), and `gh` outside a clone, or in one
   whose remote no account covers, runs with no token.
5. **API** (`daemon/src/routes.ts`): the planned `/api/u/:userId/git-accounts`
   routes and `…/:name/repositories?q=` (what the account can see, from the
   forge's API; Other returns nothing and the UI takes a pasted URL);
   thread settings carry `repositories`. `lyrica admin code` and the
   `workspace.checkout` setting go.
6. **Web** (`web/src`): Settings → **Git accounts** (rows, drawer, Add
   account, Replace token, Remove) and the **Repositories** row in the
   thread drawer and under This chat on Project settings, exactly as
   docs/ux.md's two rows and mockup v28 draw them; the header's facts line
   names the repositories after the machines.
7. **The Git guide.** `extension/src/git.md`, a prompt section the
   workspace extension adds to every turn of a thread with repositories,
   with the defaults in DESIGN.md "Git etiquette" and the sentence that
   project instructions override them. #141's self-primer section becomes
   the Lyrica-specific part on top of it.
8. **Sandbox tools:** `tea` beside `gh` in the tools image and the NixOS
   package list, each behind a thin wrapper script in the image: `gh`'s
   picks the token as in item 4; `tea` reads logins only from
   `$XDG_CONFIG_HOME/tea/config.yml`, so its wrapper writes that file
   from the environment onto the run's tmpfs (`XDG_CONFIG_HOME` under
   `/tmp`, which the sandbox mounts fresh per run), never into the
   workspace or any folder that outlives the run. The Operator docs thread
   is told (install.sh and existing installs).
9. **Docs in the same PR:** docs/workspace.md "Grants" and "Thread
   settings", docs/web.md's two pages, docs/daemon.md's API list,
   docs/briefs/lyrica-project.md (her project lists `xlc2022/lyrica`),
   and this brief's handoff notes.

## Out of scope

SSH keys for Git, a shared clone per project, merging or deploying her
work, issue or pull request tools beyond the forge's CLI, webhooks, and
GitHub App installation flows.

## Tests

A token never reaches a sandbox run of the other pool, of a thread without
the repository, or without a path to the host; two accounts on one host
each get only their own credential; a GitHub account can't be private and
a private account can't be off network without confirmation; removing an
account or a repository from a project narrows its running threads at
once, and narrowing removes the credential, not the clone; `gh` in a
clone of one account never sees the other's token; the `tea` config is on
tmpfs only; a thread's clone is under its own folder and gone with the
thread; the migration test from every released schema.

## After merging

Merge notice to the project chat; the Operator docs thread (Git accounts
replace the checkout setup and the GitHub token field in its guides; `tea`
on existing installs); the Self-editing design thread's handoff in
docs/briefs/lyrica-project.md.

## Handoff notes

(The thread fills this in if it stops before it's done.)
