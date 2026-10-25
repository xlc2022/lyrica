# Chat view polish

**Status:** Merged as #308 (56b5185). Handoff notes below are history.

## Goal

Serve principle 1, the conversation comes first (docs/ux.md's thesis):
the chat shows what was said and made, and keeps her inner workings quiet.
The owner's feedback from using the Images build, with screenshots:

1. A message's actions sit under the message as a quiet row of icon
   buttons, as Claude's do, and Branch and Regenerate are among them.
2. A run of tool calls no longer scrolls the screen: it collapses into one
   line that opens a scrollable box with every call, up to the next message
   with something to show.
3. An uploaded image shows inline, in the message box and in the chat, and
   gets a random file name so two screenshots never collide. Uploads stay in
   `uploads/`, apart from the images she makes in `images/`.
4. Regenerate no longer shows the user's message twice while the new reply
   is on its way.
5. An image she made shows once, not as the tool's image and again as a
   thumbnail in her prose.
6. The image's facts line names the recipe, not its ID.
7. Regenerate with… lists only chat models, never image recipes or speech
   models.

## In scope

Web UI (`web/src/Messages.tsx`, `Rewind.tsx`, `Composer.tsx`, `paths.tsx`,
`live.ts`, `stream.ts`, `app.css`), the upload name in
`core/src/workspace`, the image part's model label in `extension/src/images.ts`,
docs/ux.md, docs/web.md, docs/workspace.md and the app mockup.

## Out of scope

The thread header, the composer's tool switches, the Files panel, the image
tool itself, reactions, Remember this.

## Design

- **Action row** (docs/ux.md §6, "A message's actions"): under the message,
  icon buttons without borders at rest, bordered on hover, each with its
  name as tooltip and accessible name. Hers: Copy, Regenerate, Branch,
  Read aloud, React, ⋯. The user's: Copy, Edit, Branch, React, ⋯. The ⋯
  keeps Pin, Remember this, Regenerate with…, Start a thread and Delete.
  Shown on hover or focus on pointer devices, always on touch. The header
  line keeps the name, model, time and pinned badge. An agreed exception to
  §3's two visible actions and §2's bordered icon buttons, as the message box is.
- **Tool run**: her messages that hold only markers (thinking, recalls,
  tool calls that aren't cards) get no header line of their own. A run of
  three or more such markers, across messages, collapses to one marker,
  "<n> tool calls" (the count in mono) with "running" while the turn goes
  on, which opens to a box at most 320 px tall that scrolls, every marker
  inside it opening as before. The run ends at her next text, image or
  card, or at the user's next message. A run with a call that only waited
  (a sleep that printed nothing but its echo, the refusal of a repeated
  read of another thread) folds whatever its size, and a read of another
  thread joins a run rather than ending it.
- **Uploads**: an image upload is saved as `uploads/<random>.<ext>`; other
  files keep their cleaned name. In the message box an image path in the
  draft shows as a thumbnail above the text with an ✕ that takes the line
  out. In the chat the user's message shows an image path under the thread
  folder as its thumbnail (opening large), in place of the path.
- **Regenerate**: the live copy of the re-sent message carries where it was
  sent, so the stored copy replaces it as it does for a send.
- **One image**: a path her prose names that an image part already showed in
  the same turn stays a link.
- **Recipe name**: the image part's model is the recipe's name on a host,
  the model ID elsewhere.
- **Chat models**: the model picker and Regenerate with… skip image, speech
  and embedding models.

## Done when

The mockup's thread frame shows the row, a collapsed run and an uploaded
image; the build matches it at 1280 and 390 wide; `live.test.ts` covers the
regenerate case; docs/ux.md, docs/web.md and docs/workspace.md describe what
exists; UI review and PR review have verified.

## Handoff

- Done: mockup (lyrica-app v33), the build, unit tests, e2e at 1280 and
  390, docs (ux.md, web.md, workspace.md, api.ts). Merged as #308.
- Open questions: none.
