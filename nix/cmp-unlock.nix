# cmp100-unlock (https://github.com/mintoriakamoto/CMP100-210xFULLTENSORSxGEN3x1,
# GPL-2.0-only): full-rate tensor cores and PCIe Gen3 on an NVIDIA CMP 100-210,
# applied at every boot and lost at power-off. services.lyrica-host.cmpUnlock
# turns it on (nix/host-module.nix); host/cmp-unlock.sh installs the same commit
# on Debian. callPackage it from the kernel's package set (boot.kernelPackages).
#
# Upstream's install.sh builds the hook and derives its payloads on the machine;
# here both are built, and the payloads checked against upstream's hashes, by
# Nix. Its script copies payloads over the active firmware during a run, which
# NixOS keeps read-only in the store, so FW_DIR points at a copy in /run that
# the module's unit makes and points the kernel at for the run.
{ lib, stdenv, fetchFromGitHub, makeWrapper, python3, linux-firmware, kernel, kernelModuleMakeFlags
, bash, busybox, coreutils, findutils, gawk, gnugrep, gnused, kmod, pciutils, procps, psmisc, systemd, util-linux }:

let
  version = "1.1.1";
  src = fetchFromGitHub {
    owner = "mintoriakamoto";
    repo = "CMP100-210xFULLTENSORSxGEN3x1";
    rev = "8abaad2fe2903c8ea10fe88c04c2acc8778aebf2";
    hash = "sha256-YwL5OWoo8M2tJU8QlNTUAF8BAklWMoq1D2sV2G/bxeg=";
  };
  gv100 = "${linux-firmware}/lib/firmware/nvidia/gv100";
in stdenv.mkDerivation {
  pname = "cmp100-unlock";
  version = "${version}-${kernel.version}";
  inherit src;
  nativeBuildInputs = kernel.moduleBuildDependencies ++ [ makeWrapper python3 ];
  # The manifest pins the hook's hash, which stripping would change.
  dontStrip = true;
  makeFlags = kernelModuleMakeFlags ++ [ "KDIR=${kernel.dev}/lib/modules/${kernel.modDirVersion}/build" ];
  buildPhase = ''
    runHook preBuild
    make -C src $makeFlags
    mkdir stock payloads
    cp -L ${gv100}/gr/fecs_sig.bin ${gv100}/acr/bl.bin ${gv100}/acr/ucode_load.bin stock/
    # Fails unless the stock firmware is the version upstream tested.
    python3 -I tools/build_payloads.py --fecs stock/fecs_sig.bin --bl stock/bl.bin \
      --ucode stock/ucode_load.bin --output payloads
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    lib=$out/lib/cmp100-unlock
    install -Dm444 -t $lib/stock stock/*.bin
    install -Dm444 -t $lib/payloads payloads/*.bin
    install -Dm444 src/gv100_nouveau_acr_hook.ko $lib/gv100_nouveau_acr_hook.ko
    sha() { sha256sum "$1" | cut -d' ' -f1; }
    cat > $lib/manifest.env <<EOF
    STOCK_FECS_SHA=$(sha $lib/stock/fecs_sig.bin)
    STOCK_BL_SHA=$(sha $lib/stock/bl.bin)
    STOCK_UCODE_SHA=$(sha $lib/stock/ucode_load.bin)
    CUSTOM_FECS_SHA=$(sha $lib/payloads/fecs_sig.candidate-c-504.bin)
    CUSTOM_BL_SHA=$(sha $lib/payloads/bl.load-candidate-c.bin)
    CUSTOM_UCODE_SHA=$(sha $lib/payloads/ucode_load.tensor-success-lsb-restore.bin)
    PCIE_POLICY_UCODE_SHA=$(sha $lib/payloads/ucode_load.pcie-policy-88610-1.bin)
    PCIE_VECTOR_UCODE_SHA=$(sha $lib/payloads/ucode_load.pcie-vector-8872c-6.bin)
    HOOK_SHA=$(sha $lib/gv100_nouveau_acr_hook.ko)
    HOOK_KVER=${kernel.modDirVersion}
    EOF
    install -Dm555 sbin/cmp100-unlock $out/bin/cmp100-unlock
    substituteInPlace $out/bin/cmp100-unlock \
      --replace-fail 'LIB_DIR=''${CMP100_LIB_DIR:-/usr/lib/cmp100-unlock}' "LIB_DIR=$lib" \
      --replace-fail 'MANIFEST=$STATE_DIR/manifest.env' 'MANIFEST=$LIB_DIR/manifest.env' \
      --replace-fail 'STOCK_FECS=$STATE_DIR/stock/' 'STOCK_FECS=$LIB_DIR/stock/' \
      --replace-fail 'STOCK_BL=$STATE_DIR/stock/' 'STOCK_BL=$LIB_DIR/stock/' \
      --replace-fail 'STOCK_UCODE=$STATE_DIR/stock/' 'STOCK_UCODE=$LIB_DIR/stock/' \
      --replace-fail 'FW_DIR=/lib/firmware/nvidia/gv100' 'FW_DIR=/run/cmp100-unlock/firmware/nvidia/gv100'
    patchShebangs $out/bin
    # nvidia-smi comes from the driver: the unit's path, or the system's.
    wrapProgram $out/bin/cmp100-unlock --prefix PATH : ${lib.makeBinPath [
      bash busybox coreutils findutils gawk gnugrep gnused kmod pciutils procps psmisc systemd util-linux
    ]}
    # The tensor-core check; libcuda comes from the driver, as for any CUDA program.
    install -Dm555 tools/cmp100-bench $out/bin/cmp100-bench
    patchShebangs $out/bin/cmp100-bench
    wrapProgram $out/bin/cmp100-bench --prefix LD_LIBRARY_PATH : /run/opengl-driver/lib
    runHook postInstall
  '';
  meta = {
    description = "Full-rate tensor cores and PCIe Gen3 on an NVIDIA CMP 100-210, at every boot";
    license = lib.licenses.gpl2Only;
    platforms = [ "x86_64-linux" ];
  };
}
