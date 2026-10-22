#!/usr/bin/env bash
# seed-claude-code.sh DIR: put Claude Code's download in the Nix store before
# the build asks for it. It is unfree, so cache.nixos.org has no copy, and
# downloads.claude.ai answers 429 when every CI run fetches it. DIR is kept
# between runs (actions/cache), so the file is downloaded once per version.
set -euo pipefail
dir=$1
nix() { command nix --extra-experimental-features "nix-command flakes" "$@"; }
src=$(nix eval --impure --json --expr '
  let f = builtins.getFlake (toString ./.);
      p = (import f.inputs.nixpkgs { system = "x86_64-linux"; config.allowUnfree = true; }).claude-code;
  in { url = p.src.url; mode = p.src.outputHashMode; path = p.src.outPath; }')
field() { printf '%s' "$src" | jq -r ".$1"; }
path=$(field path) url=$(field url) mode=$(field mode)
if nix path-info "$path" >/dev/null 2>&1; then echo "already in the store: $path"; exit 0; fi
if [ "$mode" != flat ]; then echo "::warning::Claude Code's source is no longer a flat download; not seeding it"; exit 0; fi
# Kept by its store path's name: the path is computed from the file's hash, so
# --add-fixed giving that same path proves the content.
file="$dir/${path##*/}"
if [ ! -f "$file" ]; then
  mkdir -p "$dir"
  curl -fsSL --retry 6 --retry-delay 20 --retry-all-errors -o "$file" "$url"
fi
added=$(nix-store --add-fixed sha256 "$file")
if [ "$added" != "$path" ]; then rm -f "$file"; echo "::error::seeded $added, expected $path"; exit 1; fi
# Only the current version is kept, so the cache doesn't grow with each flake.lock.
find "$dir" -mindepth 1 -maxdepth 1 ! -name "${path##*/}" -exec rm -rf {} +
echo "seeded $path"
