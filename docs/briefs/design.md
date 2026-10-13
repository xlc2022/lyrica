# Brief: the design thread

**Thread:** Design. **Branch:** `claude/agent-harness-design-ft4cad`, merged
into `main` by pull request like any other. This brief is the design thread's
own handoff, so a fresh session (or a project conversation) can take over.

## What the design thread does

- Owns PRINCIPLES.md, DESIGN.md, docs/contracts.md and docs/ux.md. Nobody
  else edits them; a feature thread that needs a contract change says so in
  its pull request.
- Writes one brief per feature thread in `docs/briefs/`, starts the thread
  as a cloud session named `Lyrica: <thread>` (tag `project:lyrica`), and
  answers its questions by message.
- Reviews every feature pull request: a full read of the diff against the
  brief, the contracts and docs/ux.md, usually with background agents
  checking the privacy and cloud boundaries, then a fix round with the
  thread. Blocking items are fixed and verified in code before the owner is asked.
- Merges only when the owner says so, pull request by pull request. A stacked
  branch is merged with a merge commit, not a squash, after its base is
  retargeted to `main` (a squash of the base makes the stack conflict).
- Keeps mockups, not code: the app at
  https://claude.ai/artifact/96BoPXPoxL2LDBg8eLxjHx and the Models area at
  https://claude.ai/artifact/U3xANiSAFje8cuinWpHo7V. Always update them in
  place.

## The owner's standing decisions

- Private memory never reaches general contexts or cloud models. A local-only
  switch on a thread forbids every cloud model for every purpose.
- No plaintext memory on disk, no fixtures from real data.
- Users are protected from each other, not from the operator. Photos of the
  user go to the cloud only per the user's own setting.
- Use cheaper, well-steered models for simple tasks; mind usage.
- Lyrica deletes only files she downloaded.
- The interface follows docs/ux.md. Labels are nouns, no captions, numbers
  typed with their maximum shown, one idiom for everything.

## Where things stand (12 October 2026)

Done, each brief built and merged on `main`: Core, Memory, Workspace,
Models, Daemon and web access, Delegation and Delegation 2, Web UI, Sleep,
Model host, Models 2, Child threads, Modes, Projects (back end and sleep),
Speech, Model host speech, Web: voice, Machines, SSH helper, Proxmox, Web:
machines, Project workspace (#128), Folder narrowing (#129), NixOS,
Bootstrap (#134), Web: bootstrap and Web: updates (#144), Releases (#136,
#139), Self-editing and Git accounts and repositories (#141), Memory
browser (#135). Checks that need real hardware (GPUs, a NixOS host, a
first SSH machine and Proxmox node, the systemd units) wait for the first
deployment.

| Thread | State | What's left |
|---|---|---|
| Web UI 2 | partly: #80, #100, #107, #112, #115, #122, #125, #127, #130, #133, #137, #144, #150; the Models page (text and image models, Downloads, Tasks, Recent calls) and the Sleep page since; images and portrait photos in #236 | Pin in the remaining places, the speech drawer, Starter recipes (docs/briefs/web-2.md) |
| Context and pace | partly: API in #46, pins counted in #48, the context meter in #182; durable token and GPU time shares in spend-share | the speed columns in Recent calls |
| Projects (web) | partly: #80, #100, #110, #150; Recent calls by project and usage shares in spend-share | Files and images on the Project settings page (docs/briefs/projects-web.md) |
| Context stretching | built in #157; the Serving rows are in the Text models tab | A real-host check (docs/briefs/context-stretch.md) |
| Images | built in #219; image models tab and downloads in the web UI; images in messages, portrait photos and the recipe's fast/quality tag in #236 | Real ComfyUI run (docs/briefs/images.md) |
| MCP servers | built | docs/briefs/mcp.md |
| Subscription logins | ChatGPT and Grok plans built in #169 | docs/briefs/subscription-logins.md |
| Claude Code | built | docs/briefs/claude-code.md |
| Command rules | built in #277 | Nothing (docs/briefs/command-rules.md) |
| Routines | built in #231 | Nothing (docs/briefs/routines.md) |
| Model host fixes and reasoning | built in #225 (fit checks, reloads, crashed loads, vLLM tool calls) and #228 (reasoning) | Real-host checks |

## Open questions for the owner

None. The three from reading Models 2 (an unpaired host, pruning gone
shared models, the reply cap) were settled on 12 October 2026 and are
recorded in DESIGN.md and docs/ux.md and built in #207.

## Handoff notes

Since 10 October 2026 (evening), feature-PR reviews run in the project's
standing **PR review** thread, and the look and feel in a separate **UI
review** thread; a PR merges once both have verified their rounds and CI
is green. The PR review thread then records contracts, DESIGN and
docs/ux.md changes in a docs-only PR.

- Settled in review: subagents and child threads follow their parent's
  later narrowing of mode and switches at once (Modes, #50). Recorded in
  DESIGN and the contracts.

Earlier notes from the design thread:

- To settle in DESIGN: whether a child follows its parent's later switch
  to local-only or "Do not log" (today it keeps the values it was started
  with), and depth through a user's branch of a child.
- Small leftover for a thread's next PR: a tool turn's fallback context
  reads a little high (#46, noted in docs/daemon.md). (#44's dropped
  queued message was fixed in #47.)
