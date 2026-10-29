# Brief: read model lists daily

**Status:** Merged as #519 (76cd1fc).
The owner asked on 2026-10-24, after OpenRouter dropped a free model without
notice, for every endpoint's model list to be read again every 24 hours,
with a setting to turn it off.

Serves principle 1: a model an endpoint stopped offering shows as missing
and reaches Clean up on its own, instead of failing calls until someone
presses Refresh.

## What it does

- **Read model lists daily**, a per-user switch on by default, in the
  Hosts and endpoints header (docs/ux.md).
- `lyricad` calls `Models.rereadDaily` hourly. It rediscovers each endpoint
  whose list wasn't read for a day: a user's own, and shared ones for an
  administrator with it on. Paused and signed-out endpoints wait.

## Decisions

- **Nothing new for missing models** (the owner): `discover` already marks
  a dropped model missing, then gone after 30 days, with Clean up offering
  Replace with… or Remove.
- **Only lists are read**, never a model.
- **No schema change:** the last read is kept in memory, so a restart reads
  every list once more. Lists are cheap to read.

## Out of scope

- Offering a replacement for a dropped model automatically.
