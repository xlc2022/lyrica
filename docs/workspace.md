# Workspaces: files, commands and remote machines

**Status: agreed.**

Lyrica works like a coding agent. She can read, write and edit files, run
commands, work on remote machines over SSH, reach shared drives, and work with
files a user uploads. She must not touch anything she wasn't given.

## Where the tools run

Lyrica uses Pi's standard `read`, `write`, `edit` and `bash` tools. Pi lets each
tool's file and process operations be swapped for another backend
(`createReadTool(cwd, { operations })` and so on). Lyrica's versions send every
operation to an **execution target**. Nothing runs inside `lyricad`'s process.

That matters because `lyricad` holds the unlocked keys in memory and owns the
database files. A command that could see either one could read everything.

| Target | What it is | How she is confined |
|---|---|---|
| **Sandbox** (default) | Each command runs on the Lyrica host inside bubblewrap. | The sandbox is described below. |
| **SSH** | A named remote machine. | She is confined by the remote account's own permissions, so each target should use a dedicated account. An optional root path limits `read`, `write` and `edit`. If SSH fails, the action fails: it **never** falls back to running locally. |

**The sandbox:**
- It runs with every namespace unshared (mount, process, user, IPC, network),
  plus `--die-with-parent`.
- Only the thread's granted directories and a minimal read-only system are
  mounted. Lyrica's runtime directory, other users' files, and `lyricad`'s
  process and credentials don't exist inside it.
- It runs as `lyricad`'s own service user, isolated by namespaces, so no root
  or privileged helper is needed. Because the sandbox has its own process
  namespace, it can't see `lyricad` at all, let alone read its memory.

**SSH targets** use an in-process SSH library (`ssh2`). Each private key is
stored in the user's encrypted settings and handed to the library in memory,
so it never touches disk, and no system `ssh` agent is involved.

## Grants: what she may touch

- **An administrator decides which host paths each user may grant**, with
  separate lists for that user's **general** and **private** pools. A general
  thread can only grant general paths. That keeps files meant for private work
  from being read in a thread that may use cloud models.
- **Each thread chooses its grants** from those lists, as read-only or
  read-write, much like choosing a working directory in Claude Code. The thread
  shows them next to the model badge.
- **Shared drives (Samba, NFS):** the system mounts them on the host (systemd
  mount units, with credentials in system config). Once mounted, they're
  ordinary paths an administrator can add to a user's grant lists. Lyrica never
  handles share credentials.
- **Her own code.** Later, when she edits her own code, her repository checkout
  is simply another grant.

## The home workspace and uploads

- Each user has an encrypted **home workspace**: a gocryptfs folder whose key
  is derived from the user's data key. It is mounted when the user's key
  becomes available (at login, or at startup if credentials are saved) and
  unmounted when the key is dropped. Every thread gets its own folder inside
  it.
- A file uploaded in the web UI goes into the thread's `uploads/` folder in the
  home workspace.
- An uploaded file is a file, not a memory. She notes what matters from it, as
  with anything else she reads.
- **Granted host paths outside the home workspace are ordinary files.** Their
  protection is whatever the host gives them.

## Network access from tools

- **General threads:** tools have network access. Local-only governs model
  calls, not tool traffic.
- **Private threads:** a setting controls tools' internet access, and it is
  **off by default**.
  - The user sets a default for their private pool, and each private thread
    can override it.
  - When it is off, the sandbox has no network at all (`--unshare-net`).
  - SSH targets still work, because `lyricad`'s SSH client reaches them, not
    the sandbox.
  - Model calls also come from `lyricad`, not from tools.
  - The reason: otherwise a `curl` command could send private content to the
    internet.
  - An allowlist of LAN hosts can be added later if it's needed.

## Approval

The sandbox already limits what she can reach. Inside her grants she works
freely by default, following the principle that the harness should trust her
judgment and make review easy. Each thread has a **permission mode**:
- **Ask before commands**
- **Ask before changes**
- **Auto** (the default)

Anything irreversible that leaves the server, such as sending a message,
deleting remote data or spending money, always asks.

## Tools

`read`, `write`, `edit` and `bash`. Pi's `grep`, `find` and `ls` can be added
inside the 30-tool budget if `bash` turns out not to be enough. The memory tool
is `read_memory`, so it doesn't clash with `read`.

## Host requirements

The machine running `lyricad` needs:
- bubblewrap;
- gocryptfs;
- FUSE (`/dev/fuse` and `fusermount3`);
- unprivileged user namespaces.

In a Proxmox LXC container, turn on the **nesting** and **FUSE** features. A
VM needs nothing special.
