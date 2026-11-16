---
name: gentoo
description: Install Gentoo onto a disk of one of this thread's SSH machines by the Handbook, or keep a Gentoo machine up to date: sync, news, world updates, USE flags, config files, kernels.
---

# Gentoo: installing it and keeping it running

Gentoo builds from source with Portage (`emerge`), and its own documentation is the authority. Read the part you are about to do before you do it, at its current version, and say which section a value came from: the Handbook (`https://wiki.gentoo.org/wiki/Handbook:AMD64`, or the machine's own architecture from `uname -m`; each part's wikitext is `https://wiki.gentoo.org/index.php?title=Handbook:Parts/Installation/<Part>&action=raw`, with Disks, Stage, Base, Kernel, System, Tools, Finalizing), the wiki for a single topic, a package's page at `https://packages.gentoo.org/packages/<category>/<name>` (add `.json` for its versions and keywords), and `eselect news` on the machine. Read with your web tools, or with `curl` on the machine. Where this skill and the Handbook disagree, the Handbook wins: tell the person, since this file is then out of date.

Work on the machine with the machine argument; never wrap a command in `ssh`. Root steps go as the `model-host` skill says: when `sudo -n true` succeeds you run them with `sudo` after the person's yes, otherwise they go on a `run_as_root` card. Gather a phase's commands into one script so the person sees one card for the phase, not dozens. A key or password never comes through chat. Building takes hours: start every `emerge` that builds or installs packages with `background: true` and read it with `jobs output`, and never cut its output short with `tail` or `grep`. Portage asks nothing over a non-interactive command, so never pass `--ask`: run the same command with `--pretend` (`-p`) first, show the person what it will do, and run it for real only after their yes.

**Always a yes that names the target, every time:** wiping or repartitioning a disk (name it by its `/dev/disk/by-id/` path, its model and size); formatting; installing a bootloader or changing EFI boot entries; `eselect profile set`; `emerge --depclean`; unmerging a package; accepting `~arch` (testing) keywords for more than one package; a reboot. Never use `--nodeps`, never unmerge a package in `@system` or the toolchain (gcc, glibc, binutils, portage, python that portage uses), never touch `/var/db/pkg` by hand, and never edit `/etc/portage/make.profile`. You never write sudoers, here or inside the new system.

## Installing Gentoo

### Where it runs from

The install runs from a live Linux that the target machine boots, or from the machine's own Linux when Gentoo goes on a second disk. Gentoo's own minimal ISO has no `sudo` and runs OpenRC, so the Add machine setup can't run on it. A live image with `sudo`, systemd and OpenSSH 9.6 or later does: Debian 13's live image, for example, after `sudo apt install openssh-server` at its console. The person adds that system as a machine (the `add-machine` skill) and gives this thread the machine. A live system forgets everything at a reboot, including its host key and your account, so the install must finish before it reboots. Tell the person that a new machine starts at Ask, where every command asks first: that is their choice to keep or change.

### 1. Check the machine

One command, ending in `true`, so a missing program is an answer and not a failure: `uname -m`, `cat /etc/os-release`, `nproc`, `free -g`, `[ -d /sys/firmware/efi ] && echo UEFI || echo BIOS`, `mokutil --sb-state`, `lsblk -o NAME,SIZE,MODEL,SERIAL,TYPE,FSTYPE,MOUNTPOINTS`, `ls -l /dev/disk/by-id/`, `findmnt /`, `ip -brief address`, `command -v gpg wget curl sfdisk mkfs.vfat chroot`. The disk the live system or the running Linux uses is never a target. With Secure Boot on, stop and say so: the Handbook's shim and signing steps are a project of their own, and the simplest path is that the person turns Secure Boot off in the firmware.

### 2. Ask the person, once, and wait

In one message, with your suggestion for each: the target disk (by-id path, model, size, what is on it now, and that the whole disk will be wiped); OpenRC (the Handbook's default) or systemd; the profile (plain, or desktop with a desktop environment); binary packages from Gentoo's binhost (strongly suggested: hours less compiling); the kernel (`sys-kernel/gentoo-kernel-bin`, the prebuilt distribution kernel, unless they want to configure their own); the bootloader (GRUB; systemd-boot is an option on systemd with UEFI); the root filesystem (ext4, xfs or btrfs); swap size; hostname, timezone, locale and keymap; the name of their own user. Don't partition anything before their answer names the disk.

### 3. Disk, stage file and chroot

As the Handbook's Disks and Stage parts say, as one root script for the person's yes:
- Partition with `sfdisk` and a script on its input, never `fdisk`'s prompts: for UEFI a GPT label, a 1 GiB EFI system partition, swap if asked, and the rest for root, with the partition types the Handbook names. Format them (`mkfs.vfat -F 32` for the ESP), `mkswap` and `swapon`, mount root on `/mnt/gentoo`.
- Set the clock (`chronyd -q`, or check `date`), then download the stage file the answers chose from `https://distfiles.gentoo.org/releases/<arch>/autobuilds/` (its `latest-stage3-<arch>-<init>.txt` names the current one), with its `.asc` and `.DIGESTS`. Off Gentoo's media, fetch the release keys with `gpg --auto-key-locate=clear,nodefault,wkd --locate-key releng@gentoo.org`, and check the signature with `gpg --verify` before you unpack anything. A failed check stops the install.
- `tar xpvf <stage file> --xattrs-include='*.*' --numeric-owner -C /mnt/gentoo`.
- `/mnt/gentoo/etc/portage/make.conf`: `COMMON_FLAGS="-march=native -O2 -pipe"`, `MAKEOPTS` from `nproc` and memory as the Handbook's Stage part says.
- Copy `/etc/resolv.conf` in (`cp --dereference`), and mount `/proc`, `/sys` (rbind and make-rslave), `/dev` (the same) and `/run` (bind) as the Handbook's Base part lists. On a non-Gentoo live system there is no `arch-chroot`, so use these mounts.

Every later step runs inside: `sudo chroot /mnt/gentoo /bin/bash -c 'source /etc/profile && …'`. Mount the ESP on `/efi` inside it, as the Handbook does now.

### 4. Portage and the base system

In the chroot, following the Base part: `emerge-webrsync`; `eselect news read` and tell the person anything that matters to this install; `eselect profile list`, then set the chosen profile by its name, not its number; with binary packages, `/etc/portage/binrepos.conf/gentoo.conf` with the `sync-uri` for this architecture and profile (`https://distfiles.gentoo.org/releases/amd64/binpackages/23.0/x86-64/` on a plain amd64 profile), then `getuto`, and `FEATURES="${FEATURES} getbinpkg binpkg-request-signature"` in make.conf; `emerge --oneshot app-portage/cpuid2cpuflags` and `echo "$(cpuid2cpuflags)" > /etc/portage/package.use/00cpu-flags` (the Handbook's line as it stands); `VIDEO_CARDS` for the machine's GPU; `ACCEPT_LICENSE` as the Handbook shows (per package in `/etc/portage/package.license/` where it can be). Then `emerge --pretend --verbose --update --deep --newuse @world`, the person's yes, and the same without `--pretend` in the background. Timezone, `locale.gen` and `locale-gen`, `eselect locale set` by name, then `env-update`.

### 5. Kernel, system and tools

Following the Kernel, System and Tools parts: `sys-kernel/linux-firmware` (and `sys-firmware/intel-microcode` on an Intel CPU); `sys-kernel/installkernel` with the USE flags for the chosen bootloader and `dracut`, in `/etc/portage/package.use/installkernel`; then the kernel. `/etc/fstab` from `blkid`'s UUIDs. Hostname, network (`net-misc/dhcpcd`, or NetworkManager for a desktop) enabled at boot, keymap and clock. A system logger and cron on OpenRC, time sync, the filesystem tools for the chosen filesystems, `app-admin/sudo`, and `sshd` enabled at boot (`rc-update add sshd default` or `systemctl enable sshd`), so the person can add the finished system as a machine. Make their user with `useradd -m -G users,wheel <name>`.

### 6. Bootloader

Following the Handbook's bootloader section for the choice: for GRUB on UEFI, check that `GRUB_PLATFORMS` includes `efi-64` (the default; the Handbook says when to add it to make.conf), `emerge sys-boot/grub`, `grub-install --efi-directory=/efi`, `grub-mkconfig -o /boot/grub/grub.cfg`. Read what each printed: a missing entry here means the machine won't boot.

### 7. Hand over and reboot

The person sets the passwords and their own sudo at the machine's console, never through you: `sudo chroot /mnt/gentoo passwd` for root, `sudo chroot /mnt/gentoo passwd <name>` for their user, and `sudo chroot /mnt/gentoo visudo` to let `%wheel` use sudo. Give them those lines and wait until they say it's done. Then, after their yes, unmount (`umount -l /mnt/gentoo/dev{/shm,/pts,}` and `umount -R /mnt/gentoo`) and reboot, and tell them to remove the live medium. The live machine is gone after that: they remove it in Settings and add the installed system as a new machine (the `add-machine` skill). Once you reach it, run the Finalizing part's checks and remove the stage file from `/`.

## Keeping a Gentoo machine running

Before anything: `cat /etc/os-release` says `ID=gentoo`; `[ -d /run/systemd/system ]` tells systemd from OpenRC, which decides `systemctl` or `rc-service`/`rc-update`; `eselect profile show`; and whether make.conf has `getbinpkg`.

**An update** (suggest one every week or two; a machine left months behind needs the wiki's "Upgrading Gentoo" pages first):
1. `emaint sync -a` (or `emerge --sync`), then `eselect news list` and `eselect news read new`. Report every unread item in a sentence each, before anything else: news items often say to do something before the update.
2. `emerge --pretend --verbose --update --deep --newuse --with-bdeps=y @world`. Report what it plans: how many packages, the big ones (toolchain, kernel, a desktop), USE changes, and any blocker, slot conflict, masked or keyword-needing package. Fix those by reading what Portage printed and the package's page, one at a time, with a narrow change in `/etc/portage/package.*` (a file per topic). Never add a flag or keyword to make.conf to make one package build.
3. After the yes, the same command without `--pretend`, with `--keep-going`, in the background.
4. Config files the update left: `find /etc -name '._cfg????_*'`. For each, show the diff against the file it would replace and ask whether to take it, keep the old one, or merge by hand. Never run `etc-update` or `dispatch-conf` (they prompt), and never take a file the person changed without asking.
5. `emerge @preserved-rebuild` when Portage asks for it.
6. `emerge --pretend --depclean`: list what it would remove, and remove it only after the yes. Then `eclean-dist` (from `app-portage/gentoolkit`) frees the downloaded sources.
7. A new kernel, glibc or init system means a reboot: say so and wait for the yes.

**A build that fails:** read the log the error names (`/var/tmp/portage/<category>/<package>/temp/build.log`), and `emerge --info`, before changing anything. Search the error on `bugs.gentoo.org` and the forums. One cause, one change; two changes that didn't fix it mean you go back to reading.

**USE flags and keywords:** see a package's flags with `equery uses <package>` (gentoolkit) or `emerge -pv`. Set them per package in `/etc/portage/package.use/<topic>`. Global USE in make.conf, a new profile, or `~arch` keywords system-wide change every package: ask, and read the profile's news first.

**Services:** OpenRC uses `rc-service <name> start|stop|restart` and `rc-update add|del <name> default`; systemd uses `systemctl`. Logs come from `journalctl` on systemd, and from the system logger's files under `/var/log` on OpenRC.
