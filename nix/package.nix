# lyricad, the lyrica CLI and the built web UI, from package-lock.json.
# See docs/daemon.md, "On NixOS".
{ lib, callPackage, buildNpmPackage, importNpmLock, nodejs_24, python3, makeWrapper, src, rev ? "dirty" }:

buildNpmPackage {
  pname = "lyrica";
  version = (lib.importJSON (src + "/package.json")).version;
  inherit src;
  nodejs = nodejs_24;

  # Each package fetched by the integrity hash in package-lock.json, so a
  # lockfile change needs no hash here.
  npmDeps = importNpmLock { npmRoot = src; };
  npmConfigHook = importNpmLock.npmConfigHook;

  # The SQLite binding loads the linux-x64.node its package ships, so nothing
  # asks npm to build it from source. python3 is for node-gyp, which builds
  # ssh2's optional cpu-features; the first entry stops npm's warnings about
  # nixpkgs' nodedir (nix/npm-nodedir.nix).
  nativeBuildInputs = [ (callPackage ./npm-nodedir.nix { nodejs = nodejs_24; }) python3 makeWrapper ];
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

  # The web UI; lyricad serves web/dist.
  npmBuildScript = "build";

  postConfigure = ''
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 12)) { console.error("lyricad needs Node.js 22.12 or later"); process.exit(1); }'
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/lyrica $out/bin
    cp -r package.json bin core daemon extension host persona web/dist node_modules $out/lib/lyrica/
    mkdir -p $out/lib/lyrica/web && mv $out/lib/lyrica/dist $out/lib/lyrica/web/dist
    cp web/package.json $out/lib/lyrica/web/
    makeWrapper ${nodejs_24}/bin/node $out/bin/lyrica --add-flags $out/lib/lyrica/bin/lyrica
    runHook postInstall
  '';

  # The SSH helper runs on this Node; the module adds it to the sandbox closure.
  # The commit goes to lyricad as LYRICA_BUILD (the module), not into the
  # build, so a new commit that leaves src alone rebuilds nothing. It is the
  # whole commit: lyrica-nixos-start records it as the running release, and a
  # model host's updater takes only a whole commit it can check is on main.
  passthru = { nodejs = nodejs_24; build = rev; };

  meta = {
    description = "Lyrica, a personal AI companion (lyricad and the lyrica CLI)";
    mainProgram = "lyrica";
    platforms = [ "x86_64-linux" ];
  };
}
