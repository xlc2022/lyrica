# eBay's own MCP server (github.com/eBay/npm-public-api-mcp, Apache 2.0):
# read-only access to eBay's public APIs (Browse search and item lookup,
# Taxonomy, GraphQL) for a thread with an eBay developer keyset
# (docs/guides/ebay-mcp.md). A stdio server: Lyrica starts
# `ebay-mcp-server` in the thread's sandbox (DESIGN.md, "MCP servers"), so
# it goes in the sandbox's tools (services.lyrica.ebayMcp, nix/module.nix).
# Built from its own lock file, as nix/package.nix builds Lyrica.
{ lib, buildNpmPackage, fetchFromGitHub, importNpmLock, nodejs_24 }:
let
  src = fetchFromGitHub {
    owner = "eBay";
    repo = "npm-public-api-mcp";
    # v1.2.0 (2026-10-27): GraphQL support.
    rev = "4baa7051a5f98c8c8a310d681f4cbec269387157";
    hash = "sha256-fHxevn911JUM7JFf5Oi5bJuA1oF54n2/6MMdtjOwM8s=";
  };
in
(buildNpmPackage.override { nodejs = nodejs_24; }) {
  pname = "ebay-mcp-server";
  version = "1.2.0";
  inherit src;
  npmDeps = importNpmLock { npmRoot = src; };
  npmConfigHook = importNpmLock.npmConfigHook;
  # `npm run build` (tsc) makes dist/, which the package's bin points at.
  meta = {
    description = "eBay's MCP server: read-only access to eBay's public APIs";
    homepage = "https://github.com/eBay/npm-public-api-mcp";
    license = lib.licenses.asl20;
    mainProgram = "ebay-mcp-server";
  };
}
