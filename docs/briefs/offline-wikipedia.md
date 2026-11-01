# Offline Wikipedia

The owner asked (2026-10-31) for search over a downloaded copy of
Wikipedia. Principle 1 (she runs on the owner's machines, offline where
she can): after the search-rate work, her web search depended on one
engine still answering, and a private or local-only thread's query left
the network. A copy on the server answers without either.

## Decision

A Kiwix ZIM file served by kiwix-serve, asked by lyricad like SearXNG
(`core/src/kiwix.ts`). No new tool (principle 8): `web_search` lists the
copy's hits after the web results, as wikipedia.org links, and carries a
search alone when SearXNG is unset or failing; `web_fetch` reads a
wikipedia.org page, and a page or picture on kiwix-serve, from the copy
before the sandbox goes online. The operator picks the dump: the owner
chose `wikipedia_en_all_nopic` for the test machine, and wants the maxi
one (pictures) where space allows, possibly on another host, which the
Kiwix address covers. A maxi copy's pictures are listed under an article
and come back as images, WebP converted to PNG for local vision models.

Settings: `web.kiwix` in self.db, filled by `kiwix-address` from the
NixOS module's `zimDir` option or install.sh's ZIM folder; the Kiwix
address and its state in Administration → Web search (docs/ux.md).

## Done

- core: `kiwixBooks`, `kiwixSearch`, `kiwixLines`, `kiwixPage`,
  `kiwixStatus`, the address setting and adoption; tests from kiwix-serve
  3.5's replies.
- extension: both tools, the gate, tests in a real Pi session.
- daemon: the admin API and `searchProvider`, the address plumbing to
  hosts and subagents, adoption on unlock.
- web: the second field and state word; e2e covers both.
- nix/module.nix `zimDir`, `lyrica-kiwix.service`, install.sh's section,
  check-host.
- Docs: contracts, DESIGN, ux, web, daemon, workspace, the guides, README.

## Done after merge

- #720 merged (fa86ad8). The test machine served the nopic dump first,
  then the maxi one (2026-08) once it had downloaded, and the owner had
  the nopic file deleted: one copy, with pictures.
- The service skips a `.zim` kiwix can't open (`lyrica-kiwix-start`
  builds a library with `kiwix-manage`), after a half-downloaded dump
  under its final name crash-looped kiwix-serve on the test machine; the
  guide says to download under a `.part` name.

## Next

- A search and a read in a local-only thread on the test machine.

## Open questions

- Whether a Wikipedia hit should carry the copy's month in the Sources
  row (docs/ux.md); it shows the wikipedia.org link today.
