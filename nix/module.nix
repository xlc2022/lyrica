# services.lyrica: lyricad, her own tailscaled and the built-in Caddy on NixOS,
# declaring what daemon/deploy/install.sh does on Debian. The units mirror
# daemon/deploy/lyricad.service, lyrica-tailscaled.service and
# lyrica-caddy.service; keep them in step.
# See docs/daemon.md, "On NixOS".
{ config, lib, pkgs, ... }:

let
  cfg = config.services.lyrica;
  state = "/var/lib/lyrica";

  # The DNS plugins, read from the same table install.sh builds from.
  providers = builtins.readFile ../daemon/src/web/providers.ts;
  plugins = lib.pipe (lib.splitString "\n" providers) [
    (map (builtins.match ''.*module: "([^"]+)".*''))
    (lib.filter (m: m != null))
    (map builtins.head)
  ];

  # What her sandboxes see as /usr. lyricad also finds bwrap, pasta and nft here.
  sandboxTools = pkgs.callPackage ./sandbox-env.nix { packages = cfg.sandboxPackages; };
  # Only these store paths are mounted in her sandboxes.
  sandboxClosure = pkgs.callPackage ./sandbox-closure.nix {
    rootPaths = [ sandboxTools cfg.package.nodejs config.security.pki.caBundle ];
  };
in {
  options.services.lyrica = {
    enable = lib.mkEnableOption "Lyrica (lyricad and its built-in Caddy)";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The lyrica package. The flake's module sets it to the flake's own.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 7340;
      description = "lyricad's port on 127.0.0.1.";
    };

    caddyPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.caddy.withPlugins {
        inherit plugins;
        # Changes whenever a plugin in daemon/src/web/providers.ts or nixpkgs' Caddy does;
        # `nix flake check` prints the new one.
        hash = "sha256-nb5feCtr6tT1IzZgsa/E4B1iv1hs0ZZBWSoAqOIIdQw=";
      };
      defaultText = lib.literalExpression "caddy with the DNS plugins in daemon/src/web/providers.ts";
      description = "Caddy with the DNS plugins lyricad configures.";
    };

    tailscale = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Her own tailscaled (lyrica-tailscaled.service: userspace networking, as
        the lyrica user, with its own state and socket), so she joins a tailnet
        as a device of her own from Administration → Tailnet. The host's own
        services.tailscale, if any, is untouched.
      '';
    };

    tailscalePackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.tailscale;
      defaultText = lib.literalExpression "pkgs.tailscale";
      description = "The Tailscale package her tailscaled and lyricad's `tailscale` come from.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Opens lyricad's port (7340) in the firewall. On by default, unlike most
        NixOS modules: a headless host is set up from another machine through
        it, as on Debian, and it answers only while setting up or in the Direct
        web access mode.
      '';
    };

    sandboxPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = import ./sandbox-tools.nix pkgs;
      defaultText = lib.literalMD "a shell, the usual command-line tools, git, curl, Python, and bubblewrap, passt and nftables";
      description = ''
        The tools her sandboxes have, mounted as their /usr. Add to it with
        `services.lyrica.sandboxPackages = options.services.lyrica.sandboxPackages.default ++ [ … ];`.
        bubblewrap, passt, nftables, bash, coreutils and util-linux must stay:
        lyricad and its self-test use them. Her sandboxes see only these
        packages' closure in /nix/store, plus Node's and the CA bundle's.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = config.security.allowUserNamespaces;
      message = "services.lyrica needs unprivileged user namespaces (bubblewrap, pasta): security.allowUserNamespaces must stay on.";
    }];

    users.groups.lyrica = { };
    users.groups.lyrica-caddy = { };
    users.users.lyrica = {
      isSystemUser = true;
      group = "lyrica";
      home = state;
    };
    users.users.lyrica-caddy = {
      isSystemUser = true;
      group = "lyrica-caddy";
      home = "/var/lib/lyrica-caddy";
    };

    # Exists before the first start, for `lyrica admin setup-code` and `lyrica admin init`.
    systemd.tmpfiles.rules = [ "d ${state} 0700 lyrica lyrica -" ];

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.lyrica-tailscaled = lib.mkIf cfg.tailscale {
      description = "Tailscale for Lyrica (her own device, userspace networking)";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      environment.HOME = "/var/lib/lyrica-tailscale";
      serviceConfig = {
        Type = "notify";
        User = "lyrica";
        Group = "lyrica";
        # --port=0 picks a free UDP port, so it never fights the host's tailscaled over 41641.
        ExecStart = "${cfg.tailscalePackage}/bin/tailscaled --tun=userspace-networking --state=/var/lib/lyrica-tailscale/tailscaled.state --socket=/run/lyrica-tailscale/tailscaled.sock --port=0";
        StateDirectory = "lyrica-tailscale";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "lyrica-tailscale";
        RuntimeDirectoryMode = "0700";
        CacheDirectory = "lyrica-tailscale";
        CacheDirectoryMode = "0700";
        UMask = "0077";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictNamespaces = true;
        LockPersonality = true;
        CapabilityBoundingSet = "";
        Restart = "on-failure";
        RestartSec = 5;
      };
    };

    # The setuid fusermount3 that gocryptfs uses for her home.
    programs.fuse.enable = lib.mkDefault true;

    # `lyrica` on the PATH runs the CLI as lyrica with her state folder, as on Debian.
    environment.systemPackages = [
      (pkgs.runCommand "lyrica-cli" { } ''
        install -Dm755 ${../daemon/deploy/lyrica} $out/bin/lyrica
        substituteInPlace $out/bin/lyrica --replace-fail @CLI@ ${lib.getExe cfg.package} --replace-fail @STATE@ ${state}
      '')
    ];

    # Caddy binds its addresses even before they're up (Tailscale at boot, a DHCP renewal).
    boot.kernel.sysctl."net.ipv4.ip_nonlocal_bind" = 1;

    # Only Caddy's first start: its admin API on the group-only socket. lyricad loads the rest.
    environment.etc."lyrica/caddy.json".text = builtins.toJSON {
      admin.listen = "unix//run/lyrica-caddy/admin.sock|0660";
    };

    systemd.services.lyrica-caddy = {
      description = "Caddy for Lyrica (configured by lyricad)";
      after = [ "network-online.target" "tailscaled.service" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      environment = {
        XDG_CONFIG_HOME = "/var/lib/lyrica-caddy/config";
        XDG_DATA_HOME = "/var/lib/lyrica-caddy/data";
      };
      serviceConfig = {
        Type = "simple";
        User = "lyrica-caddy";
        Group = "lyrica-caddy";
        # A saved config that can't load any more is moved aside, so Caddy still starts with its admin socket.
        ExecStartPre = pkgs.writeShellScript "lyrica-caddy-check" ''
          f=/var/lib/lyrica-caddy/config/caddy/autosave.json
          [ ! -f "$f" ] || ${lib.getExe cfg.caddyPackage} validate --config "$f" >/dev/null 2>&1 || mv -f "$f" "$f.bad"
        '';
        ExecStart = "${lib.getExe cfg.caddyPackage} run --config /etc/lyrica/caddy.json --resume";
        StateDirectory = "lyrica-caddy";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "lyrica-caddy";
        RuntimeDirectoryMode = "0750";
        UMask = "0027";
        AmbientCapabilities = [ "CAP_NET_BIND_SERVICE" ];
        CapabilityBoundingSet = [ "CAP_NET_BIND_SERVICE" ];
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictNamespaces = true;
        LockPersonality = true;
        LimitNOFILE = 1048576;
        TimeoutStopSec = 10;
        Restart = "on-failure";
        RestartSec = 5;
      };
    };

    systemd.services.lyricad = {
      description = "Lyrica (lyricad)";
      after = [ "network-online.target" "lyrica-caddy.service" ] ++ lib.optional cfg.tailscale "lyrica-tailscaled.service";
      wants = [ "network-online.target" "lyrica-caddy.service" ] ++ lib.optional cfg.tailscale "lyrica-tailscaled.service";
      wantedBy = [ "multi-user.target" ];
      # Without self.db it starts setting up: `lyrica admin setup-code` prints the code.
      environment = {
        LYRICA_HOME = state;
        LYRICA_BUILD = cfg.package.build or "nix";
        LYRICA_SANDBOX_TOOLS = "${sandboxTools}";
        LYRICA_SANDBOX_CLOSURE = "${sandboxClosure}/store-paths";
        # The setuid wrappers first: fusermount3 must be the setuid one.
        PATH = lib.mkForce "/run/wrappers/bin:${lib.makeBinPath ([ pkgs.gocryptfs pkgs.openssl pkgs.systemd pkgs.coreutils pkgs.bash sandboxTools ] ++ lib.optional cfg.tailscale cfg.tailscalePackage)}";
      };
      serviceConfig = {
        Type = "simple";
        User = "lyrica";
        Group = "lyrica";
        SupplementaryGroups = [ "lyrica-caddy" ];
        StateDirectory = [ "lyrica" "lyrica/credentials" ];
        StateDirectoryMode = "0700";
        UMask = "0077";
        ExecStart = "${lib.getExe cfg.package} serve --port ${toString cfg.port}";
        LoadCredentialEncrypted = "lyrica:${state}/credentials";
        KillSignal = "SIGTERM";
        TimeoutStopSec = 30;
        Restart = "on-failure";
        RestartSec = 5;
        # Hardening as in daemon/deploy/lyricad.service: bubblewrap and pasta need
        # unprivileged user namespaces and gocryptfs the setuid fusermount3, so
        # NoNewPrivileges and every option that implies it (seccomp filters)
        # stay off. NixOS adds none by default.
        ProtectControlGroups = true;
        PrivateTmp = true;
      };
    };
  };
}
