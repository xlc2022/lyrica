# The tools her sandboxes have by default on NixOS, mounted as their /usr
# (LYRICA_SANDBOX_TOOLS, core/src/workspace/sandbox.ts). bubblewrap, passt,
# nftables, bash, coreutils and util-linux must stay: lyricad and its
# self-test use them.
pkgs: with pkgs; [
  bashInteractive coreutils findutils gnugrep gnused gawk diffutils patch
  gnutar gzip xz bzip2 zstd unzip which file less procps util-linux
  git openssh curl cacert jq ripgrep python3
  bubblewrap passt nftables
]
