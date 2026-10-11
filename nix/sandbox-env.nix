# One directory of the sandbox's tools; it becomes the sandbox's /usr.
{ buildEnv, packages }:
buildEnv {
  name = "lyrica-sandbox-tools";
  paths = packages;
  pathsToLink = [ "/bin" "/share" "/lib" ];
  ignoreCollisions = true;
}
