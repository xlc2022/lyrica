# Brief: her own tool prefix on Debian, and an uninstall script

**Status:** built, in review. **Thread:** "Add eBay's MCP server to Lyrica".
Follows [mcp-local.md](mcp-local.md).

## Why

The owner (2026-11-01), on seeing that eBay's MCP server would be
installed with `npm install -g` into `/usr/local` on Debian: a program
installed only for her sandboxes must not pollute the host; installs
should have a prefix of her own, and uninstalling should gracefully
remove everything installed into it. Principles 2 and 5: what she needs
sits apart from the operator's own system, and leaves no trace when
removed. NixOS already had this: the sandbox tools are a store path that
nothing on the host's PATH sees.

What install.sh put on a Debian host before: Claude Code and Codex with
`npm install -g --prefix /usr/local`, headless Chromium in
`/usr/local/lib/lyrica-chromium` linked from `/usr/local/bin`. Those are
only ever run in her sandboxes, yet they sat on the host's own PATH. Host
services (the `lyrica` CLI, `lyrica-caddy`, the updater, the kiwix start
script) stay where they are: they are the host's units, named `lyrica-*`.
apt packages are dpkg's. Her clones' Python uses a venv per project;
nothing is pip-installed system-wide, so no venv is needed elsewhere.

## Build

1. **`/opt/lyrica/tools`** (`TOOLS_PREFIX` in `core/src/workspace/sandbox.ts`):
   root-owned, made by install.sh. On Debian every sandbox mounts it
   read-only (`--ro-bind-try`, so a host without it is fine) and its `bin`
   is first on the sandbox's PATH; `sandboxHas` and the tool listing look
   there too. NixOS is unchanged.
2. **install.sh** installs Chromium (`lib/chromium`, linked as
   `bin/chromium-headless-shell`), Claude Code and Codex
   (`npm install -g --prefix`) into the prefix, and removes the copies an
   earlier install left in `/usr/local` once the prefix has them. Anything
   else for her sandboxes (eBay's server, `pnpm`, `uv`) goes there with
   `npm install -g --prefix /opt/lyrica/tools …` or a binary in its `bin`.
3. **`daemon/deploy/uninstall.sh`**: stops and removes her units, all of
   `/opt/lyrica` (prefix included), the `lyrica-*` files in `/usr/local`,
   `/etc/lyrica`, the caches, the SearXNG container and the old
   `/usr/local` copies; keeps her data, the snapshots, Caddy's
   certificates, her Tailscale node, the ZIM files and the service users
   and lists them, unless `--purge`. Never removes an apt package.
4. **Docs**: workspace (the sandbox's contents, Claude Code, screenshots),
   daemon (install.sh), models (Codex), getting-started (install step 1,
   dependencies, upgrade notes, Uninstall), the eBay guide.

## Out of scope

A prefix for host services; removing apt packages; a NixOS uninstall
beyond "remove the module and rebuild".

## Handoff

Done (2026-11-01): everything under Build, one PR from this thread. The
sandbox test checks the PATH starts with the prefix (bwrap only).
Next: the first `install.sh` run on an existing Debian install moves the
three tools and removes the `/usr/local` copies; worth watching once.
Open: none.
