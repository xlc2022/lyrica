# NixOS MCP server

The owner asked (2026-11-01) to consider a NixOS MCP server, then to add
mcp-nixos as an installer option, and asked whether it can run on another
machine. Principle 3 (use what exists): mcp-nixos gives her Nix and NixOS
lookups, and a view of a machine's flake inputs and Nix store, without a
tool of ours; principle 8: no new tool, no new daemon of hers, one systemd
unit the operator turns on.

Survey and decision: thread "Add a NixOS MCP server for Lyrica", report at
https://claude.ai/artifact/98s8WPjYPUPCoaD87o6UXC. utensils/mcp-nixos
(MIT, in nixpkgs: 2.4.3 on nixos-26.05) over its HTTP transport, as a
Private server on loopback. No server that rebuilds the host (nix-agent):
on her own machine a rebuild rewrites what confines her, and for another
machine the Machines design (SSH, mode limit, root steps on cards) is the
path. The rule against stdio servers was lifted the same day (#732) and
changed none of this: mcp-nixos speaks HTTP and keeps no state.

## Built

- `nix/mcp-nixos-module.nix`: `services.lyrica-mcp-nixos` (`enable`,
  `package`, `address` 127.0.0.1, `port` 8001), `lyrica-mcp-nixos.service`
  (default package: nixpkgs' mcp-nixos 2.4.3 built against fastmcp with
  its tests skipped, since neither is in the nixos-26.05 binary cache and
  three fastmcp proxy tests fail in the build sandbox),
  in HTTP mode with `nix` on its path, dynamic user with
  `/var/cache/lyrica-mcp-nixos` as home and cache (nix needs a writable
  cache for `nix flake archive`; PR review's finding), hardened like
  `lyrica-kiwix`. Exported as `nixosModules.mcp-nixos` for a machine that
  only runs the server.
- `services.lyrica.mcpNixos` (default false) in `nix/module.nix` turns it
  on beside her. `nix flake check`'s system has it on. `check-host.sh`
  checks it answers.
- Nothing fills the address in: the user adds it under Settings → MCP
  servers (Private). docs/guides/nixos-mcp.md, docs/daemon.md,
  docs/workspace.md, the getting-started guide.

## Out of scope

A Debian counterpart in install.sh (a NixOS lookup server on a Debian host
is an odd fit; add it if asked). Adopting the address into every user's
MCP servers by itself, as `kiwix-address` does for the Kiwix address:
MCP servers are per user and probed before saving, so that is a core
change, for later if the one-time add proves a nuisance. The upstream
pull request adding `readOnlyHint` to mcp-nixos's tools, which would
remove the permission card and let the tools work in Plan mode.

Checked 2026-11-01 in the build container: the package builds, answers
`initialize` (version 2.4.3), lists `nix` and `nix_versions` with no
annotations, and a `store` listing works; a bare GET answers 406, which
is what `check-host.sh` accepts.

## Handoff

Done: the module, docs and check. Next: the operator turns it on
(`services.lyrica.mcpNixos = true` on the development machine) and adds
the server in Settings; then the first real use decides whether the
permission card is a nuisance worth the upstream PR. Open: whether to
teach her, in project instructions or memory, that a Machine is NixOS and
where its flake lives, so remote NixOS work goes smoothly.
