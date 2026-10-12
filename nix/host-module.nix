# services.lyrica-host: what the model host (host/README.md) needs from a
# NixOS machine, declared here because NixOS's /etc is read-only and
# host/install.sh can't install packages or units on it. host/install.sh
# still builds and starts the Compose stack from a checkout, as on Debian.
# See host/README.md, "On NixOS".
{ config, lib, pkgs, ... }:

let
  cfg = config.services.lyrica-host;
in {
  options.services.lyrica-host = {
    enable = lib.mkEnableOption "the Lyrica model host's prerequisites";

    checkout = lib.mkOption {
      type = lib.types.str;
      default = "/srv/lyrica-host";
      description = ''
        The clone of the Lyrica repository host/install.sh runs from. The
        egress unit runs its host/egress.sh with the address in host/.env.
        Never /opt/lyrica, which is lyricad's own (releases and repo.git).
      '';
    };

    modelsDir = lib.mkOption {
      type = lib.types.str;
      default = "/srv/models";
      description = "The models folder (install.sh's --models), created if missing.";
    };

    gpu = lib.mkOption {
      type = lib.types.enum [ "nvidia" "amd" "none" ];
      default = "nvidia";
      description = ''
        The GPU vendor (install.sh's --vendor).
        - nvidia: the driver (open kernel modules, Turing or newer) and the
          container toolkit's CDI devices for Docker. The driver is unfree:
          the machine's configuration must allow it (nixpkgs.config.allowUnfree,
          or an allowUnfreePredicate naming nvidia-x11 and nvidia-settings).
        - amd: the amdgpu kernel module, loaded at boot. ROCm and Vulkan come
          inside the model servers' images; they need only /dev/kfd and /dev/dri.
        - none: no GPU (install.sh --no-gpu, for testing).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = !(lib.hasPrefix "/opt/lyrica/" "${cfg.checkout}/");
      message = "services.lyrica-host.checkout must not be in /opt/lyrica: lyricad keeps its releases and repo.git there.";
    }];

    # Docker, whose default iptables firewall backend egress.sh's rules need
    # (install.sh checks it); the NixOS firewall stays on iptables beside it.
    virtualisation.docker.enable = true;
    networking.nftables.enable = lib.mkDefault false;

    # NVIDIA: the driver, headless, and CDI devices (nvidia.com/gpu=all),
    # which install.sh finds under /var/run/cdi and uses through compose.cdi.yaml.
    services.xserver.videoDrivers = lib.mkIf (cfg.gpu == "nvidia") [ "nvidia" ];
    hardware.nvidia.open = lib.mkIf (cfg.gpu == "nvidia") (lib.mkDefault true);
    hardware.nvidia-container-toolkit.enable = cfg.gpu == "nvidia";
    # AMD: amdgpu loaded at boot, so /dev/kfd and /dev/dri are there before Docker.
    hardware.amdgpu.initrd.enable = lib.mkIf (cfg.gpu == "amd") true;
    hardware.graphics.enable = lib.mkIf (cfg.gpu != "none") true;

    # What install.sh runs besides Docker.
    environment.systemPackages = with pkgs; [ git curl iptables iproute2 kmod gawk ];

    # lyrica/ too, so install.sh needn't be root to make it; the fetch
    # container takes it over (10001) on its first run.
    systemd.tmpfiles.rules = [
      "d ${cfg.modelsDir} 0755 root root -"
      "d ${cfg.modelsDir}/lyrica 0755 10001 10001 -"
    ];

    # As host/lyrica-host-egress.service, which install.sh installs on other
    # systems: host-api's rules before Docker starts, after every reboot.
    systemd.services.lyrica-host-egress = {
      description = "Lyrica model host: no outbound connections from host-api";
      before = [ "docker.service" ];
      after = [ "firewall.service" ];
      partOf = [ "docker.service" ];
      wantedBy = [ "docker.service" ];
      path = with pkgs; [ bash coreutils gnused iptables ];
      # Until install.sh has written host/.env there is no address to name.
      unitConfig.ConditionPathExists = "${cfg.checkout}/host/.env";
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${pkgs.bash}/bin/bash ${cfg.checkout}/host/egress.sh apply";
      };
    };
  };
}
