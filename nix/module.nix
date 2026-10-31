# services.lyrica: lyricad, her own tailscaled and the built-in Caddy on NixOS,
# declaring what daemon/deploy/install.sh does on Debian. The units mirror
# daemon/deploy/lyricad.service, lyrica-tailscaled.service,
# lyrica-caddy.service, lyrica-searxng.service and lyrica-kiwix.service; keep them in step.
# See docs/daemon.md, "On NixOS".
{ config, lib, pkgs, ... }:

let
  cfg = config.services.lyrica;
  state = "/var/lib/lyrica";
  # Direct web access's port, whatever `port` is: DIRECT_PORT in daemon/src/web/access.ts.
  directPort = 7340;
  # SearXNG's port on 127.0.0.1, as SEARXNG_PORT in daemon/deploy/install.sh.
  searxngPort = 8888;
  # kiwix-serve's port on 127.0.0.1, as KIWIX_PORT in daemon/deploy/install.sh.
  kiwixPort = 8889;

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

  # Releases: lyricad runs from this profile, which an Update (Administration →
  # Updates) or `lyrica-rollback` switches and nixos-rebuild resets to cfg.package.
  profile = "/nix/var/nix/profiles/lyrica";
  # The updater, from the store: never part of an update, as on Debian.
  updater = pkgs.runCommand "lyrica-updater" { } ''
    mkdir -p $out/lib/lyrica-update $out/bin
    { echo 'PATH=${lib.makeBinPath (with pkgs; [ bash coreutils findutils gnugrep gnused jq curl git openssh util-linux config.nix.package systemd ])}:$PATH'
      cat ${../daemon/deploy/updater/common.sh}; } >$out/lib/lyrica-update/common.sh
    for t in lyrica-update lyrica-snapshot lyrica-restore lyrica-rollback lyrica-nixos-start; do
      install -m755 ${../daemon/deploy/updater}/$t $out/bin/$t
      substituteInPlace $out/bin/$t \
        --replace-quiet /usr/local/lib/lyrica-update $out/lib/lyrica-update --replace-quiet /usr/local/sbin $out/bin
    done
    patchShebangs $out/bin
  '';
  githubHostKey = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
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
        hash = "sha256-82zy3KS7mYK8z8v/L9KiHOBQkYCeoY4MdgyI09MLUH0=";
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
        Opens Direct's port (7340) in the firewall. On by default, unlike most
        NixOS modules: a headless host is set up from another machine through
        it, as on Debian, and it answers only while setting up or in the Direct
        web access mode.
      '';
    };

    searxng = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        A SearXNG for her web search: NixOS's services.searx, in uWSGI with
        request logging off (its built-in server would log every query), on
        127.0.0.1:8888 with JSON on and the limiter off, its secret made on
        first boot. lyricad stores http://127.0.0.1:8888 as Administration →
        Web search's address while none is set, as on Debian with install.sh.
        Further services.searx.settings merge in.
      '';
    };

    zimDir = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/srv/lyrica/zim";
      description = ''
        A folder of ZIM files (an offline copy of Wikipedia from
        download.kiwix.org), served by kiwix-serve from kiwix-tools as
        lyrica-kiwix.service on 127.0.0.1:8889, no search bar, every .zim
        in the folder that kiwix can open at start (one still downloading
        is skipped and logged). lyricad stores http://127.0.0.1:8889 as
        Administration → Web search's Kiwix address while none is set, as
        on Debian with install.sh. Null runs nothing.
      '';
    };

    sandboxPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = import ./sandbox-tools.nix pkgs;
      defaultText = lib.literalMD "a shell, the usual command-line tools, git, curl, Python, Chromium and fonts, and bubblewrap, passt and nftables";
      description = ''
        The tools her sandboxes have, mounted as their /usr. Add to it with
        `services.lyrica.sandboxPackages = options.services.lyrica.sandboxPackages.default ++ [ … ];`.
        bubblewrap, passt, nftables, bash, coreutils and util-linux must stay:
        lyricad and its self-test use them. Her sandboxes see only these
        packages' closure in /nix/store, plus Node's and the CA bundle's.
        Chromium and fonts render HTML/SVG diagrams offline and take screenshots.
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
    # Builds releases and runs their smoke tests: no access to her data.
    users.groups.lyrica-build = { };
    users.users.lyrica-build = {
      isSystemUser = true;
      group = "lyrica-build";
    };
    users.users.lyrica-caddy = {
      isSystemUser = true;
      group = "lyrica-caddy";
      home = "/var/lib/lyrica-caddy";
    };

    # Exists before the first start, for `lyrica admin setup-code` and `lyrica admin init`.
    systemd.tmpfiles.rules = [
      "d ${state} 0700 lyrica lyrica -"
      "d /var/lib/lyrica-update 0755 root root -"
      "d /var/lib/lyrica-snapshots 0700 root root -"
      "d /opt/lyrica 0755 root root -"
      # The address lyricad offers Administration → Web search (core/src/web.ts, adoptLocalSearxng).
      (if cfg.searxng then "f+ ${state}/searxng-address 0600 lyrica lyrica - http://127.0.0.1:${toString searxngPort}"
       else "r ${state}/searxng-address")
      (if cfg.zimDir != null then "f+ ${state}/kiwix-address 0600 lyrica lyrica - http://127.0.0.1:${toString kiwixPort}"
       else "r ${state}/kiwix-address")
    ];

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ directPort ];

    # As daemon/deploy/searxng-settings.yml and lyrica-searxng.service on Debian.
    services.searx = lib.mkIf cfg.searxng {
      enable = true;
      environmentFile = "/var/lib/lyrica-searxng/env";
      configureUwsgi = true;
      uwsgiConfig = { http = "127.0.0.1:${toString searxngPort}"; disable-logging = true; };
      settings = {
        server = { bind_address = "127.0.0.1"; port = searxngPort; secret_key = "$SEARX_SECRET_KEY"; limiter = false; image_proxy = false; };
        search = {
          formats = [ "html" "json" ]; safe_search = 0; default_lang = "auto";
          # How long an engine rests after refusing (SearXNG's own defaults rest one for up to a day).
          suspended_times = { SearxEngineAccessDenied = 600; SearxEngineCaptcha = 900; SearxEngineTooManyRequests = 180; };
        };
        outgoing = { request_timeout = 6.0; max_request_timeout = 10.0; };
        # General search asks five engines, so one resting after a CAPTCHA doesn't end her search; startpage only ever answers with a CAPTCHA.
        engines = [
          { name = "bing"; disabled = false; }
          { name = "qwant"; disabled = false; }
          { name = "yahoo"; disabled = false; }
          { name = "startpage"; disabled = true; }
        ];
      };
    };
    # Its secret_key, made once.
    systemd.services.lyrica-searxng-secret = lib.mkIf cfg.searxng {
      description = "SearXNG's secret for Lyrica's web search";
      before = [ "searx-init.service" ];
      requiredBy = [ "searx-init.service" ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; StateDirectory = "lyrica-searxng"; StateDirectoryMode = "0700"; UMask = "0077"; };
      script = ''
        f=/var/lib/lyrica-searxng/env
        [ -s "$f" ] || echo "SEARX_SECRET_KEY=$(${pkgs.openssl}/bin/openssl rand -hex 32)" >"$f"
      '';
    };

    # As daemon/deploy/lyrica-kiwix.service on Debian.
    systemd.services.lyrica-kiwix = lib.mkIf (cfg.zimDir != null) {
      description = "kiwix-serve for Lyrica's offline Wikipedia";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.kiwix-tools ];
      environment = { ZIM_DIR = toString cfg.zimDir; KIWIX_PORT = toString kiwixPort; };
      serviceConfig = {
        DynamicUser = true;
        RuntimeDirectory = "lyrica-kiwix";
        ExecStart = pkgs.writeShellScript "lyrica-kiwix-start" (builtins.readFile ../daemon/deploy/lyrica-kiwix-start);
        Restart = "on-failure";
        RestartSec = 10;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
      };
    };

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
        ExecStart = "${cfg.tailscalePackage}/bin/tailscaled --tun=userspace-networking --state=/var/lib/lyrica-tailscale/tailscaled.state --socket=/run/lyrica-tailscale/tailscaled.sock --port=0 --outbound-http-proxy-listen=127.0.0.1:1056";
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
    # It runs the release lyricad runs; `lyrica-rollback` and the other updater commands are root's.
    environment.systemPackages = [
      (pkgs.runCommand "lyrica-cli" { } ''
        install -Dm755 ${../daemon/deploy/lyrica} $out/bin/lyrica
        substituteInPlace $out/bin/lyrica --replace-fail @CLI@ ${profile}/bin/lyrica --replace-fail @STATE@ ${state}
      '')
      updater
    ];
    environment.etc."lyrica/known_hosts".text = githubHostKey + "\n";

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

    # As daemon/deploy/lyrica-update.service, .path, lyrica-rollback.service and lyrica-probation.service.
    systemd.services.lyrica-update = {
      description = "Lyrica's updater (build, smoke test, drain, snapshot, switch, probation)";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        # Updates build on the host's nixpkgs: the same Node as the sandbox closure's.
        LYRICA_NIXPKGS = "${pkgs.path}";
        LYRICA_SANDBOX_TOOLS = "${sandboxTools}";
        LYRICA_SANDBOX_CLOSURE = "${sandboxClosure}/store-paths";
        LYRICA_SMOKE_PATH = "/run/wrappers/bin:${lib.makeBinPath [ pkgs.gocryptfs pkgs.openssl pkgs.coreutils pkgs.bash sandboxTools ]}";
      };
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${updater}/bin/lyrica-update --request";
        TimeoutStartSec = "infinity";
        Nice = 10;
        IOSchedulingClass = "idle";
        PrivateTmp = true;
      };
    };
    systemd.paths.lyrica-update = {
      description = "Lyrica's update requests";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathExists = "${state}/updates/request.json";
    };
    systemd.services.lyrica-probation = {
      description = "Resume Lyrica's update probation after a reboot";
      after = [ "lyricad.service" ];
      wants = [ "lyricad.service" ];
      wantedBy = [ "multi-user.target" ];
      unitConfig.ConditionPathExists = "/var/lib/lyrica-update/probation.json";
      serviceConfig = {
        Type = "exec";
        ExecStart = "${updater}/bin/lyrica-update --resume";
        Nice = 10;
        IOSchedulingClass = "idle";
        PrivateTmp = true;
      };
    };
    systemd.services.lyrica-rollback = {
      description = "Roll Lyrica back if the release on probation crash-loops";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${updater}/bin/lyrica-rollback --auto";
      };
    };

    systemd.services.lyricad = {
      description = "Lyrica (lyricad)";
      after = [ "network-online.target" "lyrica-caddy.service" ] ++ lib.optional cfg.tailscale "lyrica-tailscaled.service";
      wants = [ "network-online.target" "lyrica-caddy.service" ] ++ lib.optional cfg.tailscale "lyrica-tailscaled.service";
      wantedBy = [ "multi-user.target" ];
      # Without self.db it starts setting up: `lyrica admin setup-code` prints the code.
      # A crash loop on probation rolls back (lyrica-rollback.service).
      startLimitBurst = 3;
      startLimitIntervalSec = 120;
      onFailure = [ "lyrica-rollback.service" ];
      environment = {
        LYRICA_HOME = state;
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
        # As root: a changed cfg.package becomes the profile, after a snapshot.
        ExecStartPre = "+${updater}/bin/lyrica-nixos-start ${cfg.package} ${cfg.package.build or "dirty"}";
        ExecStart = "${profile}/bin/lyrica serve --port ${toString cfg.port}";
        # LYRICA_BUILD for the release the profile holds.
        EnvironmentFile = "-/var/lib/lyrica-update/build.env";
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
