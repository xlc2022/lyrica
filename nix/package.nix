# lyricad, the lyrica CLI and the built web UI, from package-lock.json.
# See docs/nixos.md.
{ lib, buildNpmPackage, nodejs_22, python3, makeWrapper, src, rev ? "dirty" }:

buildNpmPackage {
  pname = "lyrica";
  version = "0-${builtins.substring 0 12 rev}";
  inherit src;
  nodejs = nodejs_22;

  # Update with: nix run nixpkgs#prefetch-npm-deps package-lock.json
  npmDepsHash = "sha256-dk0MRvHlu6MUy7lR5pVvJ8F1QmbW2P+9Sxdv02CoM48=";

  # better-sqlite3-multiple-ciphers builds from source: no prebuilt download in the Nix sandbox.
  nativeBuildInputs = [ python3 makeWrapper ];
  env = {
    npm_config_build_from_source = "true";
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  };

  # The web UI; lyricad serves web/dist.
  npmBuildScript = "build";

  postConfigure = ''
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 6)) { console.error("lyricad needs Node.js 22.6 or later"); process.exit(1); }'
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/lyrica $out/bin
    cp -r package.json bin core daemon extension host persona web/dist node_modules $out/lib/lyrica/
    mkdir -p $out/lib/lyrica/web && mv $out/lib/lyrica/dist $out/lib/lyrica/web/dist
    cp web/package.json $out/lib/lyrica/web/
    echo ${rev} > $out/lib/lyrica/REVISION
    makeWrapper ${nodejs_22}/bin/node $out/bin/lyrica --add-flags $out/lib/lyrica/bin/lyrica
    runHook postInstall
  '';

  meta = {
    description = "Lyrica, a personal AI companion (lyricad and the lyrica CLI)";
    mainProgram = "lyrica";
    platforms = [ "x86_64-linux" ];
  };
}
