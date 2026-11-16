---
name: nixos
description: Install NixOS on one of your SSH machines from the installer ISO, or change, update, roll back and clean up a NixOS machine through its configuration.
---

# NixOS: installing it and keeping it running

NixOS is built from a configuration: a machine changes when its configuration changes and is rebuilt, never by hand. So every job here is the same loop: find the configuration, change it, build it, show the person what will change, then switch to it as a root step.

**Sources.** The NixOS manual (https://nixos.org/manual/nixos/stable/) is the authority, and newer than these steps: before an install, an upgrade or a cleanup, read its section ("Installing NixOS", "Changing the Configuration", "Upgrading NixOS", "Cleaning the Nix Store") and say which section each command came from. Commands and flags: `nixos-rebuild --help` on the machine, since its version is the one that runs. For an option or a package, look it up before you write it: with the NixOS MCP server's `nix` and `nix_versions` tools when this thread has that server (the person adds it in Settings, MCP servers), otherwise search.nixos.org with your web tools. Never write an option name from memory. The server's flake-inputs and store actions describe the machine it runs on, not this one: on this machine, read `flake.lock` or run `nix flake metadata`.

**Root steps.** Work on the machine with the machine argument; never wrap a command in `ssh`. Root steps work as the `model-host` skill says: with `sudo` yourself after the person's yes when `sudo -n true` succeeds, otherwise on a `run_as_root` card. A long one (an install, a build of a big change) runs with `background: true`; you're told when it ends. You never write sudoers, here or in a configuration, unless the person asks for that rule by name.

**Always a yes that names the target.** Each of these needs a yes that names its target, even with sudo: wiping or partitioning a disk (by its model and size, not only `/dev/sda`), switching to a configuration that changes networking, the firewall, SSH, users or the boot loader, moving to a new release, and deleting old generations (that ends rolling back to them).

## Installing NixOS

### Where it runs from

The machine boots the NixOS installer ISO (from https://nixos.org/download/), with its network up (`nmtui` at the console for Wi-Fi). The installer's `nixos` user has sudo without a password and its SSH server runs, so the person adds it in **Add machine** with **Account: Mine** and user `nixos`, pastes that block at the installer's console, and confirms the fingerprint (the `add-machine` skill). You never log in as root.

### 1. Check the machine

In one command, ending in `true`: `cat /etc/os-release`, `test -d /sys/firmware/efi && echo UEFI || echo BIOS`, `lsblk -o NAME,SIZE,TYPE,MODEL,MOUNTPOINTS`, `ls -l /dev/disk/by-id/`, `ip -br addr`, `free -h`, `sudo -n true && echo sudo`. The USB stick or disk the installer itself runs from is never a target.

### 2. Ask the person, once, and wait

In one message: which disk (its `/dev/disk/by-id/` path, model and size), and that everything on it goes; the partitions (the manual's UEFI or BIOS example, swap size, LUKS encryption or not); a flake or `configuration.nix` alone; the host name, time zone, the person's user name, desktop or server; and whether you get an account on the new system with the key you use now. Sudo rights for that account are the person's to ask for by name; don't offer them. Wait for the answer.

### 3. Disk

The manual's "Partitioning and formatting" commands for that disk, with labels `nixos`, `swap` and `boot`, then its mounts under `/mnt`: one root step, after the yes that names the disk. Show `lsblk -f` after it.

### 4. Configuration

`sudo nixos-generate-config --root /mnt` (with `--flake` for a flake). Then edit `/mnt/etc/nixos/configuration.nix` (as root, a script that writes it): the boot loader (systemd-boot on UEFI; `boot.loader.grub.device` set to the disk on BIOS), `networking.hostName`, networking (`networking.networkmanager.enable` on a laptop), `time.timeZone`, the person's user in `users.users`, `services.openssh.enable = true`, and your account if they said yes: `users.users.<account> = { isNormalUser = true; openssh.authorizedKeys.keys = [ "<the line from ~nixos/.ssh/authorized_keys>" ]; };`. Leave `hardware-configuration.nix` and `system.stateVersion` as generated. Show the person the whole file before going on.

### 5. Install

`nixos-install --no-root-passwd` (with `--flake /mnt/etc/nixos#<host>` for a flake) as a root step in the background: it downloads and builds for a while. On a failure, read its output, fix the configuration and run it again; the manual says that is safe.

### 6. Hand over and reboot

The person sets passwords at the installer's console, never through you: `sudo nixos-enter --root /mnt -c 'passwd <user>'`, and root's too if they want one. Then they take out the ISO and reboot. The installed system has a new host key and new accounts, so they add it as a new machine with your account's name as **User**: your key is already in its configuration, so they skip the block, press **Test** and confirm the fingerprint (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` at its console), and remove the installer's machine.

## Keeping a NixOS machine running

**Giving you an installed NixOS machine.** sshd and sudo on NixOS read only the configuration's own rules, so on Add machine the person sets **System** to NixOS: the page then gives a module that declares your account, its key and an SSH rule, a rebuild, and any sudo as a module of its own holding `security.sudo.extraRules`, each added to `imports`. They save the module beside their configuration, add it to `imports`, rebuild, then press **Test** and confirm the fingerprint. Find the configuration first (below) if they ask you to do it.

**Find the configuration first.** Ask the person where it lives, and check what you find: `ls -l /etc/nixos`, whether there is a `flake.nix`, `nixos-version`, `nixos-rebuild list-generations | tail -3`. Never assume `/etc/nixos`, and never use a checkout of Lyrica's own repository as the configuration. With a flake, the machine's name is its entry in `nixosConfigurations` (`nix flake show <folder>`), and every command takes `--flake <folder>#<name>`. In a flake inside a git repository, Nix sees only files added to git: `git add` a new file before you build.

**A change.**
1. Look the option up, then edit. When the configuration is a git repository with a remote, work in your own clone of it and offer the change the way its owner takes changes. When it is root's, copy the folder to your home, edit the copy, and the root step in 3 copies your changed files back.
2. **Build as your account** and show the plan: `nixos-rebuild build` (`--flake <copy>#<name>`, or `-I nixos-config=<copy>/configuration.nix`), then `nix --extra-experimental-features nix-command store diff-closures /run/current-system ./result` for the packages that change and `diff -ru` against the live configuration for the edit. Nothing is switched yet. A build that fails changes nothing: read the error, fix, build again.
3. **Switch as a root step**, from the person's configuration folder: `nixos-rebuild switch` with the same flags. For a change to services, run `nixos-rebuild dry-activate` first and show which units would restart. For networking, the firewall, SSH or users, use `nixos-rebuild test` first: it isn't the boot default, so a reboot undoes it if you lose the machine; once you reach it again, `switch`.
4. **Check.** `systemctl --failed` and the services the change touched. If something broke, roll back.

**Updates.** With a flake: `nix flake update` (or `nix flake update <input>` for one) in the configuration folder, as whoever owns it, then build, show the plan and switch as above. With channels: `sudo nix-channel --list` shows the channel, and `nixos-rebuild switch --upgrade` updates and switches in one step, so build first with `sudo nix-channel --update nixos` and `nixos-rebuild build`. A machine that serves Lyrica or a model host updates their code through their own guides afterwards, not by the rebuild.

**A new release** (25.11 to 26.05, say). Read that release's notes in the manual (Appendix B) first and tell the person what they change for this configuration. Then change the flake's `nixpkgs` URL, or the channel with `nix-channel --add https://channels.nixos.org/nixos-<release> nixos`, and build. The manual warns that a newer Nix may upgrade its database so the old channel can't come back. Never change `system.stateVersion`.

**Rolling back.** `nixos-rebuild list-generations` shows them. `nixos-rebuild switch --rollback` as a root step goes back one. If the machine no longer answers, the person picks an older generation in its boot menu.

**Cleaning up.** `nix-collect-garbage` removes only what nothing uses, and keeps every generation: run it as a root step after a yes. `nix-collect-garbage --delete-older-than 30d` (or `-d`) also deletes old generations, so it needs a yes that says you can't roll back to them; afterwards `nixos-rebuild boot` clears their boot entries, which is what frees a full `/boot`. `nix-store --optimise` saves more but reads the whole store: background.

**Software.** A program the machine should keep goes in `environment.systemPackages` or a module's `enable`, not `nix-env -i` or `nix profile install`, which the configuration doesn't know about. For one command, `nix-shell -p <package>` or `nix run nixpkgs#<package>` installs nothing.
