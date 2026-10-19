# Brief: her own project (the handoff)

**For:** the owner, who creates the project, and Lyrica, who runs it. **Model:**
none to build; the threads it sets up follow the models below.
**Depends on:** Projects (project instructions, threads that message
each other) and Self-editing merged.

**Read first:** AGENTS.md, DESIGN.md "Updates and self-editing" and
"Projects", docs/briefs/self-edit.md.

## Goal

When she starts editing her own code she works the way Claude's project
does today, with the same roles, handoffs and review, instead of
rediscovering them (principle 6: trust her judgment, make review easy).
She starts with no memory of this project, so everything she needs is
written here.

## Bringing existing work into this project

The back end supports `threads fold { ids }` to suggest bringing existing
work into the project, with moves applied by the user. `threads draft`
proposes Goal and Instructions for editing; it never changes the saved
project instructions. Continue as project leaves the source conversation
and carries its children into a new project. The interface is built under
[project-welcome.md](project-welcome.md).

## Setup, by the owner, once

1. **New project** from the thread list's own menu (right-click or long
   press its empty space), in the general pool, and name it "Lyrica"
   (**Rename…** in its menu). In **Project settings** (the **Project** link in the project chat's header):
   General → Goal: "Improve Lyrica's own code from what we notice in use,
   through review."; under This chat, **Repositories** → **+** →
   `xlc2022/lyrica` from her GitHub account, then **Thread settings**: turn
   the internet on, which reading CI logs needs (allowing only
   `github.com`, `api.github.com` and `registry.npmjs.org` works for
   everything else). Her account goes in **Settings → Git accounts**
   first: kind GitHub, her login, and her fine-grained token with
   Contents and Pull requests read and write and Actions read, so she
   can read why her CI failed (docs/workspace.md, "Her own code"). The
   token never enters her sandbox: git, `gh` and `tea` hold a placeholder
   and reach GitHub through the run's relay in `lyricad`, which swaps it in
   for `xlc2022/lyrica` and GitHub's API only. For
   looking things up, set a SearXNG in Administration → Web search
   (docs/guides/searxng.md) and leave each thread's Web search switch on:
   `web_search`, and `web_fetch` for reading a page, which needs the
   thread's internet or the page's host allowed. To let her hand big or
   hard coding jobs to Claude Code on the owner's Claude plan, save the
   token from `claude setup-token` in **Settings → Claude Code** and turn
   on the project chat's **Claude Code** switch in Thread settings, so the
   project's threads inherit it (docs/workspace.md, "Claude Code"); with
   the internet off, also allow `api.anthropic.com`.
   Project settings → General → **Commands** can save trusted checks as
   Allow rules, pushes as Ask, and commands she must leave to the user as
   Forbid. These apply to the project chat, its threads and subagents;
   Always allow on a sandbox command card saves its prefix for this project.
2. Paste the **Project instructions** below into Project settings →
   Memory → Instructions (the count shows it is under 2,000; only the owner can
   change them).
3. Start three standing threads in the project chat (**Start a thread**
   on a message; they sit under the project row) and pick each one's
   model:
   - **Review** (the strongest cloud model allowed): reviews every PR she
     opens before it goes to Claude, against the brief or issue, AGENTS.md
     and the docs; sends fixes to the building thread; says verified.
   - **UI review** (the model the project uses for anything a user sees):
     judges every change a user sees against docs/ux.md, from the
     screenshots `web/e2e/shot.ts` takes (docs/workspace.md, "Her own
     code"); a PR with UI goes out only after it says verified.
   - **Friction log**: keeps the list of what went wrong in use, one line
     each, and turns the top items into GitHub issues assigned to her.

4. Leave the project's `watchThreads` setting on (the default): the
   project chat then takes a batched look at its threads 30 s after one
   ends a turn the owner started or posts an update, marked `[Watching threads]`,
   tells the threads a change affects and speaks only when the owner must know
   or decide (docs/delegation.md, "Watching threads"). A thread that
   stops with an error, or finishes a task without an update, is reported
   to the project chat whatever the setting. Questions (`question: true`),
   `needsYou`, final reports at idle turn end and failure notes wake the
   project chat once, obeying pause. Progress updates only append. A woken
   chat's answer starts its source thread's turn for up to three rounds;
   past that it is saved until the user writes. A message to an idle thread
   while the at-once limit is full waits for a slot, and the tool says so.
   Every thread must end with a message to its parent: the result,
   or what blocked it; she reads its latest
   messages with `threads read` and stops a thread that went wrong with
   `threads stop` (docs/delegation.md, "Child threads"). CI and reviews
   wake her without a turn being blocked: a pull request she opens through
   the run's relay is watched, and `lyricad` gives the thread one turn when
   its checks finish or someone reviews it (DESIGN.md, "CI wakes").
   `threads later` stays for anything else.

## Reading a checkout with a scout

For `delegate`, `folders` means granted host folders, not sandbox checkout
paths. Omit it to let a scout read this project's checkout through its
parent's read-only clone mount; the scout receives no forge credentials.
This is separate from child-thread repository inheritance.

## Project instructions (paste as is)

Kept current by every PR that changes how she works on her own code
(AGENTS.md). The text between the quote marks must stay under 2,000
characters, the limit on project instructions.

> You are working on your own code, in the repository xlc2022/lyrica.
> Read AGENTS.md, PRINCIPLES.md, DESIGN.md and
> docs/contracts.md first, and docs/ux.md before anything a user sees.
>
> **Work.** One GitHub issue, assigned to you, per piece of work; claim it
> first, so you and Claude never build the same thing. One
> thread per issue, on a `lyrica/<short-name>` branch, one pull request
> into `main` when it's done, with typecheck and tests passing in your
> sandbox. Say which principle the change serves.
>
> **Review.** Message the Review thread with the PR and commit when it's
> ready, and UI review too if a user would see it. Fix what they send
> back. When both say verified and CI is green, the PR goes to Claude's
> review, which approves and merges it; answer its comments on the PR.
> Never ask anyone to merge past a red check.
>
> **Boundary code needs the owner**: keys, the privacy boundary, the model
> router, the sandbox, authentication, deployment, the updater and CI
> (listed in CODEOWNERS). A PR touching it says so in its first line and
> waits for the owner's own approval.
>
> **Handoffs.** Nobody waits silently: a thread that needs another thread
> messages it, every time, naming the commit and what it needs, and the
> receiver answers in the same turn.
>
> **Updates.** The owner presses Update. Before that, write the update note:
> an annotated tag `update/<date>` on the `main` commit to install,
> listing everything merged since the running version (Claude's PRs
> too), what each changes, any schema change and what a rollback would
> lose, and what to check afterwards. After a failed update, write the
> post-mortem as an issue linked to the tag.
>
> **Hard rules.** No plaintext memory on disk; private memory never goes
> into code, issues, PRs or notes; you delete only files you downloaded.
> Docs never drift: a PR updates every doc it makes stale and names
> them; fix or report any drift you find.
>
> **This chat** posts only what needs the owner: a decision, a blocker, an
> update ready to press.

## Coding context

Outside a project chat, code in the thread itself: `threads` action `code`
with `on`, a short `task` and `done`, then `on: false` when the coding is
done. Start a `code: true` child only when the user asks for one; delegate a
small side change to `coder`. Requested code children get their own worktrees
and branches; the plain parent keeps the base and merges them itself, starting
a merge thread only if the user asks. A project chat's folders and repositories are
read-only to it: read them and run checks there, and change them through
threads. In a project chat, split a build with
several parts even when they fit together: one `code: true, base: true` thread first sets
up the repository and the interfaces the parts share and resolves, then one `code: true`
thread per part starts, together, each brief naming the files it owns, what
is done and what it depends on; a small job (one feature or fix) keeps one
thread. Parts get their own worktrees for host-folder repository roots.
After their branch reports, start a `code: true, base: true` merge thread:
merge each branch, test after each merge, message the owning thread about
conflicts or red tests, then delete merged branches. Only one open base
thread per project is allowed. Check the merged result before reporting it
done. A project thread changes and commits only the files its brief gives
it. Coder is
the default for a write step in a repository thread. Both use the `code`
model task and project memory plus notes tagged `working`. Thread settings →
Behaviour → **Code mode** turns it on in a conversation; Project settings →
General → New threads sets it for new work, with Save. Choose **Coding**
in Models → Tasks to change its preset or column default; permissions,
review requirements and the private/cloud boundary stay in force.

## Truthful stopping and continuation

Do actionable work before the final reply: it ends the turn, not starts a
stretch of invisible work. If delegation fails and direct tools can do the
job, use them in the same turn. If the user asks "Have you been working?"
after a missed promise, act now rather than end with another promise.

Only claim background work after a successful tool start or queue, naming
the mechanism and its ID where available. Queued is not running. Otherwise
report what was done, the stopping point or blocker, and that the thread is
idle. Do not create unsolicited routines; recurring work needs the user's
request. CI watches above are an existing mechanism, not a new timer to set.

## Claude's side

Claude's project can't see her project. It learns about her work from
GitHub: a routine in Claude's project checks for new PRs from her account
and issues labelled `claude`, sends all her PRs to its PR review thread (even docs-only or
`web/`-only ones, which Claude's own PRs may merge without it) and
the issues to the project chat. The project chat sets that routine up when
her account exists.

Debian and Ubuntu Updates report missing or different systemd units in
Administration → Status; they never rewrite units, since `lyricad.service`
defines her confinement. The operator runs `install.sh` from a current
checkout to update them; NixOS units belong to its module.

## After merging

Nothing for the Operator docs thread: this is set up in the web UI.

## Handoff notes

(Filled in if the setup stops before it's done.)
