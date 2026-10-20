# Read-only project chat

## Why

Three test runs (a racing sim and two pagoda builds) had the project chat
build the whole thing alone in its own folder, despite the split guidance
(#367, #370, #375) and its read-only grants and clones. Telling the model
doesn't hold (AGENTS.md: keep the boundaries structural), so the chat loses
the last place it could write.

## What

- A project chat's sandbox mounts its own folder, its alias and `/shared`
  read-only (`SandboxSpec.readOnly`, from `WorkspaceThread.coordinates`).
  `/tmp` stays writable for one command's scratch.
- A write its file tools try is refused with a message telling it to start
  a code thread, which hands files back in `/shared`.
- Its subagents get the same view. lyricad still fetches its clones.
- Its prompt says every folder is read-only in place of the "a path you
  write is a link" line, and where its uploads land.
- Since it can no longer copy files into `/shared`, a file uploaded to it
  lands in its `shared/uploads/`, which its threads read at `/shared/uploads/`.
  An image its image tool makes stays in its own `images/`: a code thread
  that needs one makes it there.

Principles: the structural-boundary rule in AGENTS.md, and principle 1
(the user's work lands in reviewable threads, not one long chat).

## Out of scope

Notes the chat might want to keep: project notes already hold how the user
wants the project run. If a run shows the chat needs a writable notes file,
that is a separate change.

## Handoff

Done when merged and Lunasa's rerun shows the chat starting code threads.
