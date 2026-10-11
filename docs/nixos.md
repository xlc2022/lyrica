# NixOS

`flake.nix` at the repository's root packages Lyrica for NixOS and gives a
module, `services.lyrica`, that declares what `daemon/deploy/install.sh` does
on Debian (docs/daemon.md, "Deployment"). Only x86_64-linux is built.

## Using it

```nix
# flake.nix of the host's configuration
inputs.lyrica.url = "github:xlc2022/lyrica";

# in the host's modules
imports = [ inputs.lyrica.nixosModules.default ];
services.lyrica.enable = true;
```

Then `nixos-rebuild switch`, and once, as with install.sh:

```sh
sudo -u lyrica env LYRICA_HOME=/var/lib/lyrica lyrica admin init
sudo systemctl start lyricad
```

`lyricad` doesn't start until `self.db` exists (`ConditionPathExists`).

## Outputs

- `packages.x86_64-linux.lyrica` (`nix/package.nix`): lyricad, the `lyrica`
  CLI and the built web UI, from `package-lock.json` with `buildNpmPackage`
  on nixpkgs' `nodejs_22`. The build refuses Node older than 22.6.
  `better-sqlite3-multiple-ciphers` is compiled from source. Its
  `npmDepsHash` changes whenever `package-lock.json` does: `nix run
  nixpkgs#prefetch-npm-deps package-lock.json` prints the new one.
- `packages.x86_64-linux.sandbox-tools`: the module's default sandbox tools
  (`nix/sandbox-tools.nix`), for CI.
- `nixosModules.default` (`nix/module.nix`).
- `checks`: the package, and a NixOS system with the module on, both built.

nixpkgs comes from the `nixos-26.05` channel, locked in `flake.lock`.

## The module

- Users `lyrica` and `lyrica-caddy`, groups as on Debian, and
  `/var/lib/lyrica` (`0700`).
- `lyricad.service` and `lyrica-caddy.service`, written in Nix and kept in
  step with `daemon/deploy/*.service`: the same users, state directories,
  `LoadCredentialEncrypted`, and hardening (lyricad keeps only `PrivateTmp`
  and `ProtectControlGroups`; Caddy is fully hardened). The deploy check is
  the same: `NoNewPrivs` must be `0` for lyricad.
- lyricad's `PATH` starts with `/run/wrappers/bin`, so `fusermount3` is the
  setuid wrapper (`programs.fuse`), then gocryptfs, OpenSSL, systemd
  (`systemd-creds`) and the sandbox tools.
- Caddy is nixpkgs' Caddy built with the DNS plugins read from
  `daemon/src/web/providers.ts` (`caddy.withPlugins`). Its `hash` in
  `nix/module.nix` changes whenever that list or nixpkgs' Caddy does; `nix
  flake check` prints the new one.
- `net.ipv4.ip_nonlocal_bind = 1` and `/etc/lyrica/caddy.json`, as on Debian.
- It refuses to build with `security.allowUserNamespaces` off.

Options: `enable`, `package`, `port` (7340), `caddyPackage`,
`sandboxPackages`.

## Her sandboxes on NixOS

NixOS has no `/usr` to share, so the module sets `LYRICA_SANDBOX_TOOLS` to
one directory of `sandboxPackages` (`nix/sandbox-env.nix`). The sandbox then
mounts `/nix/store` read-only, that directory as `/usr`, and `/bin` and
`/sbin` as links to `usr/bin`, instead of the host's system folders
(docs/workspace.md). Its `bin` is also first on the `PATH` lyricad starts
`pasta`, `nft` and `bwrap` with. Everything in `/nix/store` is readable
inside, as `/usr` is on Debian, so secrets don't belong in the store.

The default tools are a shell, the usual command-line tools, git, OpenSSH,
curl, jq, ripgrep, Python, and bubblewrap, passt and nftables. bubblewrap,
passt, nftables, bash, coreutils and util-linux must stay: lyricad and the
self-test use them. To add tools:

```nix
{ options, pkgs, ... }: {
  services.lyrica.sandboxPackages =
    options.services.lyrica.sandboxPackages.default ++ [ pkgs.nodejs_22 ];
}
```

## Updates

A new version arrives with `nix flake update lyrica` and `nixos-rebuild
switch`, which restarts lyricad on the new package. As with re-running
install.sh today, nothing snapshots the databases first yet: the releases
work (docs/briefs/releases.md) adds the snapshot, the Update button through a
Lyrica-only Nix profile, and rollback.

## Checking a host

`nix/check-host.sh`, run as root after `lyrica admin init` and starting
lyricad, checks both services run, lyricad's `NoNewPrivs` is `0`,
`fusermount3` is setuid, Caddy's admin socket exists, a sandbox and `pasta`
start as `lyrica`, the self-test hasn't refused network, and lyricad answers
on `127.0.0.1:7340`. It ends with "All checks passed."
