---
name: add-machine
description: Walk the person through giving you another computer over SSH, or a Proxmox node: the Add machine page in Settings, what its setup block does, and giving a thread the machine.
---

# Adding a machine

A machine is one of the person's other computers that you work on over SSH, or a Proxmox node you manage through its API. You can't add one yourself: the person adds it in **Settings**, **Machines**, **Add machine**, and nothing is saved until they confirm a fingerprint there. Your part is to say which kind fits, take them through the page one step at a time, say what the setup block does before they run it as root, and help when a step fails.

You never see a machine's key or token, and you never ask for one, or for a password, in chat. The page shows the setup block itself, with **Copy**: point them to it rather than writing your own version. If a token or key is pasted into the conversation, say that it is now part of this conversation and should be made again.

First ask what they want you to do there. That decides the kind, at the top of the page:

- **SSH**: a computer where you read and write files and run commands.
- **Proxmox**: a Proxmox VE node or cluster. You list its VMs and containers, read their status and snapshots, and start, shut down, stop or reboot the ones the token allows. Nothing else: no shell, no files, no creating, destroying, console or snapshot changes. To work inside a VM, they add that VM as an SSH machine of its own.

## SSH

1. **An account for you on the machine**, not root (root is refused). If there is none: `useradd -m -s /bin/bash lyrica`, as root there. The machine needs OpenSSH 9.6 or later.
2. **Name and address.** **Name** is what you'll call it. **Address** is `account@host`, with `:port` if it isn't 22. **Account** stays on the first choice, your own account. **Folder** is optional and keeps your file tools under one path. **Pool** is General or Private: a thread uses only machines of its own pool, and a private machine should be on their own network. Then **Next**.
3. **Key.** The page shows a block to run as root on the machine. It puts your public key in `/etc/ssh/authorized_keys/<account>`, a file only root can change, points sshd at it for that account only, reloads sshd, and prints the machine's host key fingerprint. The sudo lines in it are optional: without them you have no root there, and a step that needs root comes to the person on a card.
4. **Test** says **Logged in**.
5. **Fingerprint.** They compare the fingerprint on the page with the one the block printed on the machine, then **Confirm**.

**Account: Mine** logs you in as the person's own account instead. The page lists what that gives you and asks them to type the machine's name. Mention it only if they ask: a dedicated account is the safer default.

## Proxmox

1. **Name and address.** **Address** is `https://<node>:8006`. **Pool** as above. Then **Next**. The Proxmox that runs your own VM is refused on purpose, since stopping it would stop you.
2. **Token.** The page shows a block to run as root on the node. It makes a user `lyrica@pve`, a role `LyricaPower` that can only see and power VMs, and a privilege-separated token; it lets the token read everywhere and power only the VMs on its `/vms/<id>` lines, and prints the certificate's fingerprint. Before running it they change `/vms/101` to the VMs you may power, one line each, or a `/pool/<name>`.
3. The token command prints a secret once. They paste `lyrica@pve!agent=<secret>` into the page's **Token** field, never here. **Test** says **Reached**. The token is sent nowhere before Confirm.
4. **Fingerprint.** They compare it with the block's last line, then **Confirm**.

To use their own Proxmox user (say `root@pam`) instead of `lyrica@pve`: **Account: Mine**, with the user in **User**. The block then makes only a separated token on that user, `<user>!lyrica`, with the same rights. Confirm refuses a token on another user, and one that can do more than see and power VMs.

## Afterwards

- **Give the thread the machine.** Adding it doesn't put it in any thread. In a thread's settings drawer, under **Machines**, **+** adds it; then your tools take it by name. When a tool says a machine isn't one of this thread's, this is usually the missing step.
- **Mode limit.** A new machine is limited to Ask: commands and edits there ask first, whatever the thread's mode. The person can raise it in the machine's row.
- **Its row** shows Online, Unreachable or Key changed. After a reinstall or a renewed certificate every call fails until they open the row's menu, **Replace key**, and confirm the new fingerprint.

## When a step fails

- "the server doesn't offer strict key exchange; update its OpenSSH": the machine's OpenSSH is older than 9.6.
- Test says the login didn't work: the block wasn't run as root on that machine, the account in the address doesn't exist there, or the address is another machine's. The block can be run again safely.
- "the token didn't work: Proxmox answered 401": the token was pasted without its `user@realm!name=` part, or cut short.
- A private machine "resolves outside your network": the page asks once more before adding it; say what that means rather than telling them to press on.
