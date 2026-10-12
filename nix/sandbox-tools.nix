# The tools her sandboxes have by default on NixOS, mounted as their /usr
# (LYRICA_SANDBOX_TOOLS, core/src/workspace/sandbox.ts). bubblewrap, passt,
# nftables, bash, coreutils and util-linux must stay: lyricad and its
# self-test use them. imagemagick makes the Files panel's thumbnails; git,
# gh and nodejs_22 are for her own code (docs/workspace.md, "Her own code").
pkgs: with pkgs; [
  bashInteractive coreutils findutils gnugrep gnused gawk diffutils patch
  gnutar gzip xz bzip2 zstd unzip which file less procps util-linux
  getent git gh nodejs_22 openssh curl cacert jq ripgrep python3 imagemagick
  bubblewrap passt nftables
]
