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

## More than one deployment

She can run her project on more than one deployment at once, such as a
development deployment that tries changes first and the one the owner uses
day to day (the owner, 2026-11-06). Each has its own project, set up with
the steps below, and its own GitHub account, so GitHub keeps them apart:

- **Issues.** An issue is claimed by assigning it to one account. A
  deployment works only on issues assigned to its own account and leaves
  the other's alone, even when both noticed the same thing; its Friction
  log searches open issues first and comments on a match instead of filing
  a second.
- **Branches.** Both push `lyrica/*` branches. Before pushing a new one she
  checks the name isn't on GitHub yet, and she never pushes to a branch
  another account created (AGENTS.md, "Review and merge").
- **Update tags.** Each deployment's update note lists what was merged
  since its own running version. When the `update/<date>` name is taken,
  the second note adds a suffix, such as `update/<date>-2`.
- **Nothing is shared** between the two: not threads, memory, models'
  settings or tokens. Everything she needs for her project is in this file.

On the deployment the owner uses, no Claude session reads her threads,
turn records or logs (the owner, 2026-10-24). Everything Claude's side needs
is on GitHub: her issues, and her PRs for anyone who wants to read them. A guardian that
watches her threads, as in [self-edit-trial.md](self-edit-trial.md), is
for a development deployment only.

### Before her project, by the owner, on the new deployment

These are by hand; the guides cover each one.

1. **Install and first run** ([getting-started.md](../guides/getting-started.md)),
   or, for an older install, bring it to current `main`
   ("Upgrading from a checkout" there). Run the checklist at the end of
   that guide, and add the updater's deploy key if install.sh printed one
   ("Updates from GitHub").
2. **Models** for her project chat, Review and UI review, from the model
   hosts it pairs with ([model-hosts.md](../guides/model-hosts.md)). A host
   paired with two deployments moves to whichever asks for **Update**, so
   keep both on the same release, or update the host only from this one.
3. **A GitHub account for this deployment,** its own, never another
   deployment's token: a Write collaborator on `xlc2022/lyrica` only,
   with a classic `public_repo` token (docs/workspace.md, "Her own
   code", steps 1 and 2).
4. **Web search** (a SearXNG, [searxng.md](../guides/searxng.md)) and,
   for Claude Code jobs, a fresh `claude setup-token` token under
   Settings → Claude Code and Codex, so each deployment's can be revoked
   alone.
5. **Tell Claude's project** the new account's login, so it knows whose
   issues and PRs it is reading. Nothing on Claude's side lists her
   accounts to pick up her PRs: she merges her own.

Then follow "Setup, by the owner, once".

### Updates with a development deployment

Each deployment installs an update by its own **Update**. Press it on the
development deployment first and on the one the owner uses after that
release passed probation there.

## Setup, by the owner, once

1. **New project** from the thread list's own menu (right-click or long
   press its empty space), in the general pool, and name it "Lyrica"
   (**Rename…** in its menu). In **Project settings** (the **Project** link in the project chat's header):
   General → Goal: "Build and improve Lyrica's own code, through review."; under This chat, **Repositories** → **+** →
   `xlc2022/lyrica` from her GitHub account, then **Thread settings**: turn
   the internet on, which reading CI logs needs (allowing only
   `github.com`, `api.github.com` and `registry.npmjs.org` works for
   everything else). Her account goes in **Settings → Git accounts**
   first: kind GitHub, her login, and her token: a classic one with only
   `public_repo`, since a fine-grained token can't write to a repository
   another personal account owns, so she can push, claim issues and read
   why her CI failed (docs/workspace.md, "Her own code"). The
   token never enters her sandbox: git, `gh` and `tea` hold a placeholder
   and reach GitHub through the run's relay in `lyricad`, which swaps it in
   for `xlc2022/lyrica` and GitHub's API only. For
   looking things up, set a SearXNG in Administration → Web search
   (docs/guides/searxng.md) and leave each thread's Web search switch on:
   `web_search`, and `web_fetch` for reading a page, which needs the
   thread's internet or the page's host allowed. To let her hand big or
   hard coding jobs to Claude Code on the owner's Claude plan, save the
   token from `claude setup-token` in **Settings → Claude Code and Codex**
   and turn
   on the project chat's **Claude Code** switch in Thread settings, so the
   project's threads inherit it (docs/workspace.md, "Claude Code"); with
   the internet off, also allow `api.anthropic.com`. She then delegates
   those jobs to the `claude` role, in the background, and gets its report
   back; any job the person asks Claude for by name runs there too, in its
   role (docs/delegation.md, "Claude Code").
   Project settings → General → **Commands** can save trusted checks as
   Allow rules, pushes as Ask, and commands she must leave to the user as
   Forbid. These apply to the project chat, its threads and subagents;
   Always allow on a sandbox command card saves its prefix for this project.
   Project settings → General → **Checks** lists the commands that run
   when one of her code turns ends (`npm run typecheck`, `npm test`);
   **Setup** stays empty, since each clone already gets `npm ci
   --ignore-scripts` from its lockfile (docs/workspace.md, "Dependencies").
   Her code threads read the repository's AGENTS.md on their own. Skills she
   saves for recurring jobs (a CI fix, a release) wait for approval in
   Settings → Skills unless auto-approve is on (DESIGN.md, "Skills").
2. Paste the **Project instructions** below into Project settings →
   Memory → Instructions (the count shows it is under 2,000; only the owner can
   change them).
3. Start three standing threads in the project chat (**Start a thread**
   on a message; they sit under the project row) and pick each one's
   model:
   - **Review** (the strongest cloud model allowed): reads a brief
     before its code starts, when there is one (goal, smallest version, which docs/ux.md rule
     each new control follows, what it reuses, what it adds against
     PRINCIPLES 8's budgets), then reviews each PR of hers that needs
     review (AGENTS.md, "Review and merge", step 1) before she merges it,
     and keeps PRINCIPLES, DESIGN, the contracts and docs/ux.md true to
     what her project settles, against the brief or issue, AGENTS.md and the docs;
     sends fixes to the building thread; says verified.
   - **UI review** (the model the project uses for anything a user sees):
     reads a UI brief's mockup or written layout before its code
     starts, when there is one, then judges every change a user sees against docs/ux.md, from
     the screenshots `web/e2e/shot.ts` takes (docs/workspace.md, "Her own
     code"); a PR with UI goes out only after it says verified.
   - **Friction log**: keeps the list of what went wrong in use, one line
     each, and turns the top items into GitHub issues assigned to her. It
     never builds them: it tells the project chat, which starts the work.

   Standing threads never resolve themselves: one that hits a blocker
   reports it to the project chat and stays open.

   Then tell the project chat these three exist, naming each, so it routes
   work to them instead of starting its own: a project chat told only the
   roles starts a second Review or Friction log.

4. Leave the project's `watchThreads` setting on (the default): the
   project chat then takes a batched look at its threads 30 s after one
   ends a turn the owner started or posts an update, marked `[Watching threads]`,
   tells the threads a change affects and speaks only when the owner must know
   or decide (docs/delegation.md, "Watching threads"). A thread that
   stops with an error, or finishes a task without an update, is reported
   to the project chat whatever the setting. Questions (`question: true`),
   `needsYou`, final reports at idle turn end and failure notes wake the
   project chat once, obeying pause; reports wait a minute so several
   close together wake it once. Progress updates only append. A woken
   chat's answer starts its source thread's turn for up to three rounds;
   past that it is saved until the user writes. A message to an idle thread
   while the at-once limit is full waits for a slot, and the tool says so.
   Every thread must end with a message to its parent: the result,
   or what blocked it; she reads its latest
   messages with `threads read` (a child still working says its end wakes
   her, so she ends her turn rather than waiting) and stops a thread that went wrong with
   `threads stop` (docs/delegation.md, "Child threads"). A second start
   for an open thread's task tells her to message that thread instead,
   whose folder and worktree she can read (docs/workspace.md, "Handing
   files over"), and `resolve` stops at
   a thread's work no remote has unless she passes `force: true`. CI and reviews
   wake her without a turn being blocked: a pull request she opens through
   the run's relay is watched, and `lyricad` gives the thread one turn when
   its checks finish or someone reviews it (DESIGN.md, "CI wakes"); one she
   opened another way she watches with `threads watch`. A red
   run asks her to read the failing log and push at least one fix before
   calling it blocked. She may call it flaky only after re-running just the
   failed jobs once and seeing them pass, and unrelated only when a main run's
   log shows the same test failing; a list of main's red conclusions isn't
   enough (#549, 2026-10-25). When a thread's project checks still fail after
   three rounds, `lyricad` tells the project chat at once, which runs the
   failing command on the base branch to tell real failures from her
   sandbox's (docs/workspace.md, "Project checks").
   `threads later` stays for anything else.

## Reading a checkout with a scout

For `delegate`, `folders` means granted host folders, not sandbox checkout
paths. Omit it to let a scout read this project's checkout through its
parent's read-only clone mount; the scout receives no forge credentials.
This is separate from child-thread repository inheritance.

## Project instructions (paste as is)

Kept current by every PR that changes how she works on her own code
(AGENTS.md). Every thread in her project reads these instructions, not
only the project chat, so each line names who it is for. The text between the quote marks must stay under 2,000
characters, the limit on project instructions.

> You work on your own code in xlc2022/lyrica, as its main builder: any
> work is yours, from what you notice in use to planned features. Read
> AGENTS.md, PRINCIPLES.md, DESIGN.md and docs/contracts.md first, and
> docs/ux.md before UI work.
>
> **The project chat** plans and routes. Each piece of work gets one
> issue, assigned to you and claimed first: what is wanted, the smallest
> change a user would notice, what it reuses, the principle it serves.
> It starts one thread per issue, unasked, and tells the owner only what
> needs them: a decision, a blocker, an update to press.
>
> **A build thread** takes one issue. Before UI work, a new API or
> dependency it writes a short brief in docs/briefs/, or says why not.
> On a `lyrica/<short-name>` branch it opens one tested PR into
> `main`. It sends each PR that needs review (AGENTS.md) and its
> head to Review and, for UI, UI review. Once they verify the exact head
> and CI is green, it records both on the PR and merges; a later push
> needs both again. A PR touching boundary code (CODEOWNERS) says so in
> its first line and waits for the owner's approval.
>
> **Claude, two paths.** To confer with Claude when the owner asks, run
> Claude Code, your tool (`claude` in your sandbox, or delegate to
> role `claude`), on the change; treat its report as findings. To give
> Claude's project, another team, work: a GitHub issue labelled `claude`.
>
> **Everyone.** Act, then report: never ask the owner before opening or
> merging a PR (boundary code aside), only before what can't be undone.
> Nobody waits silently: message the thread you need, and tell the
> project chat what merged and what it affects. No plaintext memory on disk; private memory never goes
> into code, issues, PRs or notes; delete only files you downloaded. Docs
> are how others pick up your work: a PR fixes every doc or brief it
> makes stale and names them, and each issue or brief keeps a current
> handoff note (done, next, open questions) another agent can continue
> from.

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
conflicts or red tests, then delete merged branches. Two threads that
change one file in the same folder are stopped once and told about each
other, and agree who changes what before going on. Several base threads may be
open at once; none holds the base checkout. A thread's report names the check that
tests the request as asked and what it showed; with that evidence a light
look is enough, and otherwise check fully before reporting it done. A
project thread changes and commits only the files its brief gives it, and
keeps screenshots, logs and other check output in its scratch folder
outside worktrees/. Before reporting done it runs git status in each
repository or worktree it changed and commits what belongs to the work or
says what is left uncommitted. Coder is
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

Claude's project can't see her project, and it doesn't review, approve or
merge her PRs (the owner, 2026-11-10: she has full control of her work).
She follows AGENTS.md's four steps like any builder: a PR that needs
review goes with its head to her project's Review thread (and UI review
when applicable), she fixes findings and sends each new head for recheck.
After all required reviewers verify the exact head and CI is green, she
records the head and review results in the PR description or a comment
and merges it herself, with a merge
commit; a push after that needs both again, and boundary code (CODEOWNERS)
also waits for the owner's own approval.

Conferring with Claude is the owner's to ask for, per change or as a
standing wish said in her project. She then gives the change (the PR, its
head and what to look at) to Claude Code, the `claude` program in her
sandbox on the owner's Claude plan, run from her shell or in the
background as the `claude` delegate role (docs/workspace.md and
docs/delegation.md, "Claude Code"), reads its report
and treats what it finds like a reviewer's findings. Claude Code is a
tool of hers; it isn't Claude's project and knows nothing of it. It needs the Claude
Code token and switch from "Setup, by the owner, once", step 1.

Issues labelled `claude` are the other path, requests for Claude's
project to do work, sent to its project chat: a routine
in Claude's PR review thread picks them up. GitHub is the only channel
between the two projects, both ways. Claude's project answers her on the
issue, and asks her for anything as an issue assigned to her, never by a
message into her threads, even on a deployment where an operator session
could reach them.

Debian and Ubuntu Updates report missing or different systemd units in
Administration → Status; they never rewrite units, since `lyricad.service`
defines her confinement. The operator runs `install.sh` from a current
checkout to update them; NixOS units belong to its module.

## After merging

Tell the Operator docs thread when this file changes what the owner does by hand on a deployment ("Before her project"); the rest is set up in the web UI.

## Handoff notes

2026-11-06: her project ran on the development deployment, with its own
GitHub account, for the guided trial in
[self-edit-trial.md](self-edit-trial.md) (#503, #504, #505) and the work
she picked after it, and keeps it. The deployment the owner uses day to
day was behind `main` and had no project yet; it gets one of its own
beside the development one. Next, by the owner: "Before her project"
above, then "Setup, by the owner, once" on that deployment.

2026-11-10: the deployment the owner uses day to day has its GitHub
account, `lyrica-lilypad`, a Write collaborator on the repository; the
development deployment's is `lyrica-lunasa`. Nothing in the repository
lists her accounts: CODEOWNERS names only the owner, and CI runs the same
for every pusher. The one place that does is Claude's PR review handoff
([pr-review-handoff.md](pr-review-handoff.md)); no ruleset on GitHub
limits her accounts. Each deployment tags its
own update notes ("Update tags" above). Next, by the owner: the rest of
"Before her project" and "Setup, by the owner, once" on that deployment.

2026-11-10, later: the owner gave her full control of her own work.
Claude's PR review no longer approves her PRs; she merges after her own
reviewers and green CI, the owner still approves boundary code, and she
confers with Claude through the `claude` role when the owner asks. Each
deployment's saved Project instructions need the new text above pasted in
by the owner (only the owner can change them). `main` requires no
approval on GitHub (the owner confirmed), so nothing in the repository's
settings changes.

2026-11-10, later still: one set of rules for both projects (AGENTS.md,
"Workflow"). She is the main builder and takes any work, planned features
included; docs-only, brief-only and small `web/` PRs skip her Review as
they skip Claude's; her PRs no longer open as drafts; her Review thread
keeps the design docs true to what her project settles. What still
differs: boundary code waits for the owner, and her reviewers' verifieds
are recorded on the PR, since they act as her own account. By the owner:
paste the new instructions, set the project's Goal as in "Setup, by the
owner, once", and tell her Review thread its part.

2026-11-10, last: the instructions no longer carry an Updates paragraph
(the owner). How she writes an update note when asked for one stays in
docs/workspace.md, "Her own code", and "Update tags" above.
