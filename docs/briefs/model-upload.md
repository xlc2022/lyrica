# Brief: Upload a model file from the browser

**Status:** Merged as #799 (3f28f96).

**Thread:** Add model upload from the browser.

**Read first:** host/API.md "Downloads", docs/ux.md §6 "Downloads and hub
accounts" and "Image models, recipes and parts", docs/briefs/web-2.md
(the Download pages).

## Goal

The user has a model file on their own computer (a GGUF they quantized, a
LoRA they trained, a safetensors file from a site Lyrica can't reach) and
wants it on a model host without copying it there by hand. Both **Download
text model** and **Download image model** gain an **Upload** source: pick
files in the browser, they go to the host chosen in **Download to**, show in
the Downloads queue like any download, and appear as models or parts once
there. This serves principle 3 (the user's own machines do the work, with
the user's own files) and keeps the host's one writer and its checks
(principle 6): the upload lands through the host's `fetch` service, the
only part that writes `lyrica/`, with the same file-type and format checks
as a download.

## Design

- **Where:** a fourth (text) or last (image) segment, **Upload**, after
  Link (text) or Scan folder (image). Same **Download to** select.
- **Upload segment:** a **Files** picker (several at once; `.gguf`,
  `.safetensors`), then the picked files as rows with their sizes,
  "<GB> in all" for more than one, and a pill "not enough space" when the
  total plus the host's 1 GB margin is over its free space. Primary
  **Upload**, Cancel secondary. A name already on the host is refused by
  the host in words when Upload is pressed. On Upload the page goes to
  Downloads, like every other source.
- **Progress:** each file is a row in the Downloads queue, "from your
  computer to <host>", phase **Uploading** with the bar, sizes and speed,
  and Cancel. The browser tab drives the upload, so the app warns before
  the tab closes while one runs. A row whose upload no tab is sending now
  says **Paused** (its tooltip: pick the same file under Upload to carry
  on); picking a file with the same name and size for the same host
  carries on from what arrived. Finished: **Uploaded**, its size and Ready.
- **Large files:** sent in 32 MiB pieces, each its own request, so no
  request is huge, a dropped connection costs one piece, and the browser
  retries a piece five times in a row before it stops. lyricad holds one
  piece in memory per request and passes it to the host; the host passes
  it to `fetch`, which appends it to the partial file. When the last piece
  arrives, `fetch` checks the file is what its name says, hashes it, and
  records it as `source: "upload"`, unverified (no checksum to check
  against). A file that fails the format check is deleted.
- **Where it lands:** `lyrica/upload/<file name>` in the models folder,
  so it can be deleted from the app like any download.

## In scope

- host: `POST /host/v1/uploads`, `PUT /host/v1/uploads/<id>?offset=`,
  state `uploading`, source `upload`; fetch's `/uploads` routes.
- lyricad: the two routes, through the management API (a shared host
  needs an administrator, as for downloads).
- web: the Upload segment on both pages, the uploader (web/src/uploads.ts),
  the Downloads row words.
- Docs: host/API.md, docs/contracts.md, docs/ux.md, host/README.md where it
  lists what writes the models folder, the operator guide if it lists ways
  to get a model on a host.

## Out of scope

- Folders (a whole safetensors repository with its config.json): pick its
  files, or use Hugging Face.
- Checksums typed by the user; resuming after the browser forgets the file
  without the user picking it again.
- Uploading straight from the browser to the host (the host is reached only
  through lyricad's pinned TLS).

## Handoff notes

**Done (2026-11-07):** merged as #799. Host fetch `startUpload` and
`receivePiece` (restart trims and checks), host-api and lyricad routes,
`web/src/uploads.ts`, the Upload segment on both pages, the Downloads
wording. Tests: host/test/downloads.test.ts, daemon/test/daemon.test.ts
"model uploads", web/test/downloads.test.ts, e2e "Upload sends…".

**Next:** hosts need an update to main before Upload works on them.
Optional follow-up from review: catch an ELOOP on a planted part at
fetch start and fail that upload instead of fetch.
