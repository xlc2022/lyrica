# Brief: Model presets

**Thread:** Model presets. **Branch:** `feature/model-presets`.
**Model:** Codex or DeepSeek on lunasa builds; Opus reviews.
**Depends on:** nothing open.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Models and endpoints"
(Profiles, Fallbacks, the Models page), docs/models.md "Profiles and lists"
and "Choosing a model", docs/contracts.md `core/models` and the Models page
routes, docs/ux.md (the Models row), and the Models mockup's Tasks tab
(https://claude.ai/artifact/UuJWStV5jVUhf9PGyh52Ht).

## Goal

The Tasks table's two columns, **Private threads** and **General threads**,
each get a **Preset** menu in their head. A preset names the whole
task-to-model table at once, so switching setups is one pick instead of the
one-way **Use Cloud instead** / **Use Custom instead** buttons and the
third "Show Custom too" column. Private presets hold local models only, so
the UI can't offer a private thread a cloud model and the daemon refuses
one anyway.

Principles: 2 (the privacy boundary is structural: enforced in core, not in
the menu) and 8 (it replaces three profiles, two switch buttons and a
third column with one control per column).

## Decided (with the user, 2026-10-13)

- **Presets replace profiles.** A preset is a named map of task to entry
  (`Entry`, as profiles have today: a list or `{ same }`), with a scope:
  - **private:** local models and local endpoints only. Offered in both
    columns, since a local-only table is valid anywhere.
  - **general:** local and cloud mixed freely; its lists fall back in
    order across the line, each model marked, as Custom does today.
    Offered in the General column only.
- **Built-ins.** **Local** (private) and **Cloud** (general). They can't be
  renamed or deleted; their lists can be saved over.
- **A column follows a preset or is Custom.** Picking a preset makes the
  column follow it: later saves to that preset show at once. Editing a row
  in the table copies the preset's table into the column, applies the edit
  and shows the column as **Custom** (remembering which preset it came
  from), so a preset never changes by accident.
- **Saving.** While a column is Custom its menu offers **Save to <name>**
  (the preset it came from) and **Save as preset…**. Both make the column
  follow the saved preset again.
- **New preset…** and **Save as preset…** open a drawer (drawers edit,
  dialogs confirm): **Name**, then a read-only summary of the column's
  table it will copy (task, first model, "+N fallbacks"), then Save. The
  scope is the column's. A preset's own Edit opens the same drawer to
  rename it, with **Delete preset** at its foot, confirmed by a dialog.
- **Names** are 1 to 40 characters, unique per user ignoring case, and
  never "Custom". The drawer shows "A preset called <name> already
  exists." under Name and keeps Save from saving; core and the daemon
  refuse the same.
- **Deleting a preset in use** leaves each column that followed it Custom
  with the same lists, and each thread that chose it on its column again.
  Nothing loses a model silently.
- **Gone models.** A preset that names a gone or missing model is never
  rewritten by the router: the row's cell shows that model red ("gone")
  and the next one answers, as lists do today. Clean up lists the preset
  among its uses, and its **Replace with…** is the one way a preset's model
  changes without the user editing it.
- **Threads.** A general thread's own choice is a preset (or none: its
  column), replacing `setThreadProfile`. Private and local-only threads
  always use the Private column. There is no thread-level preset UI yet;
  the thread settings API and the CLI carry it.

## In scope

1. **Core (`core/models`).**
   - `user.db`: a `model_presets` table (id, name, scope, builtin
     `local | cloud | null`, entries as JSON, updated_at) and the two
     columns' state (followed preset id, or Custom entries plus the preset
     they came from). `thread_choices` gains `preset`.
   - `presets(userId)`, `addPreset(userId, { name, scope }, from: column)`,
     `editPreset` (rename), `savePreset(userId, id, column)` (Save to),
     `removePreset`, `useColumnPreset(userId, column, id)`,
     `setColumnTask(userId, column, task, value)` (the edit that makes it
     Custom), `column(userId, column)`, `setThreadPreset` /
     `threadPreset`. Replace `profile`, `setProfile`, `defaultProfile`,
     `setDefaultProfile`, `setThreadProfile`, `threadProfile`.
   - **The boundary, in core:** a private preset, and the Private column's
     Custom entries, refuse any cloud model or a group with no local member
     (`CloudModelForbidden`), on every write path including `savePreset`,
     `replace` and `merge`. The Private column can follow only a private
     preset. A restricted context resolves from the Private column whatever
     its thread or the General column say. A group's cloud members stay
     skipped in a private table.
   - `resolve` reads the thread's own lists, else the thread's preset, else
     its column, after one level of `same`; `Resolution.profile` becomes
     the preset's name (or "Custom") and `source` gains `"preset"`.
   - `Use` gains `{ where: "preset"; presetId; name; task }` and
     `{ where: "column"; column; task }` for Clean up.
2. **Migration (expand).** Local → built-in Local, Cloud → built-in Cloud,
   a non-empty Custom → a general preset named **Mixed**. The Private
   column follows Local; the General column follows Cloud or Mixed, as the
   old default said. Thread choices of `cloud`/`custom` become those
   presets. `model_profiles` and `thread_choices.profile` stay one release,
   kept in step (Local with local, Cloud with cloud, Mixed with custom, and
   the General column's preset with the default where it is one of those),
   so a rollback keeps the user's choices. A test migrates from every released `user.db` schema.
3. **Daemon.** `GET`/`POST presets`, `PATCH`/`DELETE presets/:id`,
   `PUT columns/:column` (`{ preset }`), `PUT columns/:column/:task`
   (`{ models }`, `{ same }` or `{}`, as profiles take today),
   `POST columns/:column/save` (`{ preset }` or `{ name }`). They replace
   the `profiles` routes. The thread settings `PATCH` takes `preset`
   instead of `profile`. The daemon refuses a cloud model in a private
   preset or the Private column itself (400 with the router's message),
   not only by trusting the web UI. `lyrica admin models preset
   list|show|use|set|save|add|rename|remove … --user <login>` replaces the
   `profile` commands.
4. **Web (Models → Tasks).** Per the mockup:
   - Each column head: the column name, then the **Preset** menu button
     showing the current preset's name, or **Custom**, with a chevron.
     A long name is truncated with an ellipsis (full name in its title),
     so the heads stay side by side on a phone.
   - The menu: a search box at the top ("Search presets"), the presets the
     column can use with the current one ticked (in the General column,
     General then Private under small headings; the Private column lists
     only private presets, with no headings), each user preset with an
     **Edit** icon button beside it (built-ins Local and Cloud have none,
     since there is nothing to edit); **Nothing matches** when the search finds none; then
     **Save to <name>** and **Save as preset…** while the column is Custom;
     then **New preset…** last.
   - Roles: the button has `aria-haspopup="dialog"` and `aria-expanded`;
     the popover is a dialog labelled "Preset" holding the search box and
     a list of presets, each preset a button with its Edit button beside
     it, not inside it (so not `role="menu"`, since a menu item can't hold
     a button).
   - Keyboard: the button opens the menu with focus in the search box;
     arrows move through items, Enter picks, **E** on a highlighted user
     preset opens its Edit, Tab reaches the Edit buttons too, and Escape
     closes and returns focus to the button. The Edit icon has an accessible name ("Edit
     <name>") and the tooltip "Edit <name> (E)". It is a new `edit`
     (pencil) icon in `web/src/icons.tsx`, in the set's stroke, and every
     menu row is at least `--tap` tall on coarse pointers. docs/ux.md records this keyboard model.
   - Remove **Use Cloud instead**, **Use Custom instead**, **Show Custom
     too**, **Hide Custom**, **Show Cloud too**, **Hide Cloud** and the
     third column.
   - The task drawer's caption names the column and its preset, or
     "Custom". Its picker in the Private column offers local models only.
   - Overview's Backend tile and the welcome page's Backend card show the
     preset name where they show the profile word today.

## Out of scope

- A thread-level preset picker in the thread drawer.
- Sharing presets between users, or administrator presets.
- Presets for answer settings or thinking levels.

## Done when

- The Tasks tab matches the mockup at 1280 px and 390 px, and UI review
  has verified it.
- A cloud model can't reach a private preset or the Private column through
  any route, CLI or core call (tests at core and route level).
- Migration from every released schema keeps each user's lists and default
  (tested), and the previous release still opens a migrated database.
- A gone model in a preset shows red, the next model answers, and the
  stored preset is unchanged (tested).
- DESIGN.md (Profiles, Fallbacks, the Models page), docs/models.md,
  docs/contracts.md, docs/ux.md (the Models row, and the word list gaining Preset, Search
  presets, Save to, Save as preset…, New preset… and Delete preset; Nothing
  matches is there already) and the
  operator guides that name the `profile` CLI are updated in the same PR.

## After merging

Tell the coordinator and the Operator docs thread: the `lyrica admin models
profile` commands became `… preset`.

## Handoff notes

- 2026-10-13: brief written; PR review's three findings (rollback for
  Mixed, preset names, the menu's role) and UI review's (no Edit on built-ins, E and Tab
  reach Edit, a pencil icon, no headings in the Private menu, truncated
  names, the word list) folded in. The build PR carries
  the DESIGN, contracts, models and ux doc changes (PR review's call). Next: mockup to UI review and PR review, then
  the build on lunasa.
