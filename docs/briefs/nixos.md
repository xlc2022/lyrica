# Brief: NixOS

**Thread:** NixOS. **Branch:** `claude/project-thread-hf25g9`. **Model:** Opus.

**Read first:** AGENTS.md, docs/daemon.md "Deployment", docs/workspace.md
(the sandbox), docs/briefs/releases.md item 7.

## Goal

A user can run Lyrica on NixOS with one module and `nixos-rebuild`, with the
same users, units, hardening and sandboxes as on Debian (principle 2: one
operator, simple boundaries).

## In scope

1. `flake.nix`: the package (lyricad, CLI, web UI) and `nixosModules.default`.
2. The module: users, both units, Caddy with the DNS plugins, the sysctl,
   the setuid `fusermount3`, sandbox tools.
3. The sandbox's system from `LYRICA_SANDBOX_TOOLS` when set, with only
   the store paths in `LYRICA_SANDBOX_CLOSURE`; Debian unchanged.
4. CI: `nix flake check`, and the sandbox tests with the NixOS tools.
5. Docs: daemon.md "On NixOS", workspace.md, ci.md, DESIGN.md; the operator guide from the Operator docs thread.

## Out of scope

nixpkgs submission, ARM, the model host on NixOS, and updates: the Update
button through a Lyrica-only Nix profile, the snapshot before a version
change and rollback belong to the releases build (releases.md item 7, the owner's
choice of 2026-10-11).

## Handoff

- **Done:** items 1-5. The package builds, a NixOS system with the module
  builds, the CLI and native modules load, and the non-network sandbox
  tests pass with the NixOS tools (the network ones need `/dev/net/tun`,
  which the cloud sessions lack; CI runs them).
- **Next:** The owner runs `nix/check-host.sh` on a real NixOS host (docs/daemon.md "On NixOS"). It
  checks the releases profile and `lyrica-update.path` too.
- **Open:** none.
