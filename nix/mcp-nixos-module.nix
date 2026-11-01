# services.lyrica-mcp-nixos: mcp-nixos (github.com/utensils/mcp-nixos, from
# nixpkgs) as an MCP server Lyrica reaches over HTTP, for NixOS package,
# option, flake and Nix function lookups, and for reading a flake's inputs
# and /nix/store paths on this machine. Imported by nix/module.nix (its
# `mcpNixos` option turns it on beside her) and exported on its own as
# nixosModules.mcp-nixos, for a machine that only runs the server. It
# listens on loopback by default and has no authentication of its own, so
# another address must stay inside the operator's network. The user adds
# it in Settings → MCP servers as a Private server (docs/guides/nixos-mcp.md).
{ config, lib, pkgs, ... }:

let
  cfg = config.services.lyrica-mcp-nixos;
in
{
  options.services.lyrica-mcp-nixos = {
    enable = lib.mkEnableOption "mcp-nixos, an MCP server for Nix and NixOS lookups, as lyrica-mcp-nixos.service";

    package = lib.mkOption {
      type = lib.types.package;
      # nixpkgs' mcp-nixos, built against a fastmcp whose test suite is skipped:
      # on nixos-26.05 neither is in the binary cache, and three of fastmcp's
      # proxy tests fail under the build sandbox (a cancel-scope race), which
      # would fail the whole nixos-rebuild. Only the tests are skipped: the
      # code is the channel's.
      default = pkgs.mcp-nixos.override {
        python3Packages = (pkgs.python3.override {
          packageOverrides = _: prev: { fastmcp = prev.fastmcp.overridePythonAttrs (_: { doCheck = false; }); };
        }).pkgs;
      };
      defaultText = lib.literalExpression "pkgs.mcp-nixos, with fastmcp's tests skipped";
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
      # flake-inputs runs `nix flake archive`; store reads need nothing.
      path = [ config.nix.package ];
      environment = {
        MCP_NIXOS_TRANSPORT = "http";
        MCP_NIXOS_HOST = cfg.address;
        MCP_NIXOS_PORT = toString cfg.port;
        MCP_NIXOS_PATH = "/mcp";
      };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/mcp-nixos";
        DynamicUser = true;
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
