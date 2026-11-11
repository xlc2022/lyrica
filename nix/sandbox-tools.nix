# The tools her sandboxes have by default on NixOS, mounted as their /usr
# (LYRICA_SANDBOX_TOOLS, core/src/workspace/sandbox.ts). bubblewrap, passt,
# nftables, bash, coreutils and util-linux must stay: lyricad and its
# self-test use them. imagemagick makes the Files panel's thumbnails; ffmpeg (with
# ffprobe) lets her check and cut her own clips; git,
# gh and tea are for threads with repositories (docs/workspace.md, "Git
# accounts and repositories"), nodejs_24 and openssl for her own code
# and its tests, claude-code
# for threads with Claude Code on (docs/workspace.md, "Claude Code"), and
# codex for ChatGPT Images, in a sandbox of its own (docs/models.md).
# chromium and the fonts render HTML/SVG diagrams offline (principle 1),
# and take screenshots of her web UI (web/e2e/shot.ts). gnumake and gcc,
# with python3, build native npm modules (node-gyp) when no prebuilt binary
# fits, as Debian's build-essential does there. python3 comes with a baseline
# for scraping and data work (beautifulsoup4, lxml, requests, html5lib,
# PyYAML), the same as install.sh's python3-* packages; her prompt names the
# ones present (sandboxTools in core/src/workspace/sandbox.ts). shellcheck
# is on lyricad's PATH from here, to check her bash calls before they run
# (core/src/workspace/shellcheck.ts). nix is for flakes and `nix develop`
# in her pool's own Nix store at /nix (docs/workspace.md, "Nix"); without it
# the sandbox has no /nix. xxd (tinyxxd), bc, zip, tree, fd, sqlite, yq (the
# jq wrapper, with xq and tomlq), poppler-utils (pdftotext), rsync, wget, lsof,
# strace and pandoc match install.sh's everyday tools; util-linux brings
# hexdump and column.
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
  gnutar gzip xz bzip2 zstd unzip which file less procps util-linux xxd bc
  zip tree fd sqlite yq poppler-utils rsync wget lsof strace pandoc
  getent git gh tea nodejs_24 openssh openssl curl cacert jq ripgrep gnumake gcc imagemagick shellcheck
  (python3.withPackages (ps: with ps; [ beautifulsoup4 lxml requests html5lib pyyaml ]))
  ffmpeg-headless
  chromium ibm-plex dejavu_fonts
  bubblewrap passt nftables nix
  unfree.claude-code codex
]
