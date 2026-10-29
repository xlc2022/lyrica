# gpu-unlock (https://github.com/Zagitta/gpu-unlock, GPL-2.0-only): a kernel
# module that lifts GeForce cards' half-rate FP16/BF16/TF32 tensor math at
# boot, before nvidia binds them. services.lyrica-host.gpuUnlock turns it on
# (nix/host-module.nix); host/gpu-unlock.sh installs the same commit on Debian.
# Both pin the commit and NVIDIA's two inputs below; change all three
# together. callPackage it from the kernel's package set (boot.kernelPackages).
{ lib, stdenv, stdenvNoCC, fetchFromGitHub, fetchurl, python3, zstd, kernel, kernelModuleMakeFlags }:

let
  version = "2.0.0";
  nv = "610.43.03";
  src = fetchFromGitHub {
    owner = "Zagitta";
    repo = "gpu-unlock";
    rev = "7eb51bccae0a0b7e599e084d971170e9a1e82d0c";
    hash = "sha256-1KD/J1S1uyI5GGoTwQ1cU/sXeEKlG54exSvi6U+j73M=";
  };
  # The hashes upstream's packaging/arch/PKGBUILD pins at that commit.
  nvSource = fetchurl {
    url = "https://download.nvidia.com/XFree86/NVIDIA-kernel-module-source/NVIDIA-kernel-module-source-${nv}.tar.xz";
    hash = "sha256-fhGJI8eiPtw2EU1jJzpG4+BOmvmGlaQiA+esLf6fwdw=";
  };
  nvInstaller = fetchurl {
    url = "https://download.nvidia.com/XFree86/Linux-x86_64/${nv}/NVIDIA-Linux-x86_64-${nv}-no-compat32.run";
    hash = "sha256-4IRFHbcwpt8p09dPZVdJxNI248lF99lLUgXoQxj+L5A=";
  };
in {
  # NVIDIA's firmware, taken unchanged out of the driver: the module asks for
  # it under gpu-unlock/<nv>/. Built for this machine, never redistributed.
  firmware = stdenvNoCC.mkDerivation {
    pname = "gpu-unlock-firmware";
    inherit version src;
    nativeBuildInputs = [ python3 zstd ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      mkdir nv assets
      tar -xf ${nvSource} -C nv
      python3 -I firmware/extract_gsp.py ${nvInstaller} assets
      python3 -I firmware/extract_boot_assets.py nv/NVIDIA-kernel-module-source-${nv} assets
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      install -Dm444 -t $out/lib/firmware/gpu-unlock/${nv} assets/*.bin
      install -Dm444 assets/NVIDIA-LICENSE $out/share/licenses/gpu-unlock-firmware/NVIDIA-LICENSE
      runHook postInstall
    '';
    meta = {
      description = "NVIDIA ${nv} firmware for gpu-unlock";
      license = lib.licenses.unfree;
      platforms = [ "x86_64-linux" ];
    };
  };

  # The module, for that kernel.
  module = stdenv.mkDerivation {
    pname = "gpu-unlock";
    version = "${version}-${kernel.version}";
    inherit src;
    sourceRoot = "source/kernel/gpu_unlock";
    nativeBuildInputs = kernel.moduleBuildDependencies;
    makeFlags = kernelModuleMakeFlags ++ [ "KDIR=${kernel.dev}/lib/modules/${kernel.modDirVersion}/build" ];
    installPhase = ''
      runHook preInstall
      install -Dm444 gpu_unlock.ko $out/lib/modules/${kernel.modDirVersion}/extra/gpu_unlock.ko
      runHook postInstall
    '';
    meta = {
      description = "Full-rate FP16/BF16 tensor math on GeForce RTX 20/30/40 cards";
      license = lib.licenses.gpl2Only;
      platforms = [ "x86_64-linux" ];
    };
  };
}
