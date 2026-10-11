# Workspaces: files, commands and remote machines

**Status: agreed.**

Code: `core/src/workspace/` (settings, sandbox, home, machines, SSH) and
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
| **Sandbox** (always there) | Each command runs on the Lyrica host inside bubblewrap. | The sandbox is described below. |
| **A machine** | One of Li's other computers, reached over SSH, when a call names it. | She is confined by the machine's own account, so each machine uses a dedicated account. An optional root path limits `read`, `write` and `edit`. If SSH fails, the action fails: it **never** falls back to running locally. See [Machines](#machines). |

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
- **Writes are atomic for files she owns.** `write` and `edit` write a temp
  file in the same folder, give it the old file's mode and group (or the
  usual mode for a new file), and rename it over the target. A read running
  at the same time sees the old file or the new one, never an empty or
  half-written one, and a failed write leaves the old file in place.
- **Files she doesn't own are written in place**, so they keep their owner,
  group and permissions: a file of Li's that `lyrica` may write through its
  group or an ACL stays Li's. The same goes for a file whose group can't be
  kept, or one in a folder she can't create files in. A read can then briefly
  see a partial file.
- A symlink at the target is refused, not followed or replaced.
- Folders are opened by `lyricad` and mounted by file descriptor
  (`--bind-fd`), after checking that the opened folder is exactly the granted
  path and that the grant is still allowed. A symlink swapped in by a running
  command can't redirect a mount.
- Command output past 20 KB is cut to its last 20 KB before Pi sees it. Pi
  would otherwise save long output to a plaintext temp file on the host.

## Machines

A machine is one of Li's other computers that she works on over SSH. The
SSH targets that existed before became general machines at Ask.

- **Kept in `user.db`** (`machines`): name, address, account, the private
  key, an optional root, the host key Li confirmed, the pool, the **mode
  limit**, whether the address is off network, and when she last
  connected. The key is generated in memory, stored only there, and handed to
  the SSH client in memory; she never sees it.
- **One pool each.** A general thread grants general machines and a private
  thread private ones (`setThread` refuses the other pool, and every call
  checks again). `setMachinePool` takes the machine from every thread that
  granted it, with any commands allowed there.
- **Threads grant machines** (`machines` in the thread's settings). `read`,
  `write`, `edit` and `bash` take an optional `machine`; without it they run
  in the sandbox. A subagent or child thread gets a subset of its parent's
  machines, and loses one at once when its parent does (`effective`). The
  `workspace` prompt section lists the thread's machines with their limits.
- **Mode on a machine** is the stricter of the thread's effective mode and
  the machine's limit (Ask, Accept edits or Auto; new machines start at
  Ask), read on every call (`Workspace.callMode`). Plan mode may `read` on a
  machine and nothing else.
- **The first call on a machine in a turn asks**, whatever the modes, if
  anything earlier in the turn ran somewhere else (the sandbox or another
  machine). A subagent counts its own turn: what its parent ran before
  doesn't count.
- **Approvals are bound to what was shown.** A request for a machine carries
  the machine, the command or path, and the folder a command runs in. The
  call runs only if its arguments are still exactly those; anything else is
  refused. A request is denied on Stop, on timeout, or with nobody to ask, so
  none outlives its turn.
- **Suspect commands always ask** on a machine, in every mode, with a warning
  sentence (`suspectCommand`, `SUSPECT_COMMANDS` in
  `core/src/workspace/machines.ts`): deleting `/`, `/*`, a home folder or a
  top-level system folder; `mkfs`; `dd` onto `/dev/…`; recursive `chmod`,
  `chown` or `chgrp` on `/`; `userdel` or `deluser`; `shutdown`, `reboot`,
  `poweroff`, `halt`, `systemctl reboot|poweroff|halt|kexec`, `init 0|6`;
  `qm destroy` and `pct destroy`. Wrappers such as `sudo`, `env`, `nice` and
  `timeout` (with their flag values), a program's path, and `bash -c '…'`
  are looked through; `cd / && rm -rf *` is not caught. The answer may say **Allow in this
  thread**: that exact command on that machine no longer asks in that
  thread, and nowhere else. The list is short and fixed, a warning layer and
  not the boundary: the boundary is the account's own rights and the
  root-owned keys file.
- **A floor no mode lifts:** `write` and `edit` on a machine refuse any path
  in a `.ssh` folder, under `/etc/ssh/`, or `/etc/sudoers*`, before and after
  following symlinks.
- **Output** of commands is capped as in the sandbox, stripped of terminal
  control sequences, and private-key blocks are replaced with `[private key
  removed]` (PEM and OpenSSH keys, and PGP private key blocks). `read`
  masks key blocks too; `edit` reads the file as it is, so
  writing it back keeps the key.
- **The host key is confirmed when the machine is added**, never pinned on
  first use: a machine with no key from before can't be reached until Li
  confirms one; a key pinned on first use before machines existed is kept
  as confirmed. A different key fails every call, with no
  fallback, until Li confirms the new one (`setHostKey`). Strict key
  exchange (`kex-strict-*`) is required. No agent, no forwarding.
- **Off network.** Before each connection the address is resolved and the
  connection goes to that address. If it resolves outside Li's LAN,
  loopback and tailnet (the model endpoints' check), the machine is marked
  off network. A private machine that has newly gone off network is refused
  until Li confirms (`confirmOffNetwork`), so a DNS change can't get past the
  warning; back on network clears the mark.
- **The SSH client** sits behind `SshTransport`
  (`core/src/workspace/transport.ts`): `SshTarget` keeps the root, the
  floor, the output cleaning and the host key check, and the transport only
  connects and moves bytes. The one transport, `sandboxedTransport`, runs
  `ssh2` outside `lyricad`, which holds every user's unlocked keys: each
  connection starts a **helper process** (`ssh-helper.ts`) in a sandbox of
  its own, so a server that breaks the library's parsing gets one key it
  could already use, not `lyricad`'s memory.
  - The helper's sandbox is the one above with no workspace: the read-only
    system, Node, the helper's own files and `ssh2` with its dependencies,
    read-only. Lyrica's runtime directory, databases and the rest of her
    code aren't there, and its process namespace hides `lyricad`.
  - Its network is exactly the machine's checked address and port, through
    the same `pasta` and nftables rules as an allowed host. `excludePorts`
    and the front door still apply. A machine on this host's loopback gets
    just that one port forwarded.
  - The private key goes to the helper on its stdin, never to a file or an
    environment variable.
  - `lyricad` and the helper speak length-prefixed frames (`ssh-frames.ts`):
    connect, exec with streamed output and kill, the SFTP operations the
    target uses. `lyricad` refuses oversized frames and more command output
    than the helper's cap allows; output is capped in the helper, before it
    crosses the pipe, and a file over 64 MB is refused rather than read.
  - The helper sends the server's host key to `lyricad`, which decides.
    Strict key exchange is required (OpenSSH 9.6, or a distribution's
    Terrapin fix, has it).
  - The helper exits when its stdin closes, so it never outlives `lyricad`.
    If it can't start, or the network self-test has refused networked
    sandboxes, the call fails; there is no client in `lyricad` to fall back
    to. It needs Node 22.6 or later (it runs with type stripping).
- **Writes** follow the sandbox's rule: for a file the account owns, an SFTP
  temp file with the old mode and group, then `posix-rename` (plain rename
  where the server lacks it); otherwise, or if the temp file can't be made,
  the file is written in place. The root path check follows remote
  symlinks. Commands are confined only by the account.
- **The record** is the thread: `write` and `edit` changes on a machine are
  recorded with snapshots like the sandbox's (target `ssh:<name>`), so
  removing the turns puts them back if the thread still has the machine.
  Commands on a machine can't be undone by Lyrica. The machine's own auth log
  records every login under the key's comment `lyrica:<login>:<machine>`.

**Adding a machine** (`Workspace.probeMachine`, then `addMachine`, or
`lyrica admin ssh add`): Lyrica makes a key pair and keeps it in memory for
an hour; nothing is saved until Li confirms the host key. The key's
`authorized_keys` line is `restrict,from="<Lyrica's addresses>" ssh-ed25519
…`, usable only from this computer. The setup, run as root on the machine:

```sh
# 1. Her key, in a file only root can change
install -d -m 755 /etc/ssh/authorized_keys
printf '%s\n' '<the key line>' > /etc/ssh/authorized_keys/<account>
chmod 644 /etc/ssh/authorized_keys/<account>
printf 'Match User <account>\n    AuthorizedKeysFile /etc/ssh/authorized_keys/%%u\n' > /etc/ssh/sshd_config.d/lyrica.conf
sshd -t && systemctl reload ssh

# 2. Optional: sudo for exact commands only (visudo -f /etc/sudoers.d/lyrica)
<account> ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx
```

The test then reads the host key the machine shows and tries the login,
and Li compares the fingerprint with `ssh-keygen -lf
/etc/ssh/ssh_host_ed25519_key.pub` on the machine before confirming. A
private machine that resolves off network needs a second confirmation.
Replacing the key (`setHostKey`) re-confirms the host key only; her own key
pair stays as it was. A test answers whatever the machine said (refused,
timed out), so any signed-in user can learn whether an address answers on
a port, as they could from a sandbox with network.

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
- **What her write and edit calls change is recorded**, so removing the
  turns that made a change can undo it (`core/src/workspace/changes.ts`).
  `user.db` has `file_changes`: the call, the target (`sandbox` or
  `ssh:<name>`), the path, whether the call made the file, and the hash it
  left; no content. What the file held before is a snapshot in the home
  workspace's `snapshots/` folder, outside every thread's folder. A file that
  exists but can't be read first isn't recorded. Undoing a change deletes a
  file the turns made, or puts back the snapshot, and only when the file
  still has the hash they left: something changed it since, so it is kept.
- **The nightly sweep** (`daemon/src/sweep.ts`), for each user whose home is
  mounted: change records and snapshots older than 30 days, snapshots no
  record names, the folders of threads that no longer exist, and subagent
  worktrees whose run isn't live and that haven't changed in 30 days. Before
  a worktree goes, git's record of it (`.git/worktrees/<name>` in its
  repository) goes too, so git no longer counts its branch as checked out:
  only in a folder the user may grant, and only a record that names that
  worktree back. (`git worktree prune` can't do it: the records name the
  sandbox's paths.) It logs counts only.
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
| **Mode** | Ask, Accept edits, Plan or Auto (see Approval). |
| **Web search, Images** | Switches for `web_search` and `web_fetch`, and for `image`. On unless turned off. |
| **Do not log thread in memory** | See [memory.md](memory.md#threads-that-arent-logged). |

## Network access from tools

Every thread has two switches and a list:
- **Internet:** anything off this machine.
- **This machine's services:** whatever listens on the host's loopback, TCP
  and UDP, or on the host's own addresses (except lyricad's front door).
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
  - nothing to `lyricad`'s front door, read when each sandbox starts
    (`Workspace`'s `frontDoor`, which `lyricad` gives from its web access
    settings): its port (443, or the external proxy's own) on this
    machine's own addresses, on every address Lyrica's name has resolved to,
    and on an external proxy's addresses; and an extra listener's port on
    every address. If the name has never resolved, that run gets no network
    at all;
  - this machine's own addresses (LAN, Tailscale; read from its interfaces
    when each sandbox starts) only with the machine's-services switch on.
    Internet and allowed hosts never reach this machine, so a command can't
    reach `lyricad` through a proxy;
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
  startup (administrators see the reason in the control panel), and
  `lyrica dev` prints it.
- IPv4 only for now: sandboxes run `pasta --ipv4-only`, and IPv6 host
  entries are refused until IPv6 is supported end to end.
- Machines don't depend on these switches: each connection's helper gets
  network to its machine alone, whatever the thread's switches say. If the
  self-test refuses network, machine calls fail too. Model calls come from
  `lyricad`, so local-only and the switches are independent.

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
- **Mode:** the parent's or stricter, in the order Plan, Ask, Accept edits,
  Auto.
- **Switches:** each off if the parent's is off.
- **Machines:** the parent's or a subset.

A subagent can never widen what its parent was given. `inheritSettings`
copies the parent's settings, or the narrower ones it is given, and the
subagent's settings are checked against its parent's whenever they change and
before every use. What its tools follow is `effective(thread)`: its own
settings with the strictest mode and switches of every ancestor, read on each
call, so a parent switched to Plan, with a switch turned off or with a
machine taken away narrows its subagents at once. Parallel
writers get their own git worktrees (see [delegation.md](delegation.md)).

## Approval

The sandbox already limits what she can reach. Inside her grants she works
freely by default, following the principle that the harness should trust her
judgment and make review easy. Each thread has a **mode**:
- **Ask** (`ask`): asks before `bash`, `write` and `edit`, since a command
  can change files too.
- **Accept edits** (`acceptEdits`): asks before `bash`.
- **Plan** (`plan`): only `read`, `recall`, `read_memory`, `web_search`,
  `web_fetch`, `delegate` with read-only roles, a subagent's `ask_parent`,
  `threads` (her child threads, and compacting her context) and
  `propose_plan` are active. A child thread of a Plan-mode thread is in
  Plan mode too.
- **Auto** (`auto`, the default): works freely inside the grants.

A new thread starts in the user's default mode (`defaultMode`,
`startThread`). Stored modes from before Plan mode are renamed in place:
"ask before changes" became `ask`, "ask before commands" `acceptEdits`.

The extension enforces the asking in Pi's `tool_call` event, through the
`approve` callback `lyricad` passes in (every open view of the thread sees the
request; see [daemon.md](daemon.md#permission-prompts)); with no one to ask, the
call is blocked.

**Plan mode and the switches** decide which tools the session has
(`setActiveTools`, through `setToolsOff` in `extension/src/gate.ts`, which
lets the workspace, the unlogged rule and a subagent's role each turn tools
off without undoing the others). What's off isn't declared to the model,
can't be run, and a call to it is refused in `tool_call` as well. Tools are
set again before every turn and when a plan is approved.

`propose_plan({ plan })` shows the plan through the same path as an approval
(`proposePlan`): the user picks Ask, Accept edits or Auto to go ahead in, or
keeps planning. Approving switches the thread's mode (`setMode`), turns the
tools back on, and she carries on with the plan in the same turn. A branch
of a thread in Plan mode stays in Plan mode, and she is told so. A subagent
has no `propose_plan` and can't change its mode. Without `lyricad`, Pi's own
UI asks; with no UI she keeps planning.

Anything irreversible that leaves the server, such as sending a message,
deleting remote data or spending money, always asks, whatever the mode: a tool
annotated as reaching outside (`openWorldHint`) and not read-only.

## Tools

`read`, `write`, `edit` and `bash`, and `propose_plan` in a thread that isn't a subagent, built from Pi's own tool definitions
with the call's target (the sandbox, or the machine its `machine` argument
names) looked up on every call, so changing a thread's settings applies at
once. Commands typed with `!` in the terminal run in the sandbox. A short
`workspace` prompt section tells her where she works, what she was given,
whether she has internet, and her machines. Pi's `grep`, `find` and `ls` can be added
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
6. Check the self-test passes: if it fails, `lyricad` logs "network is off
   for every thread" with the reason when it unlocks (`journalctl -u
   lyricad`), and the control panel shows it. Until it's fixed, her tools
   have no network.
7. `LYRICA_HOME` is on a normal filesystem owned by the service user.
