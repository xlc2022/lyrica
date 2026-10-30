# Brief: a reply waiting for a model host's GPU

Principle 1 (she is there when you talk to her) and the model host design
(DESIGN.md, "Model hosts"): a host runs one model at a time per GPU, and
with models of 130 GB and more, loading or swapping one alone can take
longer than the host's 120-second wait limit for chat. A chat reply then
failed with "503: {"code":"busy",…}" in red, though nothing was wrong.

## What changes

- **Host.** A `/v1` request tagged with `X-Lyrica-Job` waits for the GPU as
  long as its client stays connected (no `busy`), and its job
  (`GET /host/v1/jobs/<token>`) says what it waits for: `busyWith` (the
  `busy` error's words) or `loading`. Untagged requests keep the limits.
  Text and image jobs share one `Jobs` (Runtime's).
- **Lyrica.** A thread's runtime (`openThreadSession` with `onGpuWait`)
  tags a host's chat requests (`waitingFetch`), reads the job while it waits
  and sends a `gpu_wait` thread event; the request has no first-byte limit.
  Sleep, subagents and watching stay untagged, so they keep falling back on
  `busy`.
- **Web.** The status line says "Waiting for the GPU, busy with a chat
  model…" or "Loading the model…" in place of "<name> is thinking…" (and
  even after a reply has started). A server's JSON error shows as its
  message alone.

Out of scope: RAM offload for models that don't fit (its own thread), a
queue position, and an ETA for a load.

## Handoff

Done: all of the above, with tests (scheduler, `waitingFetch`, the live
reducer, `plainError`). Next: PR review (host and agent loop) and UI review
(status line copy). Open: whether Stop should also say that the host keeps
loading a model it already started.
