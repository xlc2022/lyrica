# Lyrica's interface: the rules

Read this before changing anything a user sees: the web UI, a mockup, a
dashboard page, a notification's wording. It exists because interfaces drift
one addition at a time. Each rule is checkable; a reviewer applies them as a
list, and a PR that breaks one isn't done.

The thesis: **the conversation comes first, and everything else is quiet,
familiar and in its one place.** When a rule here and your idea disagree, the
rule wins. When no rule covers your case, stop and ask the design thread
before building; don't guess and add.

## 1. Before you add anything

Work through these in order. Most additions end at step 1 or 2.

1. **Does it already have a home?** Section 6 lists where every kind of thing
   lives. Put yours there. A new control somewhere else, a new row of
   buttons, a new panel or a new page needs the design thread's agreement
   first.
2. **Is it a fact, a state or an action?** Facts go in the line beneath a
   name, in plain text. State is a badge or a dot with a word, at most two
   per row. Actions are buttons, links or menu items, and look like it.
3. **Does it work on a phone?** At 390 px wide, with no sideways scrolling,
   and with a long press where a desktop right-clicks.
4. **Does it use what's already there?** The icon set, the three button
   looks, the segmented control, the drawer, the context menu, the
   confirmation dialog. A new widget is a design change, not a feature.

## 2. Look

- **Calm and plain.** Colour comes from the user's accent; nothing else is
  coloured for decoration. Light or dark follows the device.
- **Type:** IBM Plex Sans for text, IBM Plex Mono for every number, size,
  time, path and address, with tabular figures. Served by `lyricad`, never
  fetched from elsewhere; system fonts as fallback.
- **Sizes, and no others:** 22 (page title), 15 (chat body), 14 (admin
  body, row titles), 13 (meta, tables, small buttons), 12 (captions), 11
  (uppercase section eyebrows, 0.06 em tracking). Nothing smaller than 11.
- **Headings:** one `h1` per page, never repeated as a card heading below
  it. Section heads are 15/600. A page header states facts (counts, status),
  not what the page is for.
- **Icons:** one family of 16 px line icons. Never a text glyph (☰ ⚙ ▤ ◔ ▣)
  standing in for an icon. An icon sits beside its word; a row of icon-only
  buttons has `aria-label`s and a border on each.
- **Spacing:** a 16 px gutter on phones; cards and drawers share one radius.

## 3. Controls

Three looks, and no more:

| Look | When | How it looks |
|---|---|---|
| **Primary** | the one main action on a screen, drawer or dialog | filled accent, 600 weight. If two things want it, neither gets it |
| **Secondary** | every other action, including Cancel and Delete (Delete in `--danger` text) | 1 px border, panel background |
| **Link** | going somewhere, revealing more of a list, or opening one thing's settings or picker | accent text, underline on hover, a caret ▾ when it opens a menu |

Rules:
- Nothing pressable is plain grey text, ever.
- A thing you press is a **button** when pressing changes something here, a
  **link** when it takes you somewhere, a **menu item** when it is one of
  three or more rare actions on a row, or destructive and must not sit next
  to the common action.
- At most two visible actions per row; the rest go behind ⋯ at the row's end.
  Settings reached often are a **link in the thing's own line**, never a
  button on every row.
- A **segmented control** picks one of two to four views of the same data
  (Sampling | Serving, Files | Images, All | Uploaded | Made by Lyrica).
  Never for navigation between pages.
- Heights: 36 px on pointer devices, 44 on touch; small buttons in rows 30 px
  with 13 px text. A segmented control cannot shrink below its buttons.
- A badge that opens something carries a caret ▾. A badge that doesn't,
  doesn't.
- Keyboard: a context menu's items have letter shortcuts; Escape closes the
  topmost thing (selection, then menu, then panel).

## 4. Words

- **Labels are short nouns** (Sampling, Serving, Pinned, Excluded, Memory,
  Template, Group, Notifications, Backend) or the words a person would say
  (Not this model, Start a chat, Read aloud). Never a description of what the
  thing does ("How it's served"), never a sentence as a label.
- **No explanatory captions** under headings, in page headers, at the foot
  of a form, or beside a control. Where a word needs explaining, the
  explanation is a tooltip on that word.
- **A sentence appears only where an action has a consequence**: deleting,
  sharing, replacing, anything that leaves the server. It says the
  consequence, not the concept: "Its messages are deleted, and so are the
  memories that came only from it."
- **Facts, not reassurance.** "Online", "2 GB free", "Paused since 20:38".
  Not "Everything is fine", not "Loading your models…".
- **Names in use** (don't invent synonyms): General and Private (pools),
  Hidden, Last night, Notifications, Backend, Models, Tasks, Text models,
  Image models, Hosts and endpoints, Downloads, Clean up, Recent calls,
  Settings, Administration, Files, Images, Pinned, Branch, Regenerate,
  Share with, Move to group, Sampling, Serving, Placement, Memory,
  Throughput, Template, Pinned, Excluded, Servers, Keep free, Not this
  model, Group, Add…, Reset, Dictation, Dictate, Read aloud, Stop reading,
  Voice to cloud, Voice, Speed.
- Numbers get units beside the field (GB, %, tokens), and a maximum shown
  where one exists ("of 128k").

## 5. State and badges

- **Badges carry state only**, never facts. At most two per row. State is
  what changes: Online, Paused, New, Stale, gone, parts missing, a fallback
  in use. Quantisation, context, "shared", "vision" are facts and go in the
  line beneath the name.
- **Status is a dot and a word**, 8 px dot, four colours used identically
  everywhere: green ok, amber warning, red problem, blue information. The
  word says why: "Unreachable 16 days".
- Counts that need attention are the accent-coloured round count used in the
  sidebar; the same shape everywhere.

## 6. Where things live

| Thing | Its home |
|---|---|
| A thread's title, pool, model, group, folders, pins | the thread header: title, then **one line of facts** with the model picker as the only chip, then **two actions**, Files and Settings. One state badge at most |
| Picking a model, a group, a pinned message | a popover from its word in the facts line |
| A thread's own files and images | the **Files** panel (full screen on a phone), with every action in its right-click menu |
| Editing one thing in context (a task's list, a model's settings, a GPU's settings) | the **drawer** on the right, sections with eyebrows, one Save at its foot when saving has a consequence |
| Confirming an action with a consequence | a **dialog** with the sentence and two buttons. Dialogs confirm; they never hold forms or flows |
| A flow with steps (download a model, pair a host) | a **page** with its own address, never a dialog |
| Actions on a thread (pin, rename, share, move, hide, delete) | the thread's **right-click menu** in the sidebar, letter shortcuts, long press on a phone |
| Rare actions on a row | the row's **⋯** menu |
| Sorting and what's shown | the one **Sort** menu above the thread list |
| Anything waiting for the user | **Notifications**: the sidebar link with its count, the Settings section, and the Notifications card on the welcome page. Never a banner elsewhere |
| A user's own settings | **Settings**, sections on the left |
| Server-wide settings | **Administration**, shown only to administrators |
| Models, hosts, downloads, clean-up | the **Models** area: Overview, Tasks, Text models, Image models, Hosts and endpoints, Downloads, Clean up, Recent calls |
| The app's version | the header, "Lyrica (ver. …, build …)" |
| Lyrica's inner workings (recall, tools, notes) | one-line **markers** in the conversation that expand when tapped |
| A subagent | a **card** in the conversation that expands to its work and takes messages |
| Dictating a message | the mic in the message box's row; the box's placeholder while listening |
| Hearing a message read aloud | her message's actions |
| Voice to cloud | the thread's Privacy and network switches |
| A speech model's voice and speed | its Settings drawer in Models |
| A child thread | nested under its parent in the **sidebar**, with its state and unseen count as badges; its updates as a **card** in the parent's conversation that links to it |

If your thing isn't in this table, it needs the design thread, not a new
spot.

## 7. Forms and settings

- Number fields over drop-downs. The field shows the maximum beside it and
  a value past the maximum becomes the maximum when the field is left.
- A row is a label, a control and its unit; nothing else on the row.
- An inherited value shows as the placeholder; a value's source, when it
  isn't the default, is one small word after the label ("shared", "yours").
  One **Reset** link per section, never a reset button per row.
- Save once, at the foot. If a change applies later, the Save button's
  tooltip says when. If a change can apply now, a second button says so
  ("Save and reload").
- Validation is a plain sentence in place of the estimate line, and Save
  is disabled until it passes.

## 8. On a phone

- Everything works at 390 px: the sidebar slides in, drawers and the Files
  panel go full screen, tables stack into rows, header actions become icon
  buttons with labels for screen readers.
- No horizontal scrolling, anywhere, ever.
- A long press does what a right-click does.
- Touch targets are 44 px.

## 9. Don'ts, from our own history

Each of these was built, looked tacked on, and was redone. Don't repeat them.

- A second row of buttons under a page title. Actions go in the header's
  action slot or the facts line.
- Text glyphs as icons, mixed with real icons.
- A modal dialog holding a settings form or a multi-step flow.
- Tab names that describe ("How it answers"); form footers that explain
  ("Sent with every call to this copy").
- A Settings button on every row of a table.
- A banner inside a list to announce things found elsewhere.
- Two primary buttons on one screen.
- A dropdown for a number the user knows better than we do.
- Per-row explanatory captions, and a caption repeating the heading.

## 10. The checklist for a PR that touches the interface

Say in the PR which rule each new control follows, and confirm:

- [ ] every new thing has a home from section 6, or the design thread agreed
      a new one;
- [ ] no new widget, button look, icon style or type size;
- [ ] labels are nouns from section 4; no captions were added; any
      explanation is a tooltip;
- [ ] badges carry state only, at most two per row;
- [ ] numbers are typed with units and a shown maximum;
- [ ] a screenshot at 1280 wide and at 390 wide, with no horizontal
      scroll;
- [ ] docs/web.md describes what changed.
