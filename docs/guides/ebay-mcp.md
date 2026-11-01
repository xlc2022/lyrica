# eBay listings: eBay's own MCP server

[eBay's MCP server](https://github.com/eBay/npm-public-api-mcp)
(`@ebay/npm-public-api-mcp`, Apache 2.0, maintained by eBay) gives a
thread read-only access to eBay's public APIs: searching active listings
and reading an item's details, prices and seller (the Browse API),
categories (Taxonomy) and the GraphQL API. Its tools find the right
endpoint in eBay's API specs, then call it with `GET`; nothing it does
changes anything on eBay, and it has no completed-sales data, only what
is listed now.

It is a local server: Lyrica starts the program in the thread's sandbox
for each session, with the thread's folders and network, and stops it
with the session (DESIGN.md, "MCP servers"). It keeps no state between
starts and writes no log unless told to, so nothing about a session is
left behind.

## What you need

A free [eBay developer account](https://developer.ebay.com/) with an
application and its **production** keyset, which gives a Client ID (App
ID) and Client Secret (Cert ID). The sandbox keyset works too but sees
almost no real listings. On the keyset, enable OAuth and complete the
Marketplace Account Deletion notification step (or claim the exemption
under Alerts and Notifications): a fresh keyset that skips it fails every
token request with 401. eBay's documentation says production use of the
Buy APIs needs approval; a plain keyset answers Browse searches and item
lookups at about 5,000 calls a day, and a 403 means the approval is
needed.

The server needs no sign-in of your own eBay account: the keyset is all
it uses for browsing. (Its user-token mode, for private data such as
orders, takes a refresh token in `EBAY_REFRESH_TOKEN`; Lyrica passes it
on like any other variable.)

## Install it where her sandboxes see it

On NixOS:

```nix
services.lyrica.ebayMcp = true;
```

Then `nixos-rebuild switch`. The module builds the package from its npm
lock file (`nix/ebay-mcp.nix`) and adds it to her sandbox tools, where
`ebay-mcp-server` is on the path.

On Debian or Ubuntu, install it system-wide, under `/usr` or
`/usr/local`, which her sandboxes mount:

```sh
sudo npm install -g @ebay/npm-public-api-mcp
```

It needs Node 22 or later, which install.sh already installs.

## Add it to Lyrica

Under Settings → **MCP servers**, **Add server**:

- Name: `ebay` (or any name).
- Command: `ebay-mcp-server`.
- Environment:

  ```
  EBAY_CLIENT_ID=<your App ID>
  EBAY_CLIENT_SECRET=<your Cert ID>
  ```

- Pool: **General** for the threads most people shop in. The server sends
  each search to eBay, a cloud service, so it belongs in the pool of the
  threads that use it, not in Private because it runs on this machine
  (DESIGN.md, "MCP servers", pools).

Lyrica starts it once to check it and saves it only when it answers.
Then grant it to the threads or projects that should have it: the MCP
servers row in the thread drawer, or under Workspace on Project
settings. Its searches go out through the thread's own network, so the
thread needs **Internet** on.

The environment is never shown again; **Replace environment** behind ⋯
sets a new keyset. The variables eBay's README lists work the same way:
`EBAY_API_ENV` (`production`, the default), `EBAY_REQUIRED_SCOPES`,
`EBAY_REFRESH_TOKEN`.

## What to expect

- Its four tools (`query_ebay_api`, `call_ebay_api`,
  `query_ebay_graphql`, `call_ebay_graphql`) don't mark themselves
  read-only, so each asks once per thread (**Allow in this thread**) and
  none run in Plan mode. An upstream change adding the hint would remove
  the question.
- While it runs it holds one of the thread's four background-command
  slots: `jobs` lists it as the MCP server `ebay`, and `stop` ends it
  until the next turn.
- A search or item lookup is one `call_ebay_api` call after a
  `query_ebay_api` that finds the endpoint; the result reaches her cut
  to 16 KB, so she asks for a few fields or a few items at a time.
