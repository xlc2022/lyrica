# Brief: Workspace

**Thread:** Workspace. **Branch:** `feature/workspace`. **Depends on:** Core
(keyring, users, `ThreadContext`, the `lyrica` command).
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md, docs/contracts.md,
docs/workspace.md.

## Goal

Lyrica can read, write and edit files and run commands, the way a coding agent
does. Every operation runs in a sandbox or on an SSH target, and only touches
what the thread was granted. This is the most security-sensitive component in
the project. Treat escaping the sandbox as the main failure to test against.

## In scope

1. **Grants.**
   - Store each user's allowed host paths, with separate lists for the general
     and private pools, in their `user.db`.
   - Store each thread's chosen grants, read-only or read-write.
   - A general thread can never grant a private path.
   - `lyrica admin grants add|list|remove --user <u> --pool <general|private> <path>`.
2. **Sandbox target.** Implement bubblewrap with every namespace unshared and
   `--die-with-parent`.
   - It mounts a minimal read-only system, the thread's grants (`--ro-bind` or
     `--bind`), and the thread's folder in the home workspace.
   - The network is unshared unless the thread allows it.
   - It runs as `lyricad`'s own user, with no root and no helpers.
   - Implement Pi's `ReadOperations`, `WriteOperations`, `EditOperations` and
     `BashOperations` on top of it.
   - Path checks happen *and* the mounts confine. Don't rely on the checks
     alone.
3. **Home workspace.**
   - gocryptfs per user, with its key derived (HKDF) from the user's data key.
   - `mountHome` runs when the key becomes available, and `unmountHome` when
     it's dropped.
   - Each thread gets a folder with an `uploads/` subfolder.
   - Provide a `saveUpload(ctx, name, bytes)` function. The Web thread wires up
     the UI.
4. **SSH target.**
   - Use `ssh2` in-process, with the private key from the user's encrypted
     settings, held in memory only.
   - An optional root path confines `read`, `write` and `edit`.
   - A connection failure fails the call, with no local fallback.
   - `lyrica admin ssh add|list|remove --user <u> <name> <host> …`.
5. **Network setting.**
   - A private-pool default per user ("tools may use the internet": off by
     default), plus a per-thread override.
   - General threads have network on.
6. **Tools in the extension.** Register `read`, `write`, `edit` and `bash`
   using Pi's `create*Tool(cwd, { operations })` with the thread's target.
   - Keep the registration in its own module, so it doesn't collide with the
     Memory thread's tools.
   - Permission modes ("ask before commands", "ask before changes", "auto")
     are enforced through Pi's `tool_call` event.
7. **Developer bench.** `lyrica dev` switches from `--no-builtin-tools` to
   Lyrica's routed tools, with grants taken from the development runtime.

## Out of scope

- The web upload and grant UI (Web thread).
- Mounting Samba and NFS shares. That's host configuration: document it in
  `docs/workspace.md`, don't code it.
- `grep`, `find` and `ls` tools.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Sandbox tests run as an **unprivileged user**. Cloud sessions run as root,
  which hides permission bugs, so create a test user and run the sandbox tests
  as that user. They show that a command cannot:
  - see `lyricad`'s runtime directory, another user's files, or `lyricad`'s
    process;
  - write to a read-only grant;
  - leave the granted paths through `..`, symlinks, or absolute paths;
  - reach the network when it's off (both `curl` and raw sockets).
- Tests also show that:
  - a general thread can't take a private grant;
  - files under the home workspace are encrypted on disk and readable only
    while it's mounted;
  - SSH failures don't fall back to local execution.
- `lyrica dev` can read, edit and run commands in a granted folder, and is
  refused outside it.
- `docs/workspace.md` describes what exists, including a short host checklist
  for Li's LXC container (nesting, FUSE, the packages).
- Any contract change is listed in the pull request description.

## Handoff notes

(The Workspace thread fills this in if it stops before it's done.)
