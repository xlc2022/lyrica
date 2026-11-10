# An npm for the build only, ahead of the real one on PATH. nixpkgs'
# npmConfigHook exports npm_config_nodedir (the Node headers node-gyp builds
# against), and npm 11 warns on every call that "nodedir" is an unknown
# config, since it was never npm's own setting. This hands the same value to
# node-gyp under the name npm leaves alone, npm_package_config_node_gyp_nodedir
# (node-gyp 11 and later), so native modules still build offline and the
# warnings stop. Nothing at runtime uses it.
{ writeShellScriptBin, nodejs }:

writeShellScriptBin "npm" ''
  if [ -n "''${npm_config_nodedir-}" ]; then
    export npm_package_config_node_gyp_nodedir="$npm_config_nodedir"
    unset npm_config_nodedir
  fi
  exec ${nodejs}/bin/npm "$@"
''
