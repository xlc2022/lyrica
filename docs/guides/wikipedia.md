# Offline Wikipedia: a copy she searches and reads without the internet

Kiwix packages Wikipedia as one ZIM file with a full-text index, and
`kiwix-serve` serves it over HTTP. Lyrica asks one kiwix-serve for the
whole server, from `lyricad`, the way she asks SearXNG: a plain
`web_search` lists its articles after the web results (and works with it
alone), and `web_fetch` reads any wikipedia.org page from the copy before
going online, with its pictures when the copy has them. With kiwix-serve
on her machine, as both installs set it up, nothing of that leaves it, so
it works with the internet off, in a local-only thread, and while every
search engine is resting. A kiwix-serve elsewhere sees the query and the
article's title, as a SearXNG does.

## Choose a dump

The files are at https://download.kiwix.org/zim/wikipedia/, one per
language and flavour, dated. For English:

| File | Holds | Size, roughly |
|---|---|---|
| `wikipedia_en_all_maxi_<date>.zim` | every article with its pictures | 110 GB |
| `wikipedia_en_all_nopic_<date>.zim` | every article, no pictures | 55 GB |
| `wikipedia_en_all_mini_<date>.zim` | each article's introduction | 14 GB |
| `wikipedia_en_simple_all_maxi_<date>.zim` | Simple English, with pictures | 0.3 GB |

Any other Kiwix ZIM (Wiktionary, Wikibooks, another language's Wikipedia)
goes in the same folder and is searched too; only a Wikipedia's hits show
as wikipedia.org links, the rest as pages on kiwix-serve. Each file takes
its own request per search, so keep the folder to what she needs.

Download with something resumable (`wget -c` or `curl -C -`), and check
the `.sha256` beside the file when there is one. A new dump replaces the
old file in the folder; restart the service afterwards.

## Set up by the NixOS module

Put the file in a folder root can read, say `/srv/lyrica/zim`, and set

```nix
services.lyrica.zimDir = "/srv/lyrica/zim";
```

The module runs `lyrica-kiwix.service`: kiwix-serve from `kiwix-tools` on
`127.0.0.1:8889`, as a dynamic user, serving every `.zim` in the folder
at start, without its search bar. It leaves `http://127.0.0.1:8889` in
`/var/lib/lyrica/kiwix-address`; when lyricad unlocks with no Kiwix address
set, it stores that one in **Administration → Web search**, once. If you
clear or change the address there later, it stays as you left it.
`nix/check-host.sh` checks that kiwix-serve answers its catalog. Setting
`zimDir` back to null removes the service and the address file, not the
address lyricad already stored.

## Set up by install.sh

Put the file in `/var/lib/lyrica-kiwix` (or set `LYRICA_ZIM_DIR` to its
folder when you run the script), then run `install.sh` again. With a
`.zim` there it installs Debian's `kiwix-tools`, writes
`/etc/lyrica/kiwix.env` (the folder and the port), installs and starts
`lyrica-kiwix.service` (kiwix-serve on `127.0.0.1:8889` only, as a dynamic
user), waits for its catalog, and leaves `http://127.0.0.1:8889` in
`/var/lib/lyrica/kiwix-address`, which fills in under Administration as
above. When the folder has no `.zim` any more, the next run removes the
unit and the address file. After swapping in a new dump:
`systemctl restart lyrica-kiwix`.

## Host it elsewhere

kiwix-serve runs anywhere (the `kiwix-tools` package, or the
`ghcr.io/kiwix/kiwix-serve` image). Serve the folder on an address her
server reaches, over the LAN or the tailnet, and type it as the **Kiwix
address** in **Administration → Web search**. The state word says
**Reachable** once its catalog answers, and its tooltip names the books.
Pictures then travel over that link, so keep it local.

## What she sees

A search answers, after the web results:

```
Offline copy of Wikipedia 2026-06:
- Lute
  https://en.wikipedia.org/wiki/Lute
  A lute is any plucked string instrument with a neck and a deep round back …
```

Reading a wikipedia.org link gives the article as Markdown, headed by its
title and link, and from a copy with pictures a list of them under it,
each an address on kiwix-serve; reading one of those gives her the
picture itself (WebP converted to PNG through ImageMagick, which both
installs have). A page the copy lacks, or any other site, is fetched from
the thread's sandbox as before.
