# Workspaces: files, commands and remote machines

**Status: proposal for discussion.**

Lyrica works like a coding agent. She can read, write and edit files, run
commands, work on remote machines over SSH, reach shared drives, and work with
files a user uploads. She must not touch anything she wasn't given.

## Where the tools run

Lyrica uses Pi's standard `read`, `write`, `edit` and `bash` tools. Pi lets each
tool's file and process operations be swapped for another backend
(`createReadTool(cwd, { operations })` and so on). Lyrica's versions send every
operation to an **execution target**. Nothing runs inside `lyricad` or as its
operating-system user.

That matters because `lyricad` holds the unlocked keys in memory and owns the
database files. A command running as the same user could read both.

| Target | What it is | How she is confined |
|---|---|---|
| **Sandbox** (default) | Commands run on the Lyrica host as an unprivileged `lyrica-tools` user inside bubblewrap. | Only the directories granted to the thread are mounted, read-only or read-write. Lyrica's runtime directory, other users' files and `lyricad`'s process don't exist inside the sandbox. Network access follows the thread's rules (below). |
| **SSH** | A named remote machine. Its key is stored in the user's encrypted settings. | She is confined by the remote account's own permissions, which is why each target should use a dedicated account. An optional root path limits `read`, `write` and `edit`. If SSH fails, the action fails: it **never** falls back to running locally. |

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

## Uploads

- A file uploaded in the web UI goes into the thread's `uploads/` folder,
  inside the user's **home workspace**. Every thread can read its own uploads.
- An uploaded file is a file, not a memory. She notes what matters from it, as
  with anything else she reads.
- **At-rest encryption (proposed):** each user's home workspace is a gocryptfs
  folder, unlocked with that user's key at login and locked when the user's key
  is dropped. Files are then as protected as the user's memory, while tools
  still see ordinary files inside the sandbox.

## Network access from tools

| Thread | Default network for `bash` and fetches |
|---|---|
| General | Allowed |
| General, local-only | Allowed. Local-only governs model calls, not tool traffic. |
| Private | **Off**, except the custom model endpoint and explicitly listed LAN hosts or SSH targets. Otherwise a `curl` could send private content to the internet. |

## Approval

The sandbox already limits what she can reach. Inside her grants she works
freely by default, following the principle that the harness should trust her
judgment and make review easy. Each thread has a **permission mode**:
- **Ask before commands**
- **Ask before changes**
- **Auto** (the default for sandbox grants)

Anything irreversible that leaves the server, such as sending a message,
deleting remote data or spending money, always asks.

## Tool budget

These are four more tools: `read`, `write`, `edit` and `bash`. Pi's `grep`,
`find` and `ls` are left out, because `bash` covers them. The total becomes 12:

| Group | Tools |
|---|---|
| Files and commands | `read`, `write`, `edit`, `bash` |
| Memory | `remember`, `recall`, `read_memory` |
| Delegation | `delegate` |
| Integrations | `calendar`, `sort` |
| Research | `web_search`, `web_fetch` |

The memory tool `read` becomes `read_memory`, so it doesn't clash with Pi's
file `read`.
