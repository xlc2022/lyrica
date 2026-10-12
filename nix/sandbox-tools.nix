# The tools her sandboxes have by default on NixOS, mounted as their /usr
# (LYRICA_SANDBOX_TOOLS, core/src/workspace/sandbox.ts). bubblewrap, passt,
# nftables, bash, coreutils and util-linux must stay: lyricad and its
# self-test use them. imagemagick makes the Files panel's thumbnails; git,
# gh and tea are for threads with repositories (docs/workspace.md, "Git
# accounts and repositories"), and nodejs_22 for her own code. chromium and
# the fonts are for screenshots of her web UI (web/e2e/shot.ts).
pkgs: with pkgs; [
  bashInteractive coreutils findutils gnugrep gnused gawk diffutils patch
  gnutar gzip xz bzip2 zstd unzip which file less procps util-linux
  getent git gh tea nodejs_22 openssh curl cacert jq ripgrep python3 imagemagick
  chromium ibm-plex dejavu_fonts
  bubblewrap passt nftables
]
