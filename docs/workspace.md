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
A `bash` call with no `timeout` gets `BASH_TIMEOUT_S` (600 seconds), so a
command that never ends (a test whose browser never closes) can't hold the
thread; she gives a longer one for a long build.

That matters because `lyricad` holds the unlocked keys in memory and owns the
database files. A command that could see either one could read everything.

| Target | What it is | How she is confined |
|---|---|---|
| **Sandbox** (always there) | Each command runs on the Lyrica host inside bubblewrap. | The sandbox is described below. |
| **A machine** | One of the owner's other computers, reached over SSH, when a call names it. | She is confined by the machine's own account, so each machine uses a dedicated account. An optional root path limits `read`, `write` and `edit`. If SSH fails, the action fails: it **never** falls back to running locally. See [Machines](#machines). |

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
- On NixOS (`LYRICA_SANDBOX_TOOLS` set, docs/daemon.md "On NixOS") the
  system is the module's sandbox tools instead: they are `/usr`, with `/bin`
  and `/sbin` linking to `usr/bin`, and only the store paths listed in
  `LYRICA_SANDBOX_CLOSURE` (the tools' closure, Node's and the CA bundle's)
  are in `/nix/store`, never the whole store, which holds the system's
  generated configs. Lyrica's own package isn't among them. Both must be
  store paths and the list must contain the tools, or the sandbox refuses
  to start. Their `bin` is also first on the `PATH` lyricad starts `pasta`,
  `nft` and `bwrap` with.
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
  group and permissions: a file of the user's that `lyrica` may write through its
  group or an ACL stays the user's. The same goes for a file whose group can't be
  kept, or one in a folder she can't create files in. A read can then briefly
  see a partial file.
- A symlink at the target is refused, not followed or replaced.
- Folders are opened by `lyricad` and mounted by file descriptor
  (`--bind-fd`), after checking that the opened folder is exactly the granted
  path and that the grant is still allowed. A symlink swapped in by a running
  command can't redirect a mount.
- Command output past 20 KB (or 800 lines) is cut to the first 20 KB and the
  last 20 KB, with a note of what was left out, before Pi sees it. Pi would
  otherwise save long output to a plaintext temp file on the host.

## Machines

A machine is one of the owner's other computers that she works on over SSH, or a
Proxmox she manages over its API ([below](#proxmox)). The SSH targets that
existed before became general machines at Ask.

- **Kept in `user.db`** (`machines`): name, address, account, the private
  key, an optional root, the host key the user confirmed, the pool, the **mode
  limit**, whether the address is off network, when she last
  connected, and how the last connection went (online, unreachable, or host
  key changed) and since when. That state clears when the address or host key
  changes. The key is generated in memory, stored only there, and handed to
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
  `qm destroy` and `pct destroy`; and on a Proxmox machine the `stop` and
  `reboot` actions (`PROXMOX_SUSPECT`). Wrappers such as `sudo`, `env`, `nice` and
  `timeout` (with their flag values), a program's path, and `bash -c '…'`
  are looked through; `cd / && rm -rf *` is not caught. The answer may say **Allow in this
  thread**: that exact command on that machine no longer asks in that
  thread, and nowhere else (for Proxmox, that action on that VM:
  `suspectKey`). The list is short and fixed, a warning layer and
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
  first use: a machine with no key from before can't be reached until the user
  confirms one; a key pinned on first use before machines existed is kept
  as confirmed. A different key fails every call, with no
  fallback, until the user confirms the new one (`setHostKey`). Strict key
  exchange (`kex-strict-*`) is required. No agent, no forwarding.
- **Off network.** Before each connection the address is resolved and the
  connection goes to that address. If it resolves outside the owner's LAN,
  loopback and tailnet (the model endpoints' check), the machine is marked
  off network. A private machine that has newly gone off network is refused
  until the user confirms (`confirmOffNetwork`), so a DNS change can't get past the
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
an hour; nothing is saved until the user confirms the host key. The key's
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
and the user compares the fingerprint with `ssh-keygen -lf
/etc/ssh/ssh_host_ed25519_key.pub` on the machine before confirming. A
private machine that resolves off network needs a second confirmation.
Replacing the key (`setHostKey`) re-confirms the host key only; her own key
pair stays as it was. A test answers whatever the machine said (refused,
timed out), so any signed-in user can learn whether an address answers on
a port, as they could from a sandbox with network.

## Proxmox

A Proxmox machine (`kind: "proxmox"`) is reached over Proxmox's HTTPS API
with a token, never a shell on the hypervisor
(`core/src/workspace/proxmox.ts`).

- **Kept like an SSH machine**, in the same `machines` table: the address
  (`https://host:8006`), the token (`user@realm!tokenid=secret`) where an
  SSH machine keeps its private key, the token's id where it keeps the
  account, the SHA-256 fingerprint of the TLS certificate the user confirmed
  (`AB:CD:…`) where it keeps the host key, the pool, the mode limit and the
  off-network mark. No root. The token is never shown to her, in the API
  (`MachineInfo` has `tokenId` only) or in the log.
- **The certificate is pinned.** Each call opens a TLS connection, checks the
  certificate's fingerprint, and only then sends the request with the token
  over that same connection. A different certificate fails every call, with
  no fallback and nothing sent, until the user confirms the new fingerprint
  (`setHostKey`, which may also take a new token). The address is checked
  for off network before each call, as for SSH.
- **One tool, `proxmox`** (`extension/src/proxmox.ts`), with `machine`,
  `action` and `vm` (number or name): `list` (VMs and containers the token
  can see), `status`, `snapshots` (list only), `start`, `shutdown`, `stop`
  and `reboot`. Each action is one API call after looking the VM up in
  `/cluster/resources`. Nothing else: no destroy, create, console,
  guest-agent, snapshot creation or rollback. The tool is offered only while
  the thread has a Proxmox machine. Subagents don't get it.
- **Modes.** `list`, `status` and `snapshots` ask like `read` (never, by
  themselves) and work in Plan mode. `start` and `shutdown` ask like `bash`
  under the stricter of the thread's mode and the machine's limit. `stop`
  and `reboot` are suspect: they ask with a warning in every mode until
  allowed in the thread. Plan mode refuses everything but reading. `read`,
  `write`, `edit` and `bash` refuse a Proxmox machine.

**Adding a Proxmox** (`probeMachine` with `kind: "proxmox"`, then
`addMachine`, or `lyrica admin proxmox add`): the test reads only the
certificate's fingerprint and gives the setup steps; the token isn't sent
until the user confirms the fingerprint. Confirm then tries the token
(`/version`) against that certificate, refuses the Proxmox that runs
Lyrica's own VM where it can tell, and saves only if both pass. That
refusal (`ownNode`) covers an address that is this computer or its default
gateway, and a cluster with a guest that has this computer's name or one of
its network cards' MAC addresses (read from each guest's config, up to 300
guests, a few at a time). Its message says which; there is no way past it.
The address part is checked again when the address changes and before
every call, so a machine moved (or resolving) onto this computer's gateway
is refused before the token is sent.

The setup, as root on the Proxmox node:

```sh
# 1. A user and a role that can see VMs and power them, nothing more
pveum user add lyrica@pve --comment Lyrica
pveum role add LyricaPower --privs "VM.Audit VM.PowerMgmt"
pveum user token add lyrica@pve agent --privsep 1

# 2. Reads everywhere; power only on the VMs she may manage (repeat per VM, or use /pool/<name>).
#    A separated token has only what both it and its user have, so both get each role.
pveum acl modify / --roles PVEAuditor --users lyrica@pve --tokens 'lyrica@pve!agent'
pveum acl modify /vms/101 --roles LyricaPower --users lyrica@pve --tokens 'lyrica@pve!agent'

# Never PVEVMUser: its console and guest-agent rights run code in the guest. Never Sys.PowerMgmt.

# The certificate's fingerprint, to compare with the one Lyrica shows
openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pveproxy-ssl.pem 2>/dev/null || openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pve-ssl.pem
```

`pveum user token add` prints the token's secret once; the token Lyrica
takes is `lyrica@pve!agent=<that secret>`.

## Grants: what she may touch

- **An administrator decides which host paths each user may grant**, with
  separate lists for that user's **general** and **private** pools. A general
  thread can only grant general paths. That keeps files meant for private work
  from being read in a thread that may use cloud models.
- **Each thread chooses its grants** from those lists, as read-only or
  read-write, much like choosing a working directory in Claude Code. A grant
  can be a listed folder or any folder inside one. The thread shows them next
  to the model badge. With a read-write grant, her prompt says to build and
  save the work there (or in a repository), not as loose files in her own
  folder.
- The rules, checked when settings change and again before every sandbox run:
  - A listed folder must be a real directory, with no symlinks on its path,
    and must not overlap Lyrica's runtime directory (which holds the update
    requests), the releases (`/opt/lyrica`), the updater's state and
    snapshots (`/var/lib/lyrica-update`, `/var/lib/lyrica-snapshots`) or
    Caddy's runtime directory. A row that overlaps one of them, whenever it
    was listed, doesn't count.
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
- **Repositories** are granted to threads like folders, each from a Git
  account in Settings (Git accounts and repositories, below).

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
- `codex/` there is Codex's home for ChatGPT Images (`Workspace.codexDir`,
  docs/models.md, "Image canvases"): its sign-in and anything it writes,
  encrypted like the rest. It is the only folder in Codex's own sandbox
  (`Workspace.codexBox`). Each image call's inputs go in `calls/<id>` there,
  removed after the call with `generated_images/`, where Codex saves
  images, whether the call worked or not. No thread sees it.
- A file uploaded in the web UI goes into the thread's `uploads/` folder in the
  home workspace, apart from the `images/` folder her image tool writes.
  An image keeps its extension but gets a random 12-hex-digit name
  (`uploads/7f3a9c2e4b1d.png`), so a phone's `IMG_1234.jpg` or a telling
  filename never reaches her context or the thread; other files keep their
  name. `Workspace.saveUpload` writes it from inside a sandbox, so a
  symlink she left in `uploads/` can't point it anywhere else.
- **The Files panel** (`core/src/workspace/files.ts`, `Workspace.files(t)`)
  lists, searches, reads, uploads, renames, deletes and zips in the thread's
  folder and its grants, every operation a fresh no-network sandbox over the
  thread's grants (`find`, `cat`, `stat`, `mkdir`, `mv`, `rm`), so the panel
  can reach exactly what she can and nothing else: a path outside, a symlink
  out, a root, the panel's own `.lyrica` folder, and any change in a
  read-only grant are refused (`FilesRefused`). Uploads land under a free name,
  as in the message box. Adds and removes are noted (`panel_files` in
  `user.db`) and told to her once, at her next turn, by `ThreadTools.fileNotes`.
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
  record names, the folders (and Claude Code folders) of threads that no
  longer exist, and subagent worktrees whose run isn't live and that
  haven't changed in 30 days. Before
  a worktree goes, git's record of it (`.git/worktrees/<name>` in its
  repository) goes too, so git no longer counts its branch as checked out:
  only in a folder the user may grant, and only a record that names that
  worktree back. (`git worktree prune` can't do it: the records name the
  sandbox's paths.) It logs counts only.
- **Granted host paths outside the home workspace are ordinary files.** Their
  protection is whatever the host gives them.

## Images and portrait photos

The `image` tool creates, edits and upscales through the thread's model router.
It names inputs by workspace path: uploads, earlier results or granted files.
Create takes a prompt, fast or quality, optional size or `width:height` aspect
ratio, count and references. Edit takes an image path, instruction, optional
mask and references. Upscale takes an image, optional scale and maximum size.
Ratios become a canvas near one megapixel, on a 16-pixel grid; GPT Image 1
cloud models use their nearest supported canvas shape. Without size or count,
host recipe defaults apply. Neither tier overrides a host recipe's settings.

Each user's mounted home also has `photos-of-me/`, outside the thread folders
and sandbox grants. The tool reaches it through `/photos-of-me/<file>` (or
`photos-of-me/<file>`). `Workspace.imageFiles(t).read` marks these inputs as
portraits, sniffs PNG/JPEG/WebP and limits each to 20 MB. It refuses traversal
and symlinks; ordinary workspace images are read through the thread's Files
sandbox under its current grants.

Images made from portraits follow the same rule. `ThreadImages.save(images,
portrait)` records each cleaned result's SHA-256 in encrypted `user.db` settings
before writing it; `read` checks that hash for every workspace input. Copies
and renames retain the rule, and a result used to make another result passes it
on. A copy re-encoded in the sandbox (say, to JPEG) has other bytes and isn't
caught. Only hashes are stored, under additive `images.portrait.sha256.<hash>` keys
in the existing settings table; no schema change or prompt metadata is needed.

`WorkspaceSettings.photoCloudPolicy()` is Never, Ask once a day (default), or
Always (`never`, `ask`, `always`), in encrypted `user.db` settings. User schema
5 adds its default, preserving every previous schema and keeping the oldest
reader at 1. `setPhotoCloudPolicy` clears any previous daily approval.
When an input, mask or reference is a portrait, the tool checks the actual
resolved endpoint before each call, including fallback attempts. Never is a
plain refusal for cloud sends; Ask shows `Send photos of you to <endpoint>?` through the existing
approval flow, denies without a viewer, and retains a yes for that user until
server-local midnight. The approved day is encrypted in `user.db`, so it works
across threads and restarts. Always and local models need no portrait approval.
The request includes the resolved model label as `input.model`, so the web
permission card names the model and offers Send today and Not today.
The clock is injectable for tests; a policy or local-only change while approval
is pending is checked again before sending.

Results have exclusive `images/<uuid>.png` names under the thread's encrypted
folder, following its shared project/parent folder where applicable. Writes
require an unlocked key and mounted home, follow no symlinks, and strip PNG
metadata. Nothing stores a prompt beside an image. The text result names the
model and host or endpoint that made the image. Pi gets the bytes as image
content so Lyrica can look and try again; messages and `tool_end` carry paths,
model label and the create tier. The prompt stays only in the encrypted tool
call. The Images switch and Plan mode disable the tool.

The daemon's `GET …/threads/:pool/:threadId/file?path=/workspace/images/<file>`
serves only the authenticated user's thread folder, never grants or portraits.
It sniffs Content-Type, sends `Cache-Control: no-store`, and returns 404 for
another user's files, traversal and symlinks. `ThreadImages.content(path)`
anchors every directory and the regular file without following symlinks.
`Workspace.photos(userId)` lists, uploads and deletes portraits in the mounted
home; uploads are at most 20 MB, PNG/JPEG/WebP, with metadata stripped and
exclusive generated names. Management and policy routes are in
[daemon.md](daemon.md#images-and-portrait-photos).
Its `content(name)` serves one sniffed PNG/JPEG/WebP to the owner's UI and
refuses traversal, symlinks and non-images.

For exact wireframes and diagrams, write HTML or SVG in the encrypted thread
folder, turn Internet and Local services off and leave allowed hosts empty,
then run this through `bash` (replace the input filename for SVG):

```sh
mkdir -p images
browser=$(command -v chromium || command -v chromium-headless-shell || command -v chromium-browser)
"$browser" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check --user-data-dir=/tmp/chromium \
  --screenshot=/workspace/images/diagram.png --window-size=800,600 \
  file:///workspace/diagram.html
```

The outer bubblewrap sandbox provides isolation and no network; Chromium's
profile is on its temporary tmpfs. NixOS includes Chromium and fonts through
`nix/sandbox-tools.nix` and the module's read-only closure. Debian/Ubuntu's
`daemon/deploy/install.sh` installs `chromium-headless-shell` under `/usr`.
`npx vitest run core/test/image-render.test.ts` renders inside a real encrypted
home with internet off, using `describe.skipIf` when Chromium or the encrypted
sandbox prerequisites are missing.

`npx vitest run core/test/image-storage.test.ts extension/test/images.test.ts`
checks these boundaries without sockets. The real encrypted-home test skips
when FUSE/gocryptfs isn't available; CI's `LYRICA_SANDBOX_TESTS=require` requires
it. Other storage tests use synthetic bitmap bytes in a stand-in home.

## Thread settings

Core stores a `code` preference in `thread_workspaces` (user step 14), off
by default. `inheritSettings` copies it at creation; a child can change it
independently of its ancestors. It never changes Mode or grants.
Thread settings GET/PATCH carry `code`. The `threads` action `code` takes
`on`, optional `task` (300 characters) and `done` (1,200 characters); it
emits `settings` and applies from the next turn. Subagents cannot call it.
A project's `threadsCode` API choice applies to child and routine threads,
with `threadsModel`; unset, they inherit their parent's code preference.
The choice lives in encrypted user settings as `project.code.<pool>/<id>`,
and forgetting the project removes it. No additional migration is needed.
Code turns read branch and at most ten commit subjects since origin's
default branch with fixed git argv in the sandbox; no fetch or model call
is made. The forge watcher supplies its last known open PR check metadata,
cleared on Lock. An unavailable checkout is reported without blocking chat.

A workspace is not a separate kind of session. It's any thread that has
folders granted. Every thread has the same settings panel, and the current
values are always visible next to the model badge:

| Setting | What it controls |
|---|---|
| **Models** | Which model handles each task: the main conversation, cheap and strong subagents, compaction and titles. This follows the thread's preset or the user's General / Private column unless overridden (see DESIGN.md, "Models and endpoints"). |
| **Local-only** | Whether every model call stays on the custom endpoint. Always on in private threads. |
| **Internet access for tools** | Whether `bash` and fetches inside the sandbox can reach the network. |
| **Folders** | The thread's grants, each read-only or read-write. |
| **Machines** | The SSH accounts and Proxmox nodes the thread may use (Machines). |
| **Repositories** | The repositories the thread clones, each with the Git account it uses (Git accounts and repositories). |
| **Code mode** | Focuses the persona, memory and tools on coding and selects the Coding task; editable under Behaviour, and for new project threads under General → New threads. |
| **Mode** | Ask, Accept edits, Plan or Auto (see Approval). |
| **Web search, Images** | Switches for `web_search` and `web_fetch`, and for `image`. On unless turned off. |
| **Claude Code** | Whether her sandbox runs can use Claude Code on the user's Claude plan (Claude Code). Off unless turned on; shown only in a general thread that isn't local-only, once a token is saved and the program is installed. |
| **Do not log thread in memory** | See [memory.md](memory.md#threads-that-arent-logged). |

## Network access from tools

Every thread has two switches and a list:
- **Internet:** anything off this machine.
- **Local services (localhost)**: whatever listens on the host's loopback, TCP
  and UDP, or on the host's own addresses (except lyricad's front door).
- **Allowed hosts:** IPs, CIDR ranges or hostnames (a URL is reduced to its
  host and port), each with an optional port. They are reachable even with
  internet off: a private thread can use one service on another PC on the owner's
  LAN and nothing else.

Each user has defaults per pool, and each thread can override them. General
threads default to internet on, services off; private threads to everything
off, because otherwise a `curl` could send private content out.
`lyrica admin net show|set|hosts …` edits a user's defaults; per-thread
overrides go through `WorkspaceSettings.setThread` (the Web thread's UI).

How it is enforced:
- **Everything off:** bwrap's `--unshare-net`. The sandbox has only its own
  loopback.
- **Anything on:** `unshare` makes a user and network namespace of the
  sandbox's own and `pasta` (from passt) attaches to it by PID, giving it its
  own address (`10.255.255.2`), so the host's LAN address is just another
  machine to it. pasta doesn't start the command itself, because since 2024
  it closes every file it inherits, and bwrap needs the folders and files
  `lyricad` opened. Inside that namespace, before the command starts, `nft`
  loads a default-deny output ruleset (a failure refuses the run). It
  allows, in order:
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
  is never shared; bwrap's `--share-net` here keeps the namespace pasta
  serves. pasta quits when the namespace is gone, and `lyricad` stops it
  when the command exits.
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
- IPv4 only: sandboxes run `pasta --ipv4-only`, and IPv6 host entries are
  refused.
- Machines don't depend on these switches: each connection's helper gets
  network to its machine alone, whatever the thread's switches say. If the
  self-test refuses network, machine calls fail too. Model calls come from
  `lyricad`, so local-only and the switches are independent.

## Web

The **Web search** switch gives her two tools (`extension/src/web.ts`,
`core/src/web.ts`):
- `web_search` asks the server's one SearXNG, set by an administrator in
  Administration → Web search, from `lyricad`. It is offered only while an
  address is set, in every thread, private and local-only included.
  SearXNG hides who is asking from the search engines it uses, but forwards
  the query text to them, so a private thread's query leaves her network as
  an anonymous query. Setting one up, or letting `install.sh` run one in
  Docker and fill in the address: [guides/searxng.md](guides/searxng.md).
- `web_fetch` runs `curl` in the thread's sandbox, the URL one argument,
  so the internet switch and allowed hosts above decide what it can reach:
  a private thread with internet off reads only its allowed hosts. It
  follows up to 5 redirects, gives up after 20 seconds or 2 MB, and reads
  only http and https. `lyricad` turns HTML into text with html-to-text
  (headings, paragraphs, list items, links with their URL; no scripts,
  styles or navigation), passes text and JSON through, refuses other types,
  and cuts the result to `maxChars`, saying so. Nothing is written to disk.

## Git accounts and repositories

She works on code the way Claude's project threads do: a project lists
repositories, every thread of it clones its own copy, and the credentials
come from the user's Git accounts (DESIGN.md, "Updates and self-editing").

- **A Git account** is a row in Settings → **Git accounts**, kept in the
  user's `user.db` (`git_accounts`): a name, a kind (GitHub, Forgejo, Gitea
  or Other), a host, the account's login, a token never shown back, and a
  pool. Adding one, or replacing its token, checks the token against the
  host first (GitHub's `/user`, Gitea's and Forgejo's `/api/v1/user`, and
  the login must be the account's; Other only checks that the host
  answers) and saves nothing when that fails. Each use records Signed in,
  Token rejected or Unreachable. A GitHub account is general only. A
  private account's host must resolve on her own network (LAN, loopback or
  the tailnet, as for private machines); when it stops doing so the
  account is Off network and no token goes out until the user confirms
  **Use anyway**. A new pool, or removing the account, takes its
  repositories from every thread at once.
- **A thread's repositories** (`owner/name` and the account each uses) are
  granted like folders: the Repositories row in the thread drawer and
  under This chat on Project settings, so a project's threads get the
  project chat's list or fewer. A child or subagent gets a subset, never
  more, and a parent's change narrows its running children at once. She can
  add one herself with `add_repository`, from an account of the thread's
  pool; it always asks the user with a permission card, and is off in Plan
  mode or when the pool has no Git account.
- **Clones.** At the start of each turn, `cloneFor` clones each repository
  into the thread's own folder in the home workspace (`repos/<name>`,
  mounted at `/workspace/repos`; a subagent uses its parent's, read-only
  unless it is an unnarrowed writer) or fetches
  it, in the sandbox with that run's credential. A clone that fails is a
  line in the turn's prompt, not an error. A clone stays when its
  repository leaves the thread, since it may hold unpushed work; it goes
  with the thread's folder when the sweep removes it. Two threads never
  share a working tree.
- **Credentials** never enter the sandbox. A run with repositories or Claude Code gets
  its own relay (`openRelay`, `core/src/workspace/relay.ts`): a server in
  `lyricad` on a random loopback port, forwarded into the run's sandbox
  like a machine on `127.0.0.1`, that lives as long as the run and logs
  and keeps nothing. The run's environment holds a random placeholder for
  each repository's token and a random capability that opens the relay
  (`gitEnv` in `core/src/workspace/sandbox.ts`), never argv or a file in
  the workspace. git reaches each repository's URL through the relay as
  its HTTPS proxy (`http.<url>.proxy` through git's `GIT_CONFIG_*`
  environment), with a credential helper per repository URL
  (`useHttpPath`) that gives the placeholder, so another repository on the
  same host gets nothing. For a Git host the relay ends TLS itself, with a
  certificate from an authority made in memory for this run
  (`core/src/workspace/certs.ts`, at `/run/lyrica/certs/run.pem` in the
  run), and swaps the placeholder for the token only on that repository's
  Git paths (`/<owner>/<name>.git/…`) and its host's API (`api.github.com`
  and `uploads.github.com` for GitHub, `/api/` on GitHub Enterprise,
  `/api/v1/` on Forgejo and Gitea). A placeholder anywhere else is
  refused, and a request without one goes as it is. The relay goes only
  to hosts the run's network reaches, trusting the system's certificate
  authorities as well as Node's (Node before 22.15: Node's only), and with
  internet on it also passes
  through, untouched, gh's downloads (`*.githubusercontent.com`,
  `codeload.github.com`, `*.blob.core.windows.net`); everything else is
  refused. A run gets a repository's token only when the thread's pool is
  the account's, the thread has the repository, and the run can reach the
  host: internet on, or the host as an allowed host (`api.github.com` too,
  for `gh` on GitHub) (`Workspace.credentialsFor`). A command that reads
  the environment learns only values that die with the run; what a token
  can do on its own host is still up to the token, so tokens stay
  fine-grained, for the repositories she works on, with no admin rights.
  What she sees has them hidden too: `bash` output, `read` and `web_fetch`
  pages show "[credential hidden]" for a run's tokens and placeholders
  (`Sandbox.secrets`, `secretMasker`; `edit` reads the file as it is), and
  a `web_search`, `web_fetch` or MCP call whose input holds one is
  refused.
- **`gh` and `tea`** are wrapped (`core/src/workspace/forge.sh`, mounted at
  `/run/lyrica/bin`, first on the PATH of a run with repositories): each
  takes the placeholder of the account whose repository the current
  clone's `origin` is, so two accounts on one host never mix, and none
  outside such a clone, and goes through the run's relay
  (`HTTPS_PROXY`), trusting the run's authority (`SSL_CERT_DIR`) as well
  as the system's. `tea` reads logins only from a file, so its wrapper writes one
  under `/tmp`, the run's own tmpfs, gone when the run ends. There is no
  model-facing tool for a forge beyond `add_repository`. On NixOS the
  sandbox's tools include `git`, `gh`, `tea` and Node 22; on Debian,
  `install.sh` installs `gh` and `tea` where they are packaged.
- **The Git guide** (`extension/src/git.md`) is in the prompt of every turn
  of a thread with repositories, with the repository list and their
  folders: a branch per piece of work, never commits on the default
  branch, merge or rebase the base before pushing, a pull request (then
  `lyricad` wakes the thread when its checks finish or someone reviews
  it), read a failing check's log and never merge on red, the merge
  queue where there is one, delete merged branches. The project's instructions win where they differ.

## MCP servers

A service with an MCP server (Home Assistant, a calendar, a docs site)
gives her its tools through Pi's own MCP client (DESIGN.md, "MCP servers").

- **A server** is a row in Settings → **MCP servers**, kept in the user's
  `user.db` (`mcp_servers`, user step 3): a name (letters, digits, `-`
  and `_`), a URL, an optional token never shown back, a pool, and the
  description and tool count from its last check. Only remote servers
  (streamable HTTP): a stdio `command` is refused. Adding one, or replacing
  its token, runs `initialize` and `tools/list` first (`probeMcp` in
  `core/src/workspace/mcp.ts`) and saves nothing when that fails. A
  general server with a token must use https. A private server's host
  must resolve on her own network, as for a private Git account, with
  **Off network** and **Use anyway** when it stops doing so. A private
  server is registered, and so connected and sent its token, only once
  its host has passed that check in this `lyricad` process (after a
  restart: at session start, before Pi connects anything). The check
  resolves DNS separately from the connection, so DNS rebinding isn't
  prevented, as for private Git accounts. Each use records Online, Token
  rejected (401 or 403) or Unreachable.
- **A thread's servers** are granted like repositories: the MCP servers
  row in the thread drawer and under This chat on Project settings, so a
  project's threads get the project chat's servers or fewer. A private or
  local-only thread takes only private servers, a general thread only
  general ones. A new pool, removing a server, or taking it off a project
  takes it from running threads at once: the next call to it is refused.
- **In a session** (`createMcpServersExtension`, `extension/src/mcp.ts`)
  each granted server is registered with Pi's `registerMcpServer`, exposure
  `deferred`, so its tools are loaded by `tool_search` when she needs one.
  Pi's own `mcp.json` files are never read, its `mcp.log` is `/dev/null`,
  and the transport sends the token as a bearer header itself (no
  `${VAR}` or `!command` expansion), refuses redirects, drops servers'
  log notifications, and cuts each result to 16 KB in memory, a binary
  resource replaced by a line naming it, so nothing reaches disk.
- **Approval:** a tool its server marks read-only (`readOnlyHint`) runs
  freely, and only those (with `tool_search`) are on in Plan mode. Every
  other call asks, whatever the mode, with **Allow in this thread** for
  that tool. A read-only or narrowed subagent gets no MCP servers; an
  unnarrowed writer gets its parent's, and its calls ask in both threads.

## Claude Code

Anthropic doesn't let other apps sign in to a Claude plan, but it does let
a person use the unmodified `claude` program with their own plan
(docs/briefs/claude-code.md). So she can hand Claude Code a coding or
repository job from her `bash` tool, and it runs on the user's Claude plan.
It isn't a model: her chat, persona and memory never go through it, and
it adds no tool.

- **Installed** with the sandbox's tools: nixpkgs' `claude-code` in the
  NixOS sandbox tools (unfree, allowed by itself in its own import in
  `nix/sandbox-tools.nix`, so the machine's configuration needs nothing),
  and on Debian and Ubuntu `install.sh` puts the same version in
  `/usr/local`. An update never installs it. `claudeCodeInstalled()` says
  whether it is there.
- **Signing in:** the user runs `claude setup-token` on their own
  computer, Anthropic's own sign-in, and pastes the token it prints into
  Settings → **Claude Code and Codex**. It is kept in their `user.db` (`settings`,
  `claude_code.token`), never shown back, with **Remove**.
- **Per thread:** a **Claude Code** switch in the thread drawer, off by
  default (`thread_workspaces.claude_code`, user step 4). Children and
  subagents inherit it, never wider; a read-only or narrowed one gets it
  off. A private thread can't turn it on, and a local-only one is refused
  it, since Claude Code sends what it reads to Anthropic.
- **A run** gets Claude Code only when `Workspace.claudeCodeFor` allows
  it: a general thread that isn't local-only, itself or any ancestor
  (lyricad's `restricted` option; without it, never), with the switch on,
  a saved token, and a network that reaches `api.anthropic.com`.
- **The token never enters the sandbox.** Such a run gets the run's relay
  (Credentials, under Git accounts and repositories). Its environment has
  `ANTHROPIC_BASE_URL` pointing at the relay and, as
  `CLAUDE_CODE_OAUTH_TOKEN`, the run's capability. The relay refuses any
  other bearer and any path outside `/v1/`, drops the run's own keys,
  swaps in the user's token, and passes the request to
  `https://api.anthropic.com`.
- **The wrapper** (`core/src/workspace/claude.sh`) is at
  `/run/lyrica/bin/claude`, first on the run's PATH. It runs the real program with `CLAUDE_CONFIG_DIR` at
  `/run/lyrica/claude`, the thread's own folder for it in the encrypted
  home workspace (`Workspace.claudeDir`, `claude/<thread>` there; a
  subagent shares its parent's), outside the folder its children and
  read-only subagents see, so its transcripts stay encrypted and private
  to the thread, `claude -c` continues the thread's last job, and the
  sweep removes it with the thread. It drops any other Anthropic key, turns off
  Claude Code's update checks and telemetry, and skips its permission
  prompts (`--permission-mode bypassPermissions`, as the owner chose): the
  sandbox is the fence, and her `bash` call already went through the
  thread's mode. Plan mode has no `bash`, so no Claude Code.
- **The prompt** has one line for such a thread (`CLAUDE_CODE_LINE`):
  `claude -p` is for coding and repository jobs worth the user's plan, never
  conversation.

## Her own code

She changes her own code the way Claude's feature threads do: the
`xlc2022/lyrica` repository in her "Lyrica" project, from her own GitHub
account (docs/briefs/lyrica-project.md), on `lyrica/*` branches, through
pull requests that the project's review approves and merges. Nothing she
does reaches `main` or the server without that review and an
administrator's Update. A private thread can't have the repository, since
her account is general.

- **The repository's settings**, the owner's to set, once:
  1. Her GitHub account as a collaborator with **Write**.
  2. Under her account, a fine-grained token for this repository only,
     with **Contents** and **Pull requests** read and write and
     **Actions** read, added in Settings → Git accounts as a GitHub
     account. Actions read lets her see why a check failed
     (`gh pr checks`, `gh run view --log-failed`); re-running a job stays
     with the reviewers. GitHub serves a job's log from storage hosts
     that change, so reading logs needs the thread's internet on, not
     only allowed hosts.
  3. A branch protection rule (or ruleset) on `main`: pull requests only,
     the CI jobs from `.github/workflows/ci.yml` required, one approval;
     "Do not allow bypassing" off, so the owner's account, which Claude's threads
     work through, still merges as administrator.
  4. A ruleset that lets her account create and update only `lyrica/*`
     branches and `update/*` tags.
  5. She pushes to the repository, never a fork, so her pull requests run
     CI on the `lyrica-ci` runners like Claude's, with no
     first-time-contributor approval.
- **`.github/CODEOWNERS`** names the owner for the boundary code: keys and users
  (each user's key and its recovery wrap), database migrations, the model
  router, the workspace (sandbox and grants), `openThreadView`,
  authentication, web access, the pool's storage, the model host,
  deployment, the updater and CI. GitHub then asks for
  the owner's review on a pull request that touches them; it isn't required for
  merging, since Claude's approvals come from the same account. PR review
  asks the owner before approving such a pull request of hers.
- **Update notes.** Before the owner presses Update she writes one: an annotated
  tag `update/<date>` on the `main` commit to install, its message listing
  the pull requests merged since the running version (Claude's too), what
  each changes, any schema change and what a rollback would lose, and what
  to check afterwards. It describes code, never conversations. After a
  failed probation, a GitHub issue linked to the tag holds the post-mortem.
- **Her checks.** `npm run typecheck` and `npm test` run in her sandbox
  with the thread's internet on. The tests that need FUSE or a tun device
  (encrypted homes, rewind, uploads, network switches, the SSH helper)
  skip there, since her sandbox has neither; CI runs them with
  `LYRICA_SANDBOX_TESTS=require`, so they can't skip.
- **CI wakes.** A pull request she opens through the run's relay is
  watched (DESIGN.md "CI wakes"): when every check on its head commit
  finishes, or someone else reviews or comments, the thread gets one turn,
  marked as a wake-up, with a note `lyricad` writes — the pull request
  number, the commit's short hash, each check's name and result, and who
  reviewed, never log or comment text. GitHub is polled; a Forgejo or
  Gitea account whose host resolves into her own network also gets a
  signed tailnet webhook (Settings → Git accounts, **Webhook**) that nudges
  a poll at once, with polling as the fallback. A merged or closed pull
  request ends the watch without a turn.
- **Screenshots.** After `npm run build`, `npx tsx web/e2e/shot.ts
  [page]...` starts a throwaway `lyricad` with ada signed in (the e2e one,
  web/e2e/serve.ts), saves each page at 390×844 and 1280×800, light and
  dark, as PNGs under `shots/`, and prints their paths for `read`. It
  needs no internet. The browser is the sandbox's headless Chromium:
  `chromium` in the NixOS sandbox tools, or the
  `/usr/local/bin/chromium-headless-shell` that install.sh puts in `/usr`
  on Debian and Ubuntu.
- **Her self-primer** (`extension/src/primer.ts`) comes up when her code
  does, like a persona topic: where to read first, the branch and review
  flow, boundary code, update notes and rollbacks.

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
- **Machines:** the parent's or a subset. Delegation gives none to a read-only,
  offline or folder-narrowed subagent or child thread, or to a writer in a
  worktree, since bash on a machine follows none of those narrowings.
- **Repositories:** a subagent works in its parent's clones. One that gets
  no machines gets no repositories or credentials either, and its sandbox
  mounts those clones read-only, so it can't change their working trees or
  commits.

A subagent can never widen what its parent was given. `inheritSettings`
copies the parent's settings, or the narrower ones it is given, and the
subagent's settings are checked against its parent's whenever they change and
before every use. What its tools follow is `effective(thread)`: its own
settings with the strictest mode and switches of every ancestor, read on each
call, so a parent switched to Plan, with a switch turned off, or with a
folder or machine taken away narrows its subagents and child threads at once.
A folder the parent makes read-only is read-only below it too. Their sandbox
mounts only what applies, their settings, facts line and Files panel show it, and `read`
on a folder that's gone is refused as outside their folders. The narrowing is
written into their own settings as well, so a parent that gets a folder back
gives it to no one below it. Changing a thread's workspace tells its
descendants' open views to fetch their settings again. Parallel
writers get their own git worktrees (see [delegation.md](delegation.md)).

## Project command rules

Principles 6, 2 and 8: a project keeps at most 100 Allow, Ask or Forbid
prefixes in encrypted `user.db` (`project_settings.command_rules`, expand-only
user step 6). A prefix has 1 to 8 words, each at most 64 characters, with no
control characters; saving it again replaces its decision. `Projects.set`
upserts other settings without replacing rules.

A forbid rule refuses any command she writes that contains a matching command, however
chained or wrapped; it doesn't see inside scripts or programs she runs.

`rules.ts` uses `simpleCommands` from `machines.ts`: chains, pipes,
substitutions, subshells, shell `-c` arguments and find's `-exec`, `-execdir`
and `-ok` commands are checked; quotes and backslashes inside words are
removed. Allow matches leading words after assignments. Ask and Forbid match
the program anywhere, then the other prefix words in order with intervening
words allowed. The longest prefix wins; ties prefer Forbid, then Ask, then
Allow. Across parts Forbid wins, then Ask, and Allow needs every part allowed.
Opaque programs (expansions, eval, source, dot, or a shell without `-c`) cannot
be allowed; with any forbid rule they ask in every mode.

The hook reads rules on every `bash` call through `ThreadTools.commandRules`.
Forbid blocks without a card, Ask always asks, and Allow skips Ask and Accept
edits prompts in the sandbox only. Machine limits, suspect commands, moving
to a machine and irreversible calls still ask. The user's `user_bash` is
unaffected. `WorkspaceThread.project` follows delegation at every depth.

Project settings → General has Commands after This chat, with prefix,
Allow | Ask | Forbid, Remove and Add rule, applied by the page's one Save.
For a single plain sandbox command in a project, the card offers Always allow
with lyricad's computed prefix. Shells, interpreters and wrappers get no such
choice. The prefix is the program and its plain subcommand, plus the next
plain word for package runners' run, exec or x (for example `npm run test`).
The answer stores that server-held prefix in the project, including when a
subagent asks; the browser never supplies the prefix.

## Approval

The sandbox already limits what she can reach. Inside her grants she works
freely by default, following the principle that the harness should trust her
judgment and make review easy. Each thread has a **mode**:
- **Ask** (`ask`): asks before `bash`, `write` and `edit`, since a command
  can change files too.
- **Accept edits** (`acceptEdits`): asks before `bash`.
- **Plan** (`plan`): only `read`, `recall`, `read_memory`, `web_search`, read-only MCP tools and `tool_search`,
  `web_fetch`, `proxmox` for reading, `delegate` with read-only roles, a subagent's `ask_parent`,
  `threads` (child threads and project actions, wake-ups, routines,
  checklists, and compacting her context), `react` and
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
tools back on, and she carries on with the plan in the same turn. She is
told which machines' limits still hold calls to a stricter mode. A branch
of a thread in Plan mode stays in Plan mode, and she is told so. A subagent
has no `propose_plan` and can't change its mode. Without `lyricad`, Pi's own
UI asks; with no UI she keeps planning.

Anything irreversible that leaves the server, such as sending a message,
deleting remote data or spending money, always asks, whatever the mode: a tool
annotated as reaching outside (`openWorldHint`) and not read-only, and every
MCP tool its server doesn't mark read-only.

## Tools

`read`, `write`, `edit` and `bash`, and `propose_plan` in a thread that isn't a subagent, built from Pi's own tool definitions
with the call's target (the sandbox, or the machine its `machine` argument
names) looked up on every call, so changing a thread's settings applies at
once. Commands typed with `!` in the terminal run in the sandbox. A short
`workspace` prompt section tells her where she works, what she was given,
whether she has internet, and her machines. It also lists the programs the
sandbox has on this host (`sandboxTools` in `sandbox.ts`) and, only when it
finds Chromium, gives its command, how Playwright or Puppeteer use that
browser, and that a static page is checked once it parses and one screenshot
looks right. Subagents and child threads get the same
section. Every run's environment has `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`
and `REQUESTS_CA_BUNDLE` set to the real path of the host's
`/etc/ssl/certs/ca-certificates.crt` (on NixOS its store path, which the
sandbox mounts; never the `/etc/static` link, which it doesn't), and `CHROME_PATH` and `PUPPETEER_EXECUTABLE_PATH` set to the
sandbox's Chromium, with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` and
`PUPPETEER_SKIP_DOWNLOAD`, so npm, pip and browser libraries use what is
there instead of failing on certificates or downloading a browser
(`toolEnv` in `sandbox.ts`). With internet off, it tells her not to
mirror or proxy CDNs or registries, but to say what she couldn't check or ask
for Internet or an allowed host. `proxmox` is the tool for
Proxmox machines ([above](#proxmox)). The memory tool
is `read_memory`, so it doesn't clash with `read`.

## Host requirements

The machine running `lyricad` needs:
- bubblewrap;
- gocryptfs;
- FUSE (`/dev/fuse` and `fusermount3`);
- passt (for `pasta`), nftables, `unshare` and bash, and `/dev/net/tun`;
- unprivileged user namespaces.

On NixOS the module brings them, refuses to build while
`security.allowUserNamespaces` is off, and `nix/check-host.sh` checks the
rest on the running host ([daemon.md](daemon.md#on-nixos)). In a Proxmox
LXC container, turn on the **nesting** and **FUSE** features. A VM needs
nothing special.

**Checklist for a Debian or Ubuntu LXC container:**
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
