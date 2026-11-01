# Nix and NixOS lookups: the mcp-nixos server

[mcp-nixos](https://github.com/utensils/mcp-nixos) is an MCP server that
answers questions about Nix and NixOS: which packages and options exist and
what they do (search.nixos.org), Home Manager, nix-darwin and Nixvim
options, flakes on FlakeHub, Nix function docs (Noogle), the NixOS wiki and
nix.dev, package version history (NixHub) and binary-cache status. On the
machine it runs on it also lists a flake's pinned inputs and reads files
under `/nix/store`. Lyrica reaches it like any MCP server (Settings → **MCP
servers**), so a thread can ask it how to write an option before editing
a NixOS configuration, or, given the flake's directory, check what her
own machine is pinned to.

It needs no account or key and changes nothing. Its lookups go to the sites
above over the internet; the two local actions stay on the machine.

## Run it beside her (NixOS)

```nix
services.lyrica.mcpNixos = true;
```

Then `nixos-rebuild switch`. The module runs `lyrica-mcp-nixos.service`:
nixpkgs' `mcp-nixos` in HTTP mode on `127.0.0.1:8001` (endpoint
`http://127.0.0.1:8001/mcp`), as a dynamic user with `nix` on its path and
a cache under `/var/cache/lyrica-mcp-nixos`, so its flake-inputs action
can run `nix flake archive` on a flake of this machine. That action needs
the flake's directory named in the call (its `source`, for example
`/etc/nixos`; the unit's own working directory is `/`), and the `flakes`
and `nix-command` features on in the system's `nix.settings`.
`nix/check-host.sh` checks that it answers. Nothing fills the address in
for her: add it as below.

## Run it on another machine

Any NixOS machine on your LAN or tailnet can run it instead. In that
machine's flake:

```nix
inputs.lyrica.url = "github:xlc2022/lyrica";
# in the system's modules:
lyrica.nixosModules.mcp-nixos
{
  services.lyrica-mcp-nixos.enable = true;
  services.lyrica-mcp-nixos.address = "100.64.0.9"; # its tailnet or LAN address
  # services.lyrica-mcp-nixos.port = 8001;
}
```

The server has no password of its own, so give it only an address that
your own network reaches, never a public one, and open its port in that
machine's firewall for your network alone. Run remotely, its flake-inputs
and store actions describe that machine, not Lyrica's.

## Add it in Lyrica

Settings → **MCP servers** → **Add server**: a name (`nixos`), the URL
(`http://127.0.0.1:8001/mcp`, or the other machine's address and port),
Pool **Private**, no token. Lyrica checks the server before saving; the row
then shows its host, Private and 2 tools (`nix` and `nix_versions`). Grant
it in a thread's drawer under MCP servers, or under **Workspace** on
Project settings so every thread of the project has it.

The server doesn't mark its tools read-only, so the first call to each
tool in a thread asks with a permission card; **Allow in this thread**
answers for the rest of that thread, and the tools are off in Plan mode.
Both go away if upstream adds the `readOnlyHint` annotation.

## Remove it

Set `services.lyrica.mcpNixos = false` (or drop the module) and rebuild,
then remove the server row in Settings → **MCP servers**; the dialog names
the threads that lose it.
