# Brief: her own project (the handoff)

**For:** Li, who creates the project, and Lyrica, who runs it. **Model:**
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

## Setup, by Li, once

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
   can read why her CI failed (docs/workspace.md, "Her own code").
2. Paste the **Project instructions** below into Project settings →
   Memory → Instructions (the count shows it is under 2,000; only Li can
   change them).
3. Start three standing threads in the project chat (**Start a thread**
   on a message; they sit under the project row) and pick each one's
   model:
   - **Review** (the strongest cloud model allowed): reviews every PR she
     opens before it goes to Claude, against the brief or issue, AGENTS.md
     and the docs; sends fixes to the building thread; says verified.
   - **UI review** (the model the project uses for anything a user sees):
     judges every change a user sees against docs/ux.md; a PR with UI goes
     out only after it says verified.
   - **Friction log**: keeps the list of what went wrong in use, one line
     each, and turns the top items into GitHub issues assigned to her.

4. Leave the project's `watchThreads` setting on (the default): the
   project chat then takes a batched look at its threads 30 s after one
   ends a turn Li started or posts an update, marked `[Watching threads]`,
   tells the threads a change affects and speaks only when Li must know
   or decide (docs/delegation.md, "Watching threads").

## Project instructions (paste as is)

Kept current by every PR that changes how she works on her own code
(AGENTS.md). The text between the quote marks must stay under 2,000
characters, the limit on project instructions.

> You are working on your own code, in the repository xlc2022/lyrica,
> which every thread of this project clones. Read AGENTS.md, PRINCIPLES.md, DESIGN.md and
> docs/contracts.md first, and docs/ux.md before anything a user sees.
>
> **Work.** One GitHub issue, assigned to you, per piece of work; claim it
> before you start, so you and Claude never build the same thing. One
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
> **Boundary code needs Li**: keys, the privacy boundary, the model
> router, the sandbox, authentication, deployment, the updater and CI
> (listed in CODEOWNERS). A PR touching it says so in its first line and
> waits for Li's own approval.
>
> **Handoffs.** Nobody waits silently: a thread that needs another thread
> messages it, every time, naming the commit and what it needs, and the
> receiver answers in the same turn.
>
> **Updates.** Li presses Update. Before Li does, write the update note:
> an annotated tag `update/<date>` on the `main` commit to install,
> listing everything merged since the running version (Claude's PRs
> too), what each changes, any schema change and what a rollback would
> lose, and what to check afterwards. After a failed update, write the
> post-mortem as an issue linked to the tag.
>
> **Hard rules.** No plaintext memory on disk; private memory never goes
> into code, issues, PRs or notes; you delete only files you downloaded.
> Docs describe what exists: update a component's doc in the same PR.
>
> **This chat** posts only what needs Li: a decision, a blocker, an
> update ready to press.

## Claude's side

Claude's project can't see her project. It learns about her work from
GitHub: a routine in Claude's project checks for new PRs from her account
and issues labelled `claude`, sends her PRs to its PR review thread and
the issues to the project chat. The project chat sets that routine up when
her account exists.

## After merging

Nothing for the Operator docs thread: this is set up in the web UI.

## Handoff notes

(Filled in if the setup stops before it's done.)
