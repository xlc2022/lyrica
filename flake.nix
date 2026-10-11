{
  description = "Lyrica: lyricad, the lyrica CLI and a NixOS module (docs/daemon.md, On NixOS)";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-26.05/nixexprs.tar.xz";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      rev = self.rev or self.dirtyRev or "dirty";
    in {
      packages.${system} = rec {
        lyrica = pkgs.callPackage ./nix/package.nix { src = self; inherit rev; };
        default = lyrica;
        # The module's default sandbox tools; CI runs the sandbox tests with them.
        sandbox-tools = pkgs.callPackage ./nix/sandbox-env.nix { packages = import ./nix/sandbox-tools.nix pkgs; };
        sandbox-closure = pkgs.callPackage ./nix/sandbox-closure.nix { rootPaths = [ sandbox-tools pkgs.nodejs_22 pkgs.cacert ]; };
      };

      nixosModules.default = { pkgs, lib, ... }: {
        imports = [ ./nix/module.nix ];
        services.lyrica.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.lyrica;
      };

      checks.${system} = {
        package = self.packages.${system}.lyrica;
        # A whole NixOS system with the module on: it evaluates and builds.
        system = (nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            self.nixosModules.default
            {
              services.lyrica.enable = true;
              boot.loader.grub.enable = false;
              fileSystems."/" = { device = "/dev/null"; fsType = "ext4"; };
              system.stateVersion = "26.05";
            }
          ];
        }).config.system.build.toplevel;
      };
    };
}
