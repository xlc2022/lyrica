# The store paths her sandboxes may see on NixOS: the tools' closure, Node's
# (the SSH helper runs on it) and the CA bundle /etc/ssl points into. Its
# store-paths file is LYRICA_SANDBOX_CLOSURE (core/src/workspace/sandbox.ts).
{ closureInfo, rootPaths }:
closureInfo { inherit rootPaths; }
