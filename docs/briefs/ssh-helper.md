# Brief: SSH helper

**Thread:** SSH helper. **Branch:** `feature/ssh-helper`. **Model:** Opus.
**Runs alongside:** Machines ([machines.md](machines.md)). This brief owns
the transport in `core/src/workspace/ssh.ts`; Machines owns its settings and
policy. Agree the seam (an `SshTransport` the target calls) before starting.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Machines",
docs/workspace.md (the sandbox and its network rules),
`core/src/workspace/sandbox.ts` and `net.ts`.

## Goal

A hostile SSH server can't reach `lyricad`'s memory. Today the `ssh2`
client runs inside `lyricad`, the one process that holds every user's
unlocked keys; a bug in the library's parsing of a server's packets is the
one path from a remote machine into it. Moving the client into a sandboxed
helper per connection means such a bug yields one key the server could
already use, not everything (principle 2).

## In scope

1. **A helper process per connection**, started by `SshTarget` inside
   bubblewrap with the existing sandbox code: a minimal read-only system,
   no mounts of Lyrica's runtime, every capability dropped, and `pasta` with
   the existing nftables rules allowing exactly that machine's address and
   port and nothing else (reuse the allowed-hosts path; `excludePorts` and
   `frontDoor` still apply). It dies with its parent.
2. **The key on a pipe.** The private key is written to the helper's stdin
   (or a passed pipe) and never to a file or an environment variable. The
   helper holds it in memory for the life of the connection.
3. **One protocol over a pipe** between `SshTarget` and the helper: connect,
   exec with streamed output and signals, the SFTP operations the target
   uses (realpath, stat, read, write, rename, unlink, mkdir), close. Host key
   verification stays in `lyricad`: the helper reports the fingerprint it
   sees and waits for a yes or no, so the pin and the "key changed" failure
   live where the settings are.
4. **Timeouts and limits** as now: 10 s to connect, the command timeout and
   abort signal passed through, output capped before it crosses the pipe.
5. **No fallback.** If the helper can't start or is refused by the sandbox
   self-test, the call fails; nothing runs the client in `lyricad`.
6. **Docs:** docs/workspace.md "SSH targets" (or "Machines", if that brief
   has landed) says where the client runs.

## Out of scope

- Any change to machine settings, modes or approvals (Machines).
- A long-running daemon: the helper is a child per open connection.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests show that: the helper runs with `lyricad`'s runtime directory,
  databases and process invisible to it; it can reach only the machine's
  address and port; a connection to a server whose key differs from the pin
  fails with no fallback; a failed helper start fails the call; the
  existing SSH tests pass unchanged through the helper.
- The helper lives in `core/src/workspace`, outside the extension's line
  budget; the PR lists any contract change.

## After merging

Tell the standing Operator docs thread (the owner's rule, 2026-10-11) by
cross-session message what changed that an operator does by hand (setup
steps, commands, config) and where, in addition to the merge notice to the
project chat.

## Handoff notes

(The thread fills this in if it stops before it's done.)
