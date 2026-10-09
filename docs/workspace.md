# Workspaces: files, commands and remote machines

**Status: agreed.**

Code: `core/src/workspace/` (settings, sandbox, home, SSH) and
`extension/src/workspace.ts` (the tools).

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
- Inside it are `/usr` (with the `/bin` and `/lib` links), a handful of `/etc`
  files (certificates, `resolv.conf`, `hosts`, `passwd`, `group`, the loader
  cache), `/proc`, `/dev`, an empty `/tmp`, the thread's folder at
  `/workspace`, and each grant at its own host path. Its environment is a
  fixed minimal set; nothing of `lyricad`'s is passed in.
- **Every operation is a fresh sandbox**, file reads and writes included, so
  paths and symlinks always resolve inside it. `read`, `write` and `edit`
  first refuse paths outside `/workspace` and the grants (and writes to
  read-only grants). The mounts confine her anyway: `bash` has no path checks.
- Folders are opened by `lyricad` and mounted by file descriptor
  (`--bind-fd`), after checking that the opened folder is exactly the granted
  path and that the grant is still allowed. A symlink swapped in by a running
  command can't redirect a mount.
- Command output past 20 KB is cut to its last 20 KB before Pi sees it. Pi
  would otherwise save long output to a plaintext temp file on the host.

**SSH targets** use an in-process SSH library (`ssh2`). Each private key is
stored in the user's encrypted settings and handed to the library in memory,
so it never touches disk, and no system `ssh` agent is involved.
- `lyrica admin ssh add` generates an ed25519 key and prints the public half
  to install on the remote account.
- The host key is pinned on first connection; a different key later fails.
- The root path check follows remote symlinks. Commands are not confined by
  it, only by the remote account.

## Grants: what she may touch

- **An administrator decides which host paths each user may grant**, with
  separate lists for that user's **general** and **private** pools. A general
  thread can only grant general paths. That keeps files meant for private work
  from being read in a thread that may use cloud models.
- **Each thread chooses its grants** from those lists, as read-only or
  read-write, much like choosing a working directory in Claude Code. A grant
  can be a listed folder or any folder inside one. The thread shows them next
  to the model badge.
- The rules, checked when settings change and again before every sandbox run:
  - A listed folder must be a real directory, with no symlinks on its path,
    and must not overlap Lyrica's runtime directory.
  - No folder may be in both lists, or overlap one in the other list.
  - A general thread can't take a folder that overlaps a private one.
  - A private thread may also take general folders, read-only, the same way
    private memory reads general memory.
  - One thread's grants don't nest inside each other.
- The lists live in `self.db` (`workspace_paths`, keyed by user ID), and only
  an administrator can change them, so no user can widen their own.
  `lyrica admin grants add|remove --user <u> --pool <pool> <path>` signs in as
  an administrator; `lyrica admin grants list --user <u>` needs only the
  `self.db` passphrase.
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
- On disk: `users/<id>/home.crypt` holds the ciphertext, mounted at
  `users/<id>/home`, with one folder per thread under `threads/`. A
  subagent works in its parent's folder. The gocryptfs password is the hex
  `home` subkey, passed on stdin.
- A file uploaded in the web UI goes into the thread's `uploads/` folder in the
  home workspace. `Workspace.saveUpload` writes it from inside a sandbox, so a
  symlink she left in `uploads/` can't point it anywhere else.
- An uploaded file is a file, not a memory. She notes what matters from it, as
  with anything else she reads.
- **Granted host paths outside the home workspace are ordinary files.** Their
  protection is whatever the host gives them.

## Thread settings

A workspace is not a separate kind of session. It's any thread that has
folders granted. Every thread has the same settings panel, and the current
values are always visible next to the model badge:

| Setting | What it controls |
|---|---|
| **Models** | Which model handles each task: the main conversation, cheap and strong subagents, compaction and titles. This follows the user's cloud or local profile unless overridden (see DESIGN.md, "Models and endpoints"). |
| **Local-only** | Whether every model call stays on the custom endpoint. Always on in private threads. |
| **Internet access for tools** | Whether `bash` and fetches inside the sandbox can reach the network. |
| **Folders** | The thread's grants, each read-only or read-write. |
| **Permission mode** | Ask before commands, ask before changes, or auto. |
| **Do not log thread in memory** | See [memory.md](memory.md#threads-that-arent-logged). |

## Network access from tools

Every thread has two switches and a list:
- **Internet:** anything off this machine.
- **This machine's services:** whatever listens on the host's loopback, TCP
  and UDP.
- **Allowed hosts:** IPs, CIDR ranges or hostnames (a URL is reduced to its
  host and port), each with an optional port. They are reachable even with
  internet off: a private thread can use one service on another PC on Li's
  LAN and nothing else.

Each user has defaults per pool, and each thread can override them. General
threads default to internet on, services off; private threads to everything
off, because otherwise a `curl` could send private content out.
`lyrica admin net show|set|hosts …` edits a user's defaults; per-thread
overrides go through `WorkspaceSettings.setThread` (the Web thread's UI).

How it is enforced:
- **Everything off:** bwrap's `--unshare-net`. The sandbox has only its own
  loopback.
- **Anything on:** `pasta` (from passt) gives the sandbox a network namespace
  of its own, with its own address (`10.255.255.2`), so the host's LAN
  address is just another machine to it. Inside that namespace, before the
  command starts, `nft` loads a default-deny output ruleset. It allows, in
  order:
  - replies on connections already made;
  - nothing to `lyricad`'s own ports, on any address (`Workspace`'s
    `excludePorts`, a required option, so forgetting it can't leave them
    open; `lyricad` passes its HTTP port);
  - the sandbox's loopback, where pasta forwards exactly the host's loopback
    ports, minus the excluded ones, when the services switch is on;
  - everything else, if internet is on;
  - each allowed host and port.
- bwrap then starts inside that namespace with every capability dropped, so
  the command can't change the rules or the namespace. The host's own network
  is never shared; bwrap's `--share-net` here keeps pasta's namespace.
- **Names:** allowed hostnames are resolved when the sandbox starts and pinned
  in its `/etc/hosts`. With internet off its `/etc/resolv.conf` is empty, so
  there is no DNS to carry data out. With internet on, DNS goes through
  pasta's forwarder to the host's resolver.
- Host abstract Unix sockets belong to the host's network namespace, so the
  sandbox never sees them. `lyricad`'s local socket is a file it never mounts.
- Host entries that match everything (`0.0.0.0/0`, any `/0`, `0.0.0.0`,
  `::`, broadcast) are refused; that is what the internet switch is for.
- **Self-test.** Whether a sandbox can undo its rules depends on the host
  kernel. `Workspace.selfTest()` starts a networked sandbox on the real host
  and tries `unshare -r` followed by `nft flush ruleset`, a plain
  `nft flush ruleset`, and a connection the rules block. If any of it works,
  or a networked sandbox can't start, network modes are refused: every thread
  runs with network off and `networkRefused` says why. `lyricad` runs it at
  startup, and `lyrica dev` prints the reason.
- IPv4 only for now: sandboxes run `pasta --ipv4-only`, and IPv6 host
  entries are refused until IPv6 is supported end to end.
- SSH targets don't depend on these switches: `lyricad`'s SSH client reaches
  them, not the sandbox. Model calls also come from `lyricad`, so local-only
  and the switches are independent.

## Subagents

A subagent works in its parent thread's workspace, under the same or stricter
settings:
- **Folders:** the parent's grants or a subset. Read-write can be narrowed to
  read-only, never the reverse.
- **Network:** each switch off if the parent's is off; the allowed hosts a
  subset of the parent's.
- **Models:** resolved through the router with the child thread's
  `CallContext`. In a local-only or private thread, only local models are
  available (see [models.md](models.md)).
- **Permission mode:** the parent's or stricter.

A subagent can never widen what its parent was given. `inheritSettings`
copies the parent's settings, or the narrower ones it is given, and the
subagent's settings are checked against its parent's whenever they change and
before every use. A subagent always uses its parent's target.

## Approval

The sandbox already limits what she can reach. Inside her grants she works
freely by default, following the principle that the harness should trust her
judgment and make review easy. Each thread has a **permission mode**:
- **Ask before commands**
- **Ask before changes**
- **Auto** (the default)

"Ask before commands" asks before `bash`. "Ask before changes" asks before
`bash`, `write` and `edit`, since a command can change files too. The
extension enforces both in Pi's `tool_call` event; with no one to ask, the
call is blocked.

Anything irreversible that leaves the server, such as sending a message,
deleting remote data or spending money, always asks.

## Tools

`read`, `write`, `edit` and `bash`, built from Pi's own tool definitions
with the thread's target looked up on every call, so changing a thread's
settings applies at once. Commands typed with `!` in the terminal go to the
same target. A short `workspace` prompt section tells her where she works,
what she was given and whether she has internet. Pi's `grep`, `find` and `ls` can be added
inside the 30-tool budget if `bash` turns out not to be enough. The memory tool
is `read_memory`, so it doesn't clash with `read`.

## Host requirements

The machine running `lyricad` needs:
- bubblewrap;
- gocryptfs;
- FUSE (`/dev/fuse` and `fusermount3`);
- passt (for `pasta`), nftables, and `/dev/net/tun`;
- unprivileged user namespaces.

In a Proxmox LXC container, turn on the **nesting** and **FUSE** features. A
VM needs nothing special.

**Checklist for Li's LXC container:**
1. In Proxmox, under the container's Options → Features, turn on `nesting`
   and `fuse` (or `features: nesting=1,fuse=1` in its config). For `pasta`,
   also pass the tun device through, in `/etc/pve/lxc/<id>.conf`:
   ```text
   lxc.cgroup2.devices.allow: c 10:200 rwm
   lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
   ```
   Then restart the container.
2. In the container: `apt install bubblewrap gocryptfs fuse3 passt nftables`.
3. `ls -l /dev/fuse /dev/net/tun` shows `crw-rw-rw-` for both, and
   `fusermount3` is setuid root.
4. As the service user, `bwrap --unshare-all --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 -- /bin/true`
   succeeds. On Ubuntu 24.04 or later, if it fails with "Permission denied",
   set `kernel.apparmor_restrict_unprivileged_userns=0` on the Proxmox host.
5. As the service user, `pasta --config-net -- true` succeeds.
6. Check the self-test passes: `lyricad` reports it at startup, and until
   `lyricad` exists, `lyrica dev` against a development runtime prints
   "network is off for every thread" with the reason if it fails. Until it's
   fixed, her tools have no network.
7. `LYRICA_HOME` is on a normal filesystem owned by the service user.
