# The SearXNG services.lyrica.searxng runs: the commit install.sh's
# SEARXNG_IMAGE is built from, so NixOS and Debian ask the search engines
# alike. A NixOS release's own SearXNG is frozen at its branch-off, and
# engines that change how they spot bots refuse an old one (docs/guides/searxng.md).
# Move both pins together. Adapted from nixpkgs' pkgs/by-name/se/searxng.
{ lib, python3, fetchFromGitHub }:

python3.pkgs.buildPythonPackage rec {
  pname = "searxng";
  # As SEARXNG_IMAGE's tag in daemon/deploy/install.sh.
  version = "2026.10.28";
  rev = "c360868e5b7c01e463a362a53518190d5a3b1097";
  pyproject = true;

  src = fetchFromGitHub {
    owner = "searxng";
    repo = "searxng";
    inherit rev;
    hash = "sha256-M4AFqj57yUMJp7bntDdBi+o6kTssX9doCMNzVTV9yG0=";
  };

  # requirements.txt pins exact versions; take the release's own.
  postPatch = ''
    sed -i 's/==.*//' requirements.txt
  '';

  preBuild = ''
    cat > searx/version_frozen.py <<EOF
    VERSION_STRING="${version}+${builtins.substring 0 9 rev}"
    VERSION_TAG="${version}+${builtins.substring 0 9 rev}"
    DOCKER_TAG="${version}-${builtins.substring 0 9 rev}"
    GIT_URL="https://github.com/searxng/searxng"
    GIT_BRANCH="master"
    EOF
  '';

  build-system = [ python3.pkgs.setuptools ];

  dependencies = with python3.pkgs; [
    babel
    certifi
    curl-cffi
    flask
    flask-babel
    isodate
    jinja2
    lxml
    markdown-it-py
    msgspec
    pygments
    python-dateutil
    pyyaml
    typer
    typing-extensions
    valkey
    whitenoise
  ];

  # Its tests reach the network.
  doCheck = false;

  postInstall = ''
    mkdir -p $out/share
    ln -s ../${python3.sitePackages}/searx/static $out/share/
    cp searx/limiter.toml $out/${python3.sitePackages}/searx/limiter.toml
  '';

  meta = {
    homepage = "https://github.com/searxng/searxng";
    description = "SearXNG, the metasearch engine behind Lyrica's web search";
    license = lib.licenses.agpl3Plus;
    mainProgram = "searxng-run";
  };
}
