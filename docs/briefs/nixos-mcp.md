# NixOS MCP server

The owner asked (2026-11-01) to consider a NixOS MCP server, then to add
mcp-nixos as an installer option, and asked whether it can run on another
machine. Principle 3 (use what exists): mcp-nixos gives her Nix and NixOS
lookups, and a view of a machine's flake inputs and Nix store, without a
tool of ours; principle 8: no new tool, no new daemon of hers, one systemd
unit the operator turns on.

Survey and decision: thread "Add a NixOS MCP server for Lyrica", report at
https://claude.ai/artifact/98s8WPjYPUPCoaD87o6UXC. utensils/mcp-nixos
(MIT, in nixpkgs: 2.4.3 on nixos-26.05) over its HTTP transport, on
loopback; added in the General pool, since a server's pool is the pool of
the threads that may use it and the owner's own project is general (the
first guide said Private, which couldn't be granted to that project; the
development machine switched it to General on 2026-11-01). No server that rebuilds the host (nix-agent):
on her own machine a rebuild rewrites what confines her, and for another
machine the Machines design (SSH, mode limit, root steps on cards) is the
path. The rule against stdio servers was lifted the same day (#732) and
changed none of this: mcp-nixos speaks HTTP and keeps no state.

## Built

- `nix/mcp-nixos-module.nix`: `services.lyrica-mcp-nixos` (`enable`,
  `package`, `address` 127.0.0.1, `port` 8001), `lyrica-mcp-nixos.service`
  (default package: mcp-nixos 3.1.1 from the flake's `mcp-nixos` input, a
  release tag built by upstream's `lib.mkMcpNixos` against this nixpkgs
  with its own FastMCP 4 set; nixpkgs' 2.4.3 looks for search.nixos.org's
  indexes only under retired generations, so it reported 25.11 as stable),
  in HTTP mode with `nix` on its path, dynamic user with
  `/var/cache/lyrica-mcp-nixos` as home and cache (nix needs a writable
  cache for `nix flake archive`; PR review's finding), hardened like
  `lyrica-kiwix`. Exported as `nixosModules.mcp-nixos` for a machine that
  only runs the server.
- `services.lyrica.mcpNixos` (default false) in `nix/module.nix` turns it
  on beside her. `nix flake check`'s system has it on. `check-host.sh`
  checks it answers.
- Nothing fills the address in: the user adds it under Settings → MCP
  servers (General for general threads, a second Private copy for private
  ones). docs/guides/nixos-mcp.md, docs/daemon.md,
  docs/workspace.md, the getting-started guide.

## Out of scope

A Debian counterpart in install.sh (a NixOS lookup server on a Debian host
is an odd fit; add it if asked). Adopting the address into every user's
MCP servers by itself, as `kiwix-address` does for the Kiwix address:
MCP servers are per user and probed before saving, so that is a core
change, for later if the one-time add proves a nuisance. The upstream
pull request adding `readOnlyHint` to mcp-nixos's tools, which would
remove the permission card and let the tools work in Plan mode.

Checked 2026-11-17 in the build container with 3.1.1: the package builds
and its unit tests pass; through Lyrica's own MCP client it answers the
save check (2 tools, `nix` and `nix_versions`, still with no
annotations), and `action=channels` lists 26.05 as stable (index
generation 53) beside 25.11 and unstable; a bare GET answers 400, and
`check-host.sh` accepts any HTTP answer. 2.4.3 had probed only
generations 43 to 46, found none and fell back to a built-in map whose
stable was 25.11.

## Handoff

Done: the module, docs and check (#733); on 2026-11-17 the package moved
to upstream's 3.1.1 through a flake input, so stable means 26.05. Updating
it is `nix flake update mcp-nixos` here after moving the tag in flake.nix.
On 2026-11-01 the development
machine runs it (`services.lyrica.mcpNixos = true`), with the server added
as `nixos` in the General pool and granted on the owner's project. Next:
the first real use decides whether the permission card is a nuisance worth
the upstream PR. Open: whether to
teach her, in project instructions or memory, that a Machine is NixOS and
where its flake lives, so remote NixOS work goes smoothly.
