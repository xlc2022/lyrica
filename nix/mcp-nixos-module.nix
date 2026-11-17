# services.lyrica-mcp-nixos: mcp-nixos (github.com/utensils/mcp-nixos, a
# release the flake pins) as an MCP server Lyrica reaches over HTTP, for
# NixOS package, option, flake and Nix function lookups, and for reading a
# flake's inputs and /nix/store paths on this machine. Imported by nix/module.nix (its
# `mcpNixos` option turns it on beside her) and exported on its own as
# nixosModules.mcp-nixos, for a machine that only runs the server. It
# listens on loopback by default and has no authentication of its own, so
# another address must stay inside the operator's network. The user adds
# it in Settings → MCP servers, General for general threads
# (docs/guides/nixos-mcp.md).
{ config, lib, pkgs, ... }:

let
  cfg = config.services.lyrica-mcp-nixos;
in
{
  options.services.lyrica-mcp-nixos = {
    enable = lib.mkEnableOption "mcp-nixos, an MCP server for Nix and NixOS lookups, as lyrica-mcp-nixos.service";

    package = lib.mkOption {
      type = lib.types.package;
      # The flake's modules set this to mcp-nixos from its mcp-nixos input
      # (flake.nix), which finds search.nixos.org's current indexes; nixpkgs'
      # own 2.4.3 looks only under retired ones and reports 25.11 as stable.
      default = pkgs.mcp-nixos;
      defaultText = lib.literalExpression "mcp-nixos 3.1.1, from the flake's mcp-nixos input";
      description = "The mcp-nixos to run.";
    };

    address = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = ''
        The address it listens on. It has no authentication, so anything
        other than loopback must be an address only the operator's own
        network (LAN or tailnet) reaches.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8001;
      description = "Its port. The MCP endpoint is http://<address>:<port>/mcp.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.lyrica-mcp-nixos = {
      description = "mcp-nixos: Nix and NixOS lookups for Lyrica over MCP";
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      # flake-inputs runs `nix flake archive` in the directory the caller
      # passes as `source`; nix needs a writable cache for it, which the
      # dynamic user gets under /var/cache. store reads need nothing.
      path = [ config.nix.package ];
      environment = {
        HOME = "/var/cache/lyrica-mcp-nixos";
        XDG_CACHE_HOME = "/var/cache/lyrica-mcp-nixos";
        MCP_NIXOS_TRANSPORT = "http";
        MCP_NIXOS_HOST = cfg.address;
        MCP_NIXOS_PORT = toString cfg.port;
        MCP_NIXOS_PATH = "/mcp";
      };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/mcp-nixos";
        DynamicUser = true;
        CacheDirectory = "lyrica-mcp-nixos";
        Restart = "on-failure";
        RestartSec = 10;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
      };
    };
  };
}
