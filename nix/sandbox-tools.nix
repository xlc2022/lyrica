# The tools her sandboxes have by default on NixOS, mounted as their /usr
# (LYRICA_SANDBOX_TOOLS, core/src/workspace/sandbox.ts). bubblewrap, passt,
# nftables, bash, coreutils and util-linux must stay: lyricad and its
# self-test use them. imagemagick makes the Files panel's thumbnails; git,
# gh and tea are for threads with repositories (docs/workspace.md, "Git
# accounts and repositories"), nodejs_22 for her own code, and claude-code
# for threads with Claude Code on (docs/workspace.md, "Claude Code").
# chromium and the fonts render HTML/SVG diagrams offline (principle 1),
# and take screenshots of her web UI (web/e2e/shot.ts).
pkgs:
let
  # Claude Code is unfree. Only it is allowed, in its own import, so the
  # machine's own nixpkgs settings stay as they are.
  unfree = import pkgs.path {
    inherit (pkgs.stdenv.hostPlatform) system;
    config.allowUnfreePredicate = p: pkgs.lib.getName p == "claude-code";
  };
in
with pkgs; [
  bashInteractive coreutils findutils gnugrep gnused gawk diffutils patch
  gnutar gzip xz bzip2 zstd unzip which file less procps util-linux
  getent git gh tea nodejs_22 openssh curl cacert jq ripgrep python3 imagemagick
  chromium ibm-plex dejavu_fonts
  bubblewrap passt nftables
  unfree.claude-code
]
