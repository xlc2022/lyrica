# Brief: the model request's counts while she works

**Principle:** 1 (experience before infrastructure): while a reply is
prepared, the user saw three dots and nothing else, so a long prompt read
looked like a hang. The owner asked for a little data in their place
(prefill tokens and so on) and picked "all models, with fallbacks".

## What changes

- **Core.** Host discovery keeps the server a host model runs on
  (`Offering.server`: llama.cpp or vLLM, from `/host/v1/models`).
- **Extension.** A thread's own turns (`openThreadSession` with
  `onLiveCall`) ask a llama.cpp model (on a host, or a plain llama-server)
  for `return_progress` and `timings_per_token`, and a host's vLLM model
  for `stream_options.continuous_usage_stats`; nothing new goes to any other
  server. `LiveCallMeter` (live-call.ts) reads only numbers from Pi's
  `provider_stream_event`: llama.cpp's `prompt_progress` and `timings`, and
  `usage` where a server sends it on the way. Elsewhere the prompt is the
  context's estimate and the output is counted at four characters a token.
  It sends when what the line shows changes, and at most every 500 ms
  otherwise; null when the request ends.
- **Daemon.** `live_call` thread events go to open views only, outside the
  replay buffer; a busy thread's `hello` carries the latest. Never stored
  or logged.
- **Web.** `CallStats` shows "Reading 1,340 of 2,212 new · 1,840 tok/s",
  "Prompt 48.2k · 12 s", "Thinking · 412 tokens · 38 tok/s" or
  "Writing a tool call · ≈412 tokens" in place of the dots and of
  "is thinking…" (docs/ux.md, "The reply as she writes it"), and the dots
  while nothing is known or the reply waits for the GPU.

No host change: a host passes request bodies through unchanged, so only a
Lyrica rebuild is needed. Out of scope: subagent and sleep requests (no
view shows them live), and keeping the counts on the reply after it ends
(Status and the Context popover already show measured speeds).

## Handoff

Done: all of the above, with tests (the meter, the payload fields, a
llama-server's progress reaching the thread, the live reducer, the line's
words). Next: UI review and PR review; merges are paused by the owner until
Lyrica's #925 merges. Open: none.
