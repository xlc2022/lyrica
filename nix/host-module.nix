# services.lyrica-host: what the model host (host/README.md) needs from a
# NixOS machine, declared here because NixOS's /etc is read-only and
# host/install.sh can't install packages or units on it. host/install.sh
# still builds and starts the Compose stack from a checkout, as on Debian.
# See host/README.md, "On NixOS".
{ config, lib, pkgs, ... }:

let
  cfg = config.services.lyrica-host;
  gpuUnlock = config.boot.kernelPackages.callPackage ./gpu-unlock.nix { };
  cmpUnlock = config.boot.kernelPackages.callPackage ./cmp-unlock.nix { };
  # Runs cmp100-unlock on the machine's CMP 100-210 cards (10de:1df4 or
  # 10de:1d84, as host/src/gpus.ts), or does nothing if it has none. The
  # script copies payloads over gv100's firmware for the run, so the kernel
  # reads firmware from a copy in /run meanwhile: symlinks to the system's,
  # with gv100's as real files.
  cmpUnlockRun = pkgs.writeShellScript "lyrica-cmp-unlock" ''
    set -euo pipefail
    bdfs=()
    for dev in /sys/bus/pci/devices/*; do
      if [[ $(<"$dev/vendor") == 0x10de && $(<"$dev/device") == 0x1@(df4|d84) ]]; then bdfs+=("''${dev##*/}"); fi
    done
    if [[ ''${#bdfs[@]} -eq 0 ]]; then echo "No CMP 100-210 here; nothing to unlock."; exit 0; fi
    export CMP100_BDFS="''${bdfs[*]}"
    fw=${config.hardware.firmware}/lib/firmware
    run=/run/cmp100-unlock/firmware
    rm -rf "$run"
    mkdir -p "$run"
    cp -rsL "$fw/." "$run/"
    rm -rf "$run/nvidia/gv100"
    cp -rL "$fw/nvidia/gv100" "$run/nvidia/gv100"
    chmod -R u+w "$run/nvidia/gv100"
    find "$run/nvidia/gv100" -name '*.zst' -exec zstd -dq --rm {} +
    find "$run/nvidia/gv100" -name '*.xz' -exec xz -d {} +
    param=/sys/module/firmware_class/parameters/path
    echo -n "$run" > "$param"
    trap 'echo -n "$fw" > "$param"; rm -rf /run/cmp100-unlock' EXIT
    ${cmpUnlock}/bin/cmp100-unlock "$@"
  '';
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

    gpuUnlock.enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        gpu-unlock (nix/gpu-unlock.nix): full-rate FP16/BF16 tensor math on
        GeForce RTX 20/30/40 cards, unlocked at every boot before the driver
        loads. RTX 30 is upstream's stable family; RTX 20 and 40 are
        experimental. It builds a kernel module and NVIDIA firmware (unfree)
        for this machine. To undo, set it false or boot an earlier generation.
      '';
    };

    cmpUnlock.enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        cmp100-unlock (nix/cmp-unlock.nix): full-rate tensor cores and PCIe
        Gen3 on NVIDIA CMP 100-210 cards (10de:1df4, 10de:1d84), applied at every boot
        before Docker starts and lost at power-off; the model servers notice it
        when they start (host/README.md, "CMP 100-210"). On a machine without
        one it does nothing. It uses the 580 driver, the last for Volta, with
        NVIDIA's proprietary kernel modules, and keeps nouveau and nvidia_drm
        from loading on their own, so the CMP can't drive a display. Add
        cmp100.skip to the kernel command line to skip it for one boot; set it
        false, or boot an earlier generation, to undo it.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = !(lib.hasPrefix "/opt/lyrica/" "${cfg.checkout}/");
      message = "services.lyrica-host.checkout must not be in /opt/lyrica: lyricad keeps its releases and repo.git there.";
    } {
      assertion = cfg.gpuUnlock.enable -> cfg.gpu == "nvidia";
      message = "services.lyrica-host.gpuUnlock is for NVIDIA GeForce cards: it needs gpu = \"nvidia\".";
    } {
      assertion = cfg.cmpUnlock.enable -> cfg.gpu == "nvidia" && !config.hardware.nvidia.open;
      message = "services.lyrica-host.cmpUnlock needs gpu = \"nvidia\" and hardware.nvidia.open = false: Volta has no open kernel modules.";
    }];

    # gpu-unlock: the module and its firmware go into the initrd and load
    # there, so the unlock runs before stage 2 loads nvidia. It touches only
    # the cards it supports and does nothing without the kernel parameter.
    boot.extraModulePackages = lib.mkIf cfg.gpuUnlock.enable [ gpuUnlock.module ];
    hardware.firmware = lib.mkIf cfg.gpuUnlock.enable [ gpuUnlock.firmware ];
    boot.initrd.kernelModules = lib.mkIf cfg.gpuUnlock.enable (lib.mkBefore [ "gpu_unlock" ]);
    boot.kernelParams = lib.mkIf cfg.gpuUnlock.enable [ "gpu_unlock.targets=all" ];

    # cmp100-unlock, as upstream's unit: before anything opens the GPUs. The
    # nvidia module blacklists nouveau already; the script loads it itself.
    boot.blacklistedKernelModules = lib.mkIf cfg.cmpUnlock.enable [ "nvidia_drm" ];
    hardware.nvidia.package = lib.mkIf cfg.cmpUnlock.enable
      (lib.mkDefault config.boot.kernelPackages.nvidiaPackages.legacy_580);
    systemd.services.cmp100-unlock = lib.mkIf cfg.cmpUnlock.enable {
      description = "Full-rate tensor cores and PCIe Gen3 on a CMP 100-210";
      after = [ "systemd-modules-load.service" "systemd-udev-settle.service" ];
      wants = [ "systemd-udev-settle.service" ];
      before = [ "display-manager.service" "graphical.target" "nvidia-persistenced.service"
        "docker.service" "containerd.service" "systemd-user-sessions.service" ];
      wantedBy = [ "multi-user.target" ];
      unitConfig.ConditionKernelCommandLine = "!cmp100.skip";
      path = with pkgs; [ coreutils findutils zstd xz config.hardware.nvidia.package.bin ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = cmpUnlockRun;
        TimeoutStartSec = 300;
        # A run it refuses (a GPU in use) stops nvidia-persistenced and leaves
        # it stopped; start it again.
        ExecStopPost = lib.mkIf config.hardware.nvidia.nvidiaPersistenced
          "${pkgs.bash}/bin/bash -c '[ \"$$SERVICE_RESULT\" = success ] || ${pkgs.systemd}/bin/systemctl start --no-block nvidia-persistenced.service'";
      };
    };

    # Docker, whose default iptables firewall backend egress.sh's rules need
    # (install.sh checks it); the NixOS firewall stays on iptables beside it.
    virtualisation.docker.enable = true;
    networking.nftables.enable = lib.mkDefault false;

    # NVIDIA: the driver, headless, and CDI devices (nvidia.com/gpu=all),
    # which install.sh finds under /var/run/cdi and uses through compose.cdi.yaml.
    services.xserver.videoDrivers = lib.mkIf (cfg.gpu == "nvidia") [ "nvidia" ];
    hardware.nvidia.open = lib.mkIf (cfg.gpu == "nvidia") (lib.mkDefault (!cfg.cmpUnlock.enable));
    hardware.nvidia-container-toolkit.enable = cfg.gpu == "nvidia";
    # AMD: amdgpu loaded at boot, so /dev/kfd and /dev/dri are there before Docker.
    hardware.amdgpu.initrd.enable = lib.mkIf (cfg.gpu == "amd") true;
    hardware.graphics.enable = lib.mkIf (cfg.gpu != "none") true;

    # What install.sh runs besides Docker.
    environment.systemPackages = with pkgs; [ git curl iptables iproute2 kmod gawk ]
      ++ lib.optional cfg.cmpUnlock.enable cmpUnlock;

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
