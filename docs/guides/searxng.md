# SearXNG: a search engine for her web search

SearXNG is a metasearch engine you host yourself: it sends a query to
search engines such as DuckDuckGo, Brave and Wikipedia and merges what they
return. Her `web_search` tool asks one SearXNG for the whole server, so the
engines see your SearXNG asking, never who in Lyrica asked; they still see
the query text.

Lyrica never installs or runs it. You host it, then give her its address.
SearXNG's own documentation (docs.searxng.org) is the reference.

## Where to run it

Anywhere Lyrica's server can reach over HTTP(S): a container on the same
Proxmox, a machine on your LAN or tailnet, or a small VPS. Every thread
uses it, private ones included, so pick a place you trust.

### Docker (a VPS or a Proxmox LXC)

In an LXC container, turn on the **nesting** feature first (Options →
Features), as Docker needs it.

`compose.yaml`:

```yaml
services:
  searxng:
    image: docker.io/searxng/searxng:latest   # pin a tag once it works
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"     # the container listens on 8080; only the local proxy reaches it
    volumes:
      - ./config:/etc/searxng     # settings.yml (and limiter.toml) live here
      - ./data:/var/cache/searxng
```

Put `settings.yml` (below) in `./config/`, then `docker compose up -d`.
SearXNG's own compose file also runs Valkey, which only the limiter needs;
a private instance can leave it out.

### NixOS

```nix
services.searx = {
  enable = true;                              # package defaults to pkgs.searxng
  domain = "search.example.org";
  environmentFile = "/run/secrets/searxng";   # holds SEARX_SECRET_KEY=…
  settings = {
    use_default_settings = true;
    server = { bind_address = "127.0.0.1"; port = 8080; secret_key = "$SEARX_SECRET_KEY"; limiter = false; image_proxy = false; };
    search = { formats = [ "html" "json" ]; safe_search = 0; default_lang = "auto"; };
  };
};
```

`services.searx.settings` is the same tree as `settings.yml` below, and
`$NAME` in it is filled from `environmentFile`, which keeps the key out of
the Nix store. `services.searx.limiterSettings` is `limiter.toml`, and
`redisCreateLocally = true` adds the Valkey the limiter needs.

## Configure it

A complete minimal `settings.yml`:

```yaml
use_default_settings: true      # start from SearXNG's defaults; list only changes

server:
  secret_key: "change-me"       # any long random string: openssl rand -hex 32
  limiter: false                # see "The limiter" below
  image_proxy: false            # she reads results as text; no images to proxy

search:
  formats: [html, json]         # json is what Lyrica asks for; the default is html only, which answers her with 403
  safe_search: 0                # 0 off, 1 moderate, 2 strict
  default_lang: "auto"          # or "en", "de", …

outgoing:
  request_timeout: 3.0          # seconds each engine gets (the default)
  max_request_timeout: 8.0      # the most any request may wait

ui:                             # optional: only for using it in a browser
  default_theme: simple
```

### Engines

With `use_default_settings: true`, the default engines load, and an entry
under `engines:` changes the default engine of that name. DuckDuckGo,
Brave, Wikipedia, GitHub and Stack Overflow are on by default; Google and
Qwant are off. To turn one off, or on:

```yaml
engines:
  - name: bing
    disabled: true
  - name: google
    disabled: false
```

An engine that keeps timing out or answering with a CAPTCHA only slows
every search; turn it off. To load only a short list instead:

```yaml
use_default_settings:
  engines:
    keep_only: [duckduckgo, brave, wikipedia, github, stackoverflow]
```

### The limiter

The limiter and its bot detection protect a public instance from scrapers,
and need a Valkey database (`valkey: url:` in `settings.yml`). It is off by
default. A private instance that only Lyrica and you can reach doesn't
need it: keep `server.limiter: false`. If you turn it on, Lyrica's
searches can be refused with 429 (she says so), so let her address
through in `limiter.toml`, which SearXNG reads from the same folder
(`/etc/searxng/` in the container):

```toml
[botdetection.ip_lists]
pass_ip = ["100.64.0.0/10", "192.168.1.0/24"]   # her tailnet or LAN address
```

### Applying changes

SearXNG reads its settings at start: `docker compose restart searxng`, or
on NixOS `nixos-rebuild switch` (which restarts `searx.service`).

### Testing it

```sh
curl 'https://search.example.org/search?q=test&format=json' | head -c 400
```

JSON with a `results` list means it works. A 403 means `json` is missing
from `search.formats`; a 429 means the limiter refused you.

## HTTPS and who can reach it

- **HTTPS:** put it behind Caddy (`search.example.org { reverse_proxy
  127.0.0.1:8080 }`) or your VPS's proxy. On your LAN or tailnet, plain
  `http://` to a private address works too.
- **Who can reach it:** a firewall that lets in only your own addresses
  (or only the tailnet) is the simplest. On a VPS without that, add basic
  auth in the proxy (Caddy's `basic_auth` with a hash from `caddy
  hash-password`) and give Lyrica the address with the user and password
  in it: `https://lyrica:password@search.example.org`. She sends them as
  basic auth, and Administration never shows the password again.

## Giving Lyrica the address

In **Administration → Web search**, enter the **SearXNG address** (the base
URL, without `/search`) and **Save**. The status beneath says **Reachable**
once a test search returns JSON, or **Unreachable**, with what failed as its
tooltip. From then on, every thread with the Web search switch on has
`web_search`.
