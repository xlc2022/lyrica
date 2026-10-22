# Time zone setting

Each user sets their own time zone, and Lyrica uses it for every time she
shows or is told. Serves principle 1: in a model comparison a model got
the weekday wrong because it was told the server's date, and a user in
another zone than the server sees times, "Today" and their sleep hour
shifted.

## What it does

- **Where it lives.** `Profile.timeZone`, an IANA name ("Europe/Vienna"),
  in `self.db`'s `users.profile` JSON beside the pronouns, so no migration.
  `checkProfile` refuses a name the server's ICU doesn't know. Unset, the
  server's zone applies (`zoneOf`, `core/src/zone.ts`). Only the user's own
  `PATCH …/me/profile` sets it; other users never see it (`UserCard`
  doesn't carry it). `Me` carries `timeZone` and `serverTimeZone`.
- **Default.** The web gives a user without one the browser's zone, once,
  the first time the shell loads (`useZone`). Saving the profile with the
  field empty saves the browser's zone.
- **The model.** The per-turn time line names the user's local date, time
  and zone: "It is Thursday, 22 October 2026 at 08:30 (Asia/Tokyo)."
- **Routines.** Wall times are in the user's zone (`nextRun(…, zone)`). A
  zone change moves each routine's next run to its wall time in the new
  zone (`rezoneRoutines`); every-N-hours routines keep their instants.
- **Sleep.** Each user sleeps at `sleep.time` in their own zone; runs queue
  so one goes at a time across users. Model cleanup, the sweep and idle
  project threads stay at `sleep.time` in the server's zone.
- **The web.** `setTimeZone` before each render; `clock`, `dateText`,
  `dayNumber`, `hourOf`, `wakeTime` and `fullTime` in `ui.tsx` read it. The
  sidebar's date groups count days in it. Settings → Profile has the
  **Time zone** field (docs/ux.md, "A user's time zone").

## Out of scope

- Times inside model-facing tool results stay UTC with a `Z` (wake-ups,
  routine lists), since they are explicit.
- An administrator can't set another user's zone.

## Handoff

Done: everything above, with tests for the zone maths (core routines
test), the profile check (accounts), the time line (assemble), the route
and rezoning (daemon routines), per-zone sleep (daemon sleep) and the web
helpers (web times). Next: nothing planned. Open: whether a traveller wants
a one-click "use this browser's zone" when the two differ.
