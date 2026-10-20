# Brief: Handing files between threads

**Status:** Built in this PR. **Thread:** Roadmap. **Model:** Opus.

## Goal

Threads that work together share files through a folder, and messages
carry words. In a test run on a free cloud model, the project chat built a
page in its own `/workspace`, the code thread it started couldn't see it
(code threads have their own folder since #376), and the two planned to
pass the page across as base64 chunks in thread messages. The owner asked
(2026-10-20) for a sanctioned route and for messages to stop working as a
file channel, in projects and between a parent and its children outside
them. Principles: structural boundaries over prompting (AGENTS.md), and
principle 1 (what the user would notice: a stuck hand-off).

## In scope

1. `/shared`: `shared/` in the family's topmost thread's folder (the
   project folder in a project), mounted read-write in every sandbox of
   the family. One prompt line says what it is for.
2. Thread messages: at most 8,000 characters, and no long base64 runs in a
   message or a start task. The refusal names `/shared` or a shared
   repository.
3. Two fixes from the same run: a `threads` card is headed by its action
   (it said "Message to a child thread" for a read), and reading one's own
   project chat says to message it with `to: "parent"`.

## Out of scope

- Copying named files into a new thread at `start`: `/shared` covers it.
- A `/shared` root in a code thread's Files panel. The person sees the
  folder in Project settings and in the project chat's Files.
- Detecting other encodings (hex dumps, data URIs split across lines).

## Docs

docs/workspace.md ("Handing files over", the sandbox's mounts), DESIGN.md
(Projects, Files), docs/contracts.md, docs/web.md (the threads card).
