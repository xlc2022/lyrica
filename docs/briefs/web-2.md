# Brief: Web UI 2 (the Models page, Sleep and images)

**Thread:** Web UI. **Branch:** `feature/web`. Each part is its own PR,
started when its API lands:

| Part | Needs |
|---|---|
| Models page | Models 2's API |
| Sleep section | Sleep's API |
| Images and photos of you | Images' API |

**Read first:** docs/briefs/web.md and docs/web.md, DESIGN.md ("How the web UI
looks", "Models and endpoints", "Sleep" and "Images"), and the API in
`daemon/src/api.ts`.

## Goal

The web UI shows what the new back ends do, in the agreed look, and works on a
phone (principle 1).

## In scope

1. **The Models page**, built from the mockup
   (https://claude.ai/artifact/U3xANiSAFje8cuinWpHo7V). It replaces the
   control panel's Endpoints and Model profiles sections, which then link
   to it.
   - Hosts and plain endpoints with live status: per-GPU VRAM bars, models,
     pause and resume, a dashboard link, and editable addresses.
   - **Add endpoint**, with the plain-HTTP warning.
   - **Add model host**: addresses, pairing code, then the paired
     fingerprint.
   - Profiles: one line per task showing what answers it now, opening to its
     ordered list (drag or arrows to reorder, add, remove) or **Same as**
     another task. Pickers offer only suitable models.
   - The model library: search, filters, stars, and **Get a model** (host,
     source, repository lookup with file choice, token for gated
     repositories, progress).
   - Model groups and Clean up, as in the mockup.
   - Recent calls, with fallback notes.
   - The thread's model badge shows which model actually answered, and when
     a fallback was used.
2. **The Sleep section** in the sidebar, as docs/sleep.md describes:
   - her **items** at the top: what she'd like to raise after a night, each
     with **Start a chat** and **Dismiss**, and a badge on the section while
     any are new;
   - for each run, per pool: its status (or why it was skipped), notes added,
     pages changed with a diff, questions, the dream and the WAKE, each
     linking into the memory browser;
   - **Sleep now**;
   - the per-user scheduled or manual setting, and the administrator's sleep
     time.
3. **Images.**
   - Inline images in messages, with a full-size view, and progress while
     one is made.
   - A **Photos of you** page: upload, view and delete the photos, plus the
     Never, Ask once a day and Always setting, explained in plain words.
   - The ask-once-a-day prompt uses the existing permission prompt, worded
     for photos.
4. **Phones.** Every part is checked at 390×844 with Playwright, like the rest.

## Out of scope

- The back ends.
- The host's own dashboard (Model host thread).

## Done when

For each part:
- typecheck, tests, build and Playwright pass in CI;
- docs/web.md describes what exists;
- the PR shows a screenshot at desktop and at phone size.

## Handoff notes

(The thread fills this in if it stops before it's done.)
