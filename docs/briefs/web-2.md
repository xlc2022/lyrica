# Brief: Web UI 2 (the Models page, Sleep and images)

**Thread:** Web UI. **Branch:** `feature/web`. Each part is its own PR,
started when its API lands:

| Part | Needs |
|---|---|
| Models page | Models 2's API |
| Sleep section | Sleep's API |
| Images and portrait photos | Images' API |

**Read first:** docs/briefs/web.md and docs/web.md, DESIGN.md ("How the web UI
looks", "Models and endpoints", "Sleep" and "Images"), and the API in
`daemon/src/api.ts`.

**Read first, every time:** docs/ux.md. A PR that touches the interface
follows its checklist.

## Goal

The web UI shows what the new back ends do, in the agreed look, and works on a
phone (principle 1).

## In scope

0. **The look and the shell**, from the app mockup
   (https://claude.ai/artifact/96BoPXPoxL2LDBg8eLxjHx) and DESIGN's "How the
   web UI looks" and "Where things are":
   - IBM Plex Sans and Mono, self-hosted in the web build (OFL licence file
     included), with system fallbacks; the five sizes; the three action
     looks; badges for state only; no explanatory captions.
   - The sidebar as described, with thread sorting (by date, last activity,
     start date, title) and the user's own groups (made and filled from a
     thread's header or a right-click / long-press menu), saved per user (a small
     API and a `thread_groups` table in `user.db`; a thread's group is a
     per-user setting, never in the pool). One Sort menu holds the sort
     choices and the General / Private / Hidden checkboxes.
   - The thread menu (right-click or long press, letter shortcuts): Pin,
     Mark as unread, Rename, Share with ›, Move to group ›, Hide, Delete.
     Pin uses the per-user thread pins that Projects (back end) builds.
     **Share with** sends a copy to another user on the server: a
     notification for them with Add to General, Add to Private and Decline;
     accepting copies the entries into a new thread in their pool, as an
     export does, and indexes it there. Nothing of the sender's memory goes
     with it. Tests: a declined share leaves nothing in the recipient's
     pools; a shared private thread lands only where the recipient chooses;
     the sender's later messages never reach the copy.
   - The header shows "Lyrica (ver. …, build …)" inline, with the date
     beneath; the daemon reports its version (package.json) and build (the
     git commit, set at build time).
   - Notifications with its count in the sidebar's top links, under Search; the user's
     button and its menu (Administration only for administrators; the
     control panel's "Server" section is renamed), Settings and Administration as
     pages with a section list (the control panel's cards move into them),
     and the Notifications page with its API: one list over what waits for
     the user, sortable, filterable, paged, with each item's actions.
   - **The thread's Files and Images panel**, as in DESIGN, with its API in
     `daemon/src/api.ts`. Everything goes through `Workspace` in a sandbox,
     so paths and symlinks can't leave the thread's folder and its grants:
     - list one folder at a time (grants can be large), search names (capped);
     - serve a file (the Images route), and a thumbnail made by the daemon
       and cached in the thread's folder under `.lyrica/thumbs/`, which the
       panel doesn't list;
     - upload to a folder, make a folder, rename, delete several, and
       download several as a zip streamed straight to the response, never
       written to disk;
     - read-only grants refuse every change;
     - a names-only note of files added or removed since her last turn,
       placed in her next turn.
     Tests: `..` and symlinks can't escape for upload, rename or delete; a
     read-only grant refuses changes; the zip leaves no temp file; a panel
     upload reaches her next turn as names only; another user's thread files
     are refused.
   - The thread view's message actions, mode picker, "+" switches, thinking
     control, pins and the removal confirmation come with the back-end briefs
     that add them (Modes, Child threads, Models 2).
1. **The Models page**, built from the revised mockup
   (https://claude.ai/artifact/U3xANiSAFje8cuinWpHo7V): Overview, Tasks
   (Private and General), Text models, Image models, Hosts and endpoints,
   Downloads, Clean up and Recent calls. It replaces the control panel's
   Endpoints and Model profiles sections.
   - Hosts and plain endpoints with live status: per-GPU VRAM bars, models,
     pause and resume, a dashboard link, and editable addresses.
   - **Add endpoint**, with the plain-HTTP warning.
   - **Add model host**: addresses, pairing code, then the paired
     fingerprint.
   - Tasks: a table of tasks against Private and General threads; each cell
     shows what answers now and opens a side panel with its ordered list
     (drag or arrows to reorder, add, remove) or **Same as** another task.
     Pickers offer only suitable models.
   - **Image models**, a tab of its own: recipes, and parts by type
     (checkpoints, diffusion models, text encoders, VAEs, LoRAs, unused
     files), filtered by architecture; each recipe opens to its copies and
     their parts, with Change within a slot (and Download another), Add a
     part (a LoRA with strength, or a VAE or encoder for a checkpoint),
     removing parts, a To review page for proposals (bulk Use, Download parts and Ignore, grouped by host, paged), missing
     parts to download, and Delete that says what it keeps; Download model
     with Starter recipes, Hugging Face, Link and Scan folder.
   - **Downloads**, a tab of its own with a count while anything runs:
     Download text model, Download image model, Accounts (hub tokens),
     progress with Cancel, finished downloads and deletions, Clear finished.
   - **Text models**: one row per model, opening to its copies with their raw
     names, where groups are made, reordered and undone; finetunes in rows of
     their own, linked to their base; flagged copies and **Not this model**;
     search, filters and stars; each copy's **Settings**: how it answers
     (with each value's source and a per-user override) and, on a model
     host, how it's served, with its placement and Reload now;
     **Download model** (host, source, repository lookup with file choice,
     the saved token for gated repositories, progress); **Delete** with a
     confirmation that lists where the copy is used; **Accounts** for hub
     tokens.
   - Clean up, as in the mockup.
   - Recent calls, with fallback notes.
   - A mode picker beside the message box (Ask, Accept edits, Auto, Plan;
     Shift+Tab cycles) and a "+" menu of switches (Web search, Internet for
     commands, Images), once the Modes brief lands.
   - A thinking control in the message box (Off, Low, Medium, High; only
     the current model's levels; hidden when it has none), and a note beside
     the model badge when a fallback couldn't think.
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
   - A **Portrait photos** page: upload, view and delete the photos, plus the
     Never, Ask once a day and Always setting, explained in plain words.
   - The ask-once-a-day prompt uses the existing permission prompt, worded
     for photos.
4. **Phones.** Every part is checked at 390×844 with Playwright, like the rest.

## Out of scope

- The back ends.
- The host's own dashboard (Model host thread).
- Voice (dictation, voice conversation, Read aloud): the mockup's buttons
  are placeholders, not built here.

## Done when

For each part:
- typecheck, tests, build and Playwright pass in CI;
- docs/web.md describes what exists;
- the PR shows a screenshot at desktop and at phone size.

## Designs for the remaining parts

Written 2026-10-12 so an Opus thread can build each part without a design
pass. Each is one PR, in this order, after the pre-deployment batch. Every
part follows docs/ux.md; the strings below are the ones to use. Playwright
hooks follow the Models area's pattern (`data-*` on rows and cells).

### Text models (PR C)

The tab `models/text`, from the Models mockup's Text models view and the
API `GET …/library/text` (`TextLibrary`, `LibraryEntry`), `PUT
…/offerings/:id/star`, `PUT …/offerings/:id/separate`, `POST
…/offerings/:id/delete-copy`, the groups routes, `GET|PUT
…/offerings/:id/settings` (`OfferingSettings`) and `GET|PUT
…/offerings/:id/serving` (`ServingSettings`, #157).

- Header: facts "<n> models · <c> copies on <e> endpoints · <g> groups ·
  <s> starred" (numbers in `.num`); one action **Download model** (the
  one primary of the tab) that goes to the Downloads tab's Download text
  model page (PR D) with the tab as the way back.
- A banner (the Models area's banner, `info` dot) when the library reports
  the same file on several hosts: "The same file is on several hosts for
  <name links>. Group them?" with the names as links that open the row.
- Filters row: a search box (label "Search models", placeholder "Search by
  name or file"), chips Any endpoint / per endpoint, chips Local, Cloud,
  Vision, Starred (aria-pressed). The list: "New and starred first, then by
  name"; **Show <n> more of <m>** in a more-row at the foot (40 a page).
  Empty: "No models match."
- A **row** per `LibraryEntry`: a star button (☆ / ★, aria-label "Star
  <name>" / "Unstar <name>", `PUT …/star`), the name with at most two pills
  (`New`, `gone`, `parts missing` never here; `finetune` when `base` is
  set), a facts line "<kind words> · group of <n> | <n> copies · built on
  <base> · <endpoint names>", and a chevron; the row opens in place
  (aria-expanded) to its detail.
- Detail: a `stack-table` with columns Order (only in a group), Copy,
  Quantisation, Context (`.num`), Vision and actions. The Copy cell: the
  endpoint name with its kind mark, pills New / gone / same file, the raw
  name in `code.raw`, then a cap line "downloaded by Lyrica" or "shared
  folder" · a **Settings** link (opens the drawer below) · the warn text
  "the file records no finetune, but its name suggests one" when
  `flagged`. A cell whose value differs between copies gets class `diff`
  (a light background). Actions: in a group, **Move up**, **Move down**
  (icon buttons ↑ ↓) and **Remove from the group** (×, disabled on the
  last member); outside one, **Add to group** when the row has a group;
  a ⋯ menu with **Not this model** (`PUT …/separate`; the copy becomes a
  row of its own with "Separated from <name> · Undo") and **Delete from
  host…** when `downloaded`. Under the table, one warn line per group
  mismatch, exactly: "Mixes local and cloud: Local and Cloud profiles use
  only the matching copies, Custom uses all of them.", "Quantisations
  differ: answers can vary a little between copies.", "Context windows
  differ: long conversations skip the smaller copies.", "Only some copies
  can see images: calls with images skip the others." Then the group
  suggestion note ("Same file on each host · checksum <8 chars>…" or
  "Same name only"; **Group** and **Not the same model**), the lineage
  line ("Finetune of <link>." or "Finetunes: <links>."), and for a group
  the line "Group · shared with every user | only you" with **Rename** and
  **Ungroup**. Speeds from `copies[].speed` go in the Copy cell's cap
  line as "<n> tok/s" when present, never a column.
- **Delete from host…** is a dialog: h2 "Delete <name> <quant> from
  <endpoint>?", "<code>raw</code> is deleted from the host, which frees
  <GB>. It's loaded now, so it's unloaded first." (second sentence when
  loaded), "Used in <lists>. Those lists skip it from now on, and the
  group keeps its other copies." or the muted "None of your profiles use
  it.", and on a shared host "This host is shared, so other people's lists
  skip it too." Buttons Cancel and the danger primary **Delete**. The
  first call to `delete-copy` without `confirm` gives `usedIn` for the
  dialog; the second, with `confirm: true`, deletes.
- The copy **Settings drawer** (`aside.drawer`, aria-label "Settings for
  <name>"): h2 "<name> <quant>", cap "<endpoint> <kind mark> · <code>raw
  name</code>", a Close button. On a model host and a text model, a
  segmented control **Sampling** | **Serving** (tooltips "Temperature and
  the other sampling settings, sent with every call" / "Placement,
  context and memory on the host"); elsewhere Sampling only, without the
  control.
  - **Sampling**: on a shared endpoint a segmented **Yours** | **Everyone's**
    (administrators only see Everyone's; `scope` mine|shared). Eyebrow
    Sampling, one `.srow` per `AnswerSettings` key in this order and with
    these labels: Temperature, Top-p, Top-k, Min-p, Repeat penalty,
    Presence penalty, Frequency penalty, Maximum reply length, Seed, Stop
    strings (text). The placeholder is the inherited value (shared, else
    the endpoint's); the small source word after the label is "yours",
    "shared" or "everyone" from `sources`; a key in `dropped` is shown
    disabled with the word "not sent". One **Reset** link at the group's
    foot (tooltip "Back to the shared values" or "Back to the endpoint's
    defaults"). On a plain endpoint a second group, eyebrow Context, with
    **Context window** (tokens, placeholder the discovered value, the word
    "set by hand" when `contextWindow.source` is hand).
  - **Serving** (`ServingSettings.settings` is the host's object; keys as
    host/API.md names them): eyebrow "Placement · <server>" with a
    segmented **Auto** | **Choose GPUs**, then the GPU checkboxes "GPU <n>
    · <card> · <GB>" (disabled with "· doesn't run <server>"), the row
    **Split ratio** (llama.cpp, placeholder "even") or **Parallelism**
    (vLLM: Tensor parallel | Pipeline parallel) when more than one GPU is
    chosen, **Memory share** (vLLM, %, 5–95), the check **Pinned**, and
    an estimate line (role status) from the host's answer when the API
    gives one, else none. Eyebrow Memory: **Context length** (tokens, unit
    "of <max>" in the row's format, e.g. "of 1,048k"), then #157's rows
    **Stretch** (number, unit "×", maximum from the host, tooltip "YaRN.
    Applies to every request, so publishers suggest it only for long
    contexts.") and **Original context** (tokens, placeholder the trained
    length); a recommended value is the placeholder with the small word
    **recommended** after the label while the field is empty, "yours"
    once typed; a **Look up** link beside Reset in the eyebrow line fills
    them (`POST …/lookup`; on `need_repo` a popover with one field
    **Repository** and a Look up button). llama.cpp also has **KV cache**
    (F16 | Q8_0 | Q4_0), **GPU layers** (unit "of <n>") and the check
    **Flash attention**. Eyebrow Throughput: **Parallel**, then **Batch
    size** (llama.cpp, tokens) or **Max sequences** and **Data type**
    (vLLM: Auto | BF16 | FP16). Eyebrow Template: **Template** (From the
    model | Custom file…). Foot: Cancel, **Save and reload** (only when
    the model is loaded and the serving draft changed; tooltip "Reload the
    model with these settings now"), the primary **Save** (tooltip "Sent
    with every call to this copy" on Sampling, "Applies at the next load"
    on Serving). A refused save shows the host's reason as the drawer's
    error line; `above_recommended` shows it with a **Save anyway** button
    beside Save. A toast "Saved." or "Saved. Reloading <name> with the new
    settings." after.
- The speaking model's drawer (VoiceDrawer, already in Models.tsx) stays
  where it is; a speak-capable copy's Settings opens it.
- Phone: the table stacks (`data-h` labels), the drawer is full width, the
  segmented controls wrap.
- docs/ux.md: §4 names Text models, Download model, Star, Unstar, Group,
  Ungroup, Rename, Not the same model, Not this model, Delete from host…,
  Add to group, Remove from the group, Separated from, Undo, Yours,
  Everyone's, Sampling, Serving, Save and reload, Stretch, Original
  context, Look up, Repository, recommended; a §6 row "A text model's
  copies, groups and settings".
- Tests: the e2e Models test gains the Text models tab (the fake endpoints
  give two text models; star one, open its detail, open Settings, change
  Temperature and save, see "yours"); the Serving tab needs a host and is
  checked by hand on Li's host; a vitest for the group warn lines.

### Image models and Downloads (PR D)

From the mockup's Image models, To review, Download image model, Downloads
and Accounts views, and the API `GET …/hosts/:id/images`, `POST
…/hosts/:id/recipes/:recipeId` (`RecipeAction`), `POST|GET|DELETE
…/hosts/:id/downloads` (`DownloadInput`), `GET …/hosts/:id/hub/files`,
`GET|PUT|DELETE …/hub-tokens` (`HubTokenInfo`).

- **Image models** (`models/images`): header facts "<n> models (recipes) ·
  <p> parts on <h> hosts · <g> groups"; in the header a warn pill link
  "<n> to review" when proposals exist, and the action **Download model**
  (to the Download image model page). A segmented **Models** | **Parts**,
  the search box (label "Search image models", placeholder "Search by
  name or file") and architecture chips (**Any architecture** then one per
  architecture the hosts report).
  - Models: a row per recipe as Text models' rows (star, name, pills "to
    confirm" / "parts missing" (warn) and New, facts "<architecture or
    cloud> · <capability words> · group of n | n copies · built on <base>
    · <hosts>"), opening to one **copy block** per host: head "<host>",
    cap "template <t> · <defaults>", actions **Add a part** and, when Lyrica
    downloaded it, the danger **Delete**; for a proposal instead the
    primary "Download the missing parts (<GB>)" or **Use this recipe**,
    and **Ignore**, with the meta line "Lyrica found the diffusion model in
    the shared folder. It needs these parts before it can run." or "Lyrica
    found these files in the shared folder and matched them. Nothing runs
    until you confirm." Then a `partrow` per part: role (Checkpoint,
    Diffusion model, Text encoder, VAE, LoRA; a slot or "strength 0.8" in
    small), `code.raw` file, cap "<precision> · downloaded by Lyrica |
    shared folder · also used by <names> · used instead of the checkpoint's
    own <role>", the size, and **Change** (encoders and VAEs; becomes a
    select of the host's matching parts with a last option "Download
    another…") and **Remove** (LoRAs and added parts). A missing part is a
    row with "Missing on this host" in warn text. A cloud image model's
    detail is one line: "Runs on <endpoint>: there are no parts to manage.
    Portrait photos go to it only as your setting allows." Lineage:
    "<base link> with a LoRA built in. Its results differ, so it's a model
    of its own, linked to its base."
  - Parts: chips Checkpoints, Diffusion models, Text encoders, VAEs, LoRAs,
    Unused files, each with its count in `.num`; a row per file (mono
    name, "<host> · <architectures> · <precision> · <GB> · downloaded by
    Lyrica | shared folder · trigger “<word>”", cap "Used by <recipe
    links>" or "Not used by any recipe"), the danger **Delete** only for a
    file Lyrica downloaded that nothing uses. Empty: "Nothing here."
  - **Add a part** is a dialog: h2 "Add a part to <name>", a segmented
    control of the roles the recipe can take (LoRA always; VAE and Text
    encoder for a checkpoint without one), a radio list of matching files
    on that host (raw name, trigger word, size) or "No <role> for <arch>
    on <host> yet.", the line "Need another? Download one from the Image
    models page." with Download one a link, for a LoRA a **Strength**
    range 0–1.5 step 0.05 with its value in `.num` and the check "Save as
    a new model, keeping <name> as it is"; Cancel and the primary **Add**.
  - **Delete** (a recipe) is a dialog: "Delete <name> from <host>?",
    "Deletes <files>, which frees <GB>." then "Keeps <files> (<recipes>
    use it | not Lyrica's)." and the uses line as Text models; Cancel and
    the danger primary **Delete** (`RecipeAction` delete).
  - **To review** (`models/images/review`): facts "Image models (link) ·
    <n> found on your hosts"; search, chips **All <n>** / **Ready** /
    **Parts missing**, the architecture chips; a toolbar (role toolbar,
    aria-label Selected) with **Select all** (a checkbox; "Select all <n>
    shown" when paged), "<n> selected", and the buttons **Use <n> ready**
    (primary), **Download parts (<GB>)** and **Ignore**, disabled until a
    choice; rows grouped by host with an eyebrow "<host> · <n>", each a
    checkbox (aria-label "Select <name>"), the name with the pill "ready"
    or "<n> parts missing · <GB>", facts "<arch> · <capability> · <main
    file> with <other files>", the action **Use** or **Download parts**
    and a ⋯ menu with **Details** and **Ignore**; 50 a page with **Show
    <n> more of <m>**. Empty: "Nothing to review." This is the one place
    with checkboxes: Li's rule against them is for settings lists, and
    bulk review needs a selection; say so in the PR.
  - **Download image model** is a page (`models/images/download`, Back to
    where it came from): **Download to** (a select of hosts, "<host> ·
    <GB> free"), a segmented **Starter recipes** | **Hugging Face** |
    **Link** | **Scan folder**. Starter recipes: cards per starter the
    host offers with its parts and total size, parts already on the host
    marked "already here" and not counted; Hugging Face: Repository +
    **Look up**, then the file list as the text page (checkboxes here are
    file picks); Link: "Link to the file" and "SHA-256, if the page lists
    one"; Scan folder: **Scan now**, then what it found as To review rows.
    The primary **Download**, Cancel.
- **Downloads** (`models/downloads`, with a count on the subnav link while
  anything runs): header facts "<n> running | Nothing running · <m>
  finished", actions **Download text model** and **Download image model**.
  Section Queue with **Clear finished** (a link) when anything finished;
  eyebrows In progress and Finished; an item: "<label>" bold, "from <source>
  to <host>", a progress bar (role progressbar) with "<phase> · <GB> of
  <GB>" in `.num` and **Cancel**; finished: "✓ Checksum matches" (ok) or
  "Unverified: no checksum given" (warn) · <GB> · Ready · "in the group
  “<g>”" or the link "Add to the group “<g>”"; cancelled: "Cancelled.
  Nothing was kept."; a deletion: "deleted from <host>", "<GB> freed. Lists
  that named it skip it." Empty: "No downloads yet. Start one from a
  library's Download model button, or here." The list is `aria-live`
  polite and polls `GET …/downloads` every 2 s while anything runs.
- **Download text model** is a page (`models/downloads/text`): **Download
  to** (hosts with free space; "This host is paused. Downloading doesn't
  use the GPU, so it still runs." when paused), a segmented **Hugging
  Face** | **ModelScope** | **Link**; Repository (placeholder
  "unsloth/Qwen3.8-27B-GGUF, or the page's link") + **Look up** (`GET
  …/hub/files`), then a radio list **File to download** (label, note such
  as "the usual choice", pills "already on this host" / "not enough
  space", size), the gated banner ("Gated on Hugging Face. Using your saved
  token (••••<last4>). Accept the model's licence on Hugging Face first."
  or the token field "Access token" with "Save it for next time"), the
  refused line from the host; Link: "Link to the file", "SHA-256, if the
  page lists one". Errors as the mockup words them ("That isn't a
  repository. Use owner/name, or paste the page's link.", "Look up the
  repository first.", "Choose a file.", "This repository needs a token.",
  "Not enough space on <host>.", "Use an https link to one .gguf or
  .safetensors file."). Primary **Download**, Cancel; a started download
  goes to the Downloads tab.
- **Accounts**, a section at the foot of Downloads: a row per hub (Hugging
  Face, ModelScope): "Token saved · ••••<last4> · every user | only you" or
  "No token", with **Replace** and the danger **Remove**, or **Add token**;
  editing is inline: "Access token (read-only is enough)", a segmented
  **Only you** | **Every user** (administrators), Save and Cancel.
- Phone: rows stack; the toolbar wraps; pages are full width.
- docs/ux.md: §4 names for the controls above; §6 rows "Image models,
  recipes and parts", "Downloads and hub accounts". The README line for
  image model management moves.
- Tests: the e2e has no host, so Image models and Downloads are checked
  with a fake host answer in `web/e2e/serve.ts` (one recipe, one proposal,
  one download in progress) and by hand on Li's host; vitest for the
  download item wording.

### Copy on code blocks (pre-deployment batch)

Messages render with react-markdown; fenced code is a `pre > code` the app
mockup doesn't draw (its only Copy is the message-level one). Design:

- A fenced block gets a header strip inside the block's top edge: the
  language name on the left as a cap in mono when the fence names one
  (nothing when it doesn't), and a **Copy** text button on the right in the
  message actions' look (12 px, muted, no border until hover), always
  visible, 44 px touch target on coarse pointers. Copying puts the block's
  text on the clipboard and swaps the label to **Copied** for 2 s, no
  toast (the message-level Copy keeps its toast; two toasts for one
  gesture would read as a bug). `aria-label` "Copy code" and "Copied".
- The block itself: 12 px/1.5 mono, the tool background, 8 px radius,
  `white-space: pre`, horizontal scroll inside the block only; the header
  strip stays put while the code scrolls.
- Tool-call results and the permission card's `pre` keep no Copy (a
  result is read, not reused); the Files viewer gets none either.
- docs/ux.md: §4 names Copy code, Copied; §6 row "Code in a message"; a
  §2 note that Copied is the one button whose label changes to show a
  result (like Stop reading), not a caption.
- Test: a vitest on the renderer (a fenced block with a language renders
  the strip; one without renders no language) and an e2e step in the
  message actions test (the fake model echoes a message with a fence; Copy
  code → clipboard permission granted in Playwright → the textarea gets
  the pasted text, or read `navigator.clipboard.readText()`).

### Message-text search (pre-deployment batch)

The sidebar's Search (Shell.tsx:397, placeholder "Titles") searches titles
in the browser today. The mockup's stub says "Search titles and messages"
with radios All threads / Pinned messages / Hidden threads. Design:

- API: `GET …/search?q=&pool=&limit=&before=` → `{ hits: SearchHit[] }`,
  `SearchHit { threadId, pool, title, n, who: "you" | "agent" | <display
  name>, snippet, at }`, from the FTS index recall already keeps, over
  the user's own pools only, hidden pools included only when the Sort
  menu shows them (the query takes `pool` list from the display setting;
  the server refuses a pool the user can't read). Snippets are the
  matched sentence with the match marked by the server (`[[` `]]`), never
  more than 160 characters, so the browser renders the mark and no message
  text is logged. 50 hits a page, newest first. Contract change in
  docs/contracts.md (the search route and the index it reads).
- UI: the search box keeps its place; placeholder "Search titles and
  messages". While the query is empty the list is the thread list as
  today. With a query of 2+ characters: titles match at once (as now) and
  after 300 ms the server's hits arrive; the list becomes result groups,
  one per thread in hit order: the thread row as the sidebar draws it
  (pool mark, title, time), then under it up to three hits as one-line
  rows: the who in mono small, the snippet with `<mark>`, the time in
  mono; a fourth line "<n> more in this thread" opens the rest in place.
  A hit row opens the thread at that message (the existing jump, the
  message briefly highlighted). Empty: "Nothing matches." Below the
  groups, "Hidden threads aren't searched. Turn on Hidden in the Sort
  menu to include them." only when a hidden pool exists. Escape clears
  the query. The radios from the mockup are not built: pinned messages
  have the header popover, hidden pools follow the Sort menu.
- Phone: same, in the slide-over sidebar.
- docs/ux.md: §4 names Nothing matches, more in this thread; the §6 row
  "Finding a thread or a message" (replace the titles-only wording).
  README's "message search" line moves.
- Tests: a daemon test for the route (own pools only, hidden pool
  excluded unless asked, snippet cap, no match text in logs) and an e2e
  step: send a message with a rare word, search it, the hit row opens the
  thread at that message.

### Images (after the Images back end)

DESIGN.md "Images" and the app mockup's Files and Images panel. The back
end (`image` tool, ComfyUI through the host, portrait photos store) is not
built; the API below is what the web needs from it, to agree in
docs/contracts.md with the Images thread before this PR.

- **Inline images** (built in PR 8 for files she names): a message part
  `{ type: "image"; path; alt; made?: { by: "fast" | "quality"; model } }`
  renders the thumbnail at up to 320 px wide, 8 px radius, the alt as its
  accessible name, a cap line under it "Made with <model> · fast | quality"
  (facts, not a caption) with a ⋯ menu Download, Copy path, Show in
  Files, Edit… (opens the composer with "Edit <path>: " filled, the
  Images switch on). A tap opens the existing Lightbox (mockup: filename
  header, ⋯ with Download and Copy path, ✕; no prev/next).
- **Progress while one is made**: the tool-call marker for `image` reads
  "Making an image · fast | quality" with the running dot, then, when the
  host reports steps, "step <n> of <m>" in mono after it; no progress bar
  (the marker is the one running indicator in a message). When it fails,
  the marker's error text is the host's reason.
- **Portrait photos** (Settings → Portrait photos, last in the list, as
  the mockup): a card with the pill "<n> photos", a grid of square thumbs
  (minmax 132 px, 12 px gap, filename cap in mono) with a ⋯ per photo
  (Download, Delete…) and the secondary **Add photos** (file picker,
  images only, several at once); the select **Sending them to a cloud
  image model** with Ask once a day (default), Never, Always, saved at
  once; the tooltip on the select (not a caption): "The first time a day
  one would go to a cloud model, she asks first. A yes lasts until the end
  of that day." Empty: "No photos yet." API: `GET|POST|DELETE
  …/me/photos[/:id]`, `PATCH …/me/display` gains `photosToCloud:
  "never" | "ask" | "always"`; the photos live in the user's encrypted
  home, served through the Files route's protections.
- **The ask**: the existing permission card worded "Send your portrait
  photos to <model> (cloud) for this image? A yes lasts until the end of
  the day." with **Send today** primary and **Not today**.
- **The Images switch** in the composer's "+" menu (built with Modes)
  gains the tooltip "Lets the agent make and edit images in this thread."
- docs/ux.md: §4 names Add photos, Send today, Not today, Edit…, Making an
  image; §6 rows "An image the agent made" and "Portrait photos".
- Tests: e2e with a fake `image` tool result (the fake model can emit a
  tool part): the inline image, the lightbox, the Edit… prefill; the
  photos page with an upload and the setting; a daemon test that a photo
  never reaches a cloud call when the setting is Never.

### Pin in the remaining places

Built: the thread menu's Pin/Unpin (sidebar), the Pinned group at the top
of the list, the message Pin/Unpin in the message menu, the pinned badge,
the header's "<n> pinned ▾" popover. Remaining, per the mockup:

- The thread header's ⋯ menu (and the panel's breadcrumbs menu) gets
  Pin/Unpin for the thread itself, the same `PATCH …/threads/:pool/:id`
  `{ pinned }` as the sidebar menu, with the toasts "Pinned to the top" /
  "Unpinned".
- The project chat's thread cards get Pin/Unpin in their ⋯ menu (a child
  pinned there sits first among the project's threads in the sidebar, and
  the Pinned group at the top is for top-level threads only, as today).
- The Search results (above) show pinned messages with their badge.
- No ux.md change beyond the §6 row's list of places.

### The speech drawer in the remaining places

The speaking model's Settings drawer (VoiceDrawer in Models.tsx: a voice
per language, speed, source words, Reset) opens from an endpoint's model
list. Remaining: the same drawer from Text models' copy rows for a
speak-capable copy (PR C above) and from the thread drawer's Read aloud
select (a small Settings link after the select, opening the drawer for the
chosen model, or the profile's when none is chosen). No new strings;
docs/ux.md §6 "Dictation and Read aloud models" lists the third place.

## Handoff notes

(The thread fills this in if it stops before it's done.)

- 2026-10-11, PR 1 (look and shell): done: fonts, icon set, sidebar with
  Sort menu (sorts, groups, pool checkboxes), thread menu, Settings and
  Administration pages with section lists, header with version and build,
  home message box; back end for groups, unread, sort, version. Next, each
  as its own PR: Files & Images panel (needs the Workspace API for
  listing), Notifications page and Share with, Pin (after the Projects back
  end's pins), the speech Settings drawer into the Models area, the Models
  page, the Sleep section. Open: the mockup's Sleep and Models sidebar links
  come with their parts.
- 2026-10-11, PR 2 (Projects web part 1): the project chat, its cards and
  the Project settings page, per docs/briefs/projects-web.md. Next: the
  split-view panel settled with UI review (third column from 1180 px, 360 to
  520 px, 420 to start, dragged divider, width kept per browser; anything
  looked at without leaving a conversation opens in it: the project's
  Overview, Threads, Settings and Files, a thread from a card, a mention or
  the Threads popover; breadcrumbs, Expand and Close; Esc closes; below
  1180 px the same address is the full page), then the Files panel, the
  Watching threads switch and markers once #97 lands, Notifications, Pin
  in the remaining places, the Models page and the Sleep section.
- 2026-10-11, PR 3 (the panel): done as settled: the third column, the
  divider, breadcrumbs, Open as a page and Close panel, the address carrying the panel,
  the page on its own below 1180 px (docs/web.md "The panel"). The Files
  panel becomes this column when it comes; a project's Overview and Threads
  as pages wait for a design.
- 2026-10-11, PR 4 (Watching threads): the switch on Project settings and
  the "Checked the other threads" marker, after #97 and #110.
- 2026-10-11, PR 5 (Li's ask): messages from other threads collapse to one
  line, "Message received from <thread>", and expand on a tap; the rule is
  in docs/ux.md §6.
- 2026-10-11, PR 6 (Files panel, back end): `Workspace.files(t)` and the
  `…/files` routes (docs/daemon.md "Files"): listing one folder at a time
  with the roots, search, images, content with a no-run CSP, upload, folder,
  rename, delete, zip streamed from the sandbox, and the one-line note to her
  about what the panel changed. No thumbnails yet (the panel shows the image
  itself; a thumbnail route waits for an image library). Next: the panel
  itself.
- 2026-10-11, PR 7 (Files panel, the UI): `web/src/Files.tsx` and the
  `files` route and panel kind (docs/web.md "The Files panel", docs/ux.md
  §6; Show in thread finds the first message naming the path, on Li's ask).
  Not built: thumbnails.
- 2026-10-11, PR 8 (files in the conversation, Li's ask): `web/src/paths.tsx`;
  a `/workspace` path in a message links to `…/files/<encoded path>`, which
  shows the file; her images from the thread folder show in the message and
  open large (docs/web.md "Chat", docs/ux.md §6); her prompt says so.
- 2026-10-11, PR 9 (thumbnails, Li's pick): `ThreadFiles.thumb` runs
  ImageMagick inside the sandbox and keeps the copy under `.lyrica/thumbs`,
  gone with the image on delete or rename (Li's rule); `GET …/files/thumb`
  (docs/daemon.md "Files"); the Images grid and inline images use it and
  fall back to the image itself; `imagemagick` joins the NixOS sandbox tools
  and the Debian install. Not done: a grant-less sandbox for the thumbnail
  run (PR review's suggestion; `ThreadFiles` gets the thread's box) and a
  replaced-by-older image, which `-nt` misses. Next: Notifications, Pin in the remaining places,
  the Models page (carry the Fallback default), the Sleep section; Web:
  bootstrap on Li's go.
- 2026-10-11, PR 10 (Li's asks): the user menu says Lock and Log out;
  Administration → Users gets Change password…, backed by a recovery copy
  of each user's key in `self.db` (DESIGN.md "Users" and "Storage",
  contracts core/users; Li chose this over a reset that loses data). Nothing
  for sleep or the pools changes; the privacy boundary note is in DESIGN.
- 2026-10-12, PR 16 (drafts): the composer's unsent text is a draft on
  lyricad per thread (`GET|PUT …/threads/:pool/:id/draft`, pool schema
  step 3, cleared by a successful send), never in browser storage (Li's
  pick, principle "No plaintext memory"). Next in the pre-deploy batch:
  context meter, Copy on code blocks, message-text search in Search.
- 2026-10-12, PR 15 (Tasks): the Tasks tab in `src/Models.tsx` (kept
  there to avoid a circular import with `Frame`), Settings → Model profiles
  removed and Settings → Sleep added for the mode select and Sleep
  fallback; `settings/profiles` redirects to `models/tasks`. The e2e Tasks
  test adds a manual `cloud-mini` model on `router` through the API and
  runs last, so the Models test's model count holds. Next: Text models
  with the copy Settings drawer and Serving rows, Image models, Downloads.
- 2026-10-12, PR 14 (Models area, part one): `src/Models.tsx` with the
  area's shell and tabs Overview, Hosts and endpoints, Clean up, Recent
  calls; Settings → Endpoints removed (its address lands on the hosts tab;
  the speaking model's Settings link lives in an endpoint's model list).
  Not yet: Tasks (replaces Model profiles; carry `watching` from #156),
  Text models with the copy Settings drawer and the Serving rows of
  docs/briefs/context-stretch.md item 8 (#157 is on main), Image models,
  Downloads. The badge reads `models/cleanup` so no tab probes endpoints
  on a timer; `models/page` is read only while the area is open. No model
  host was available in e2e, so the host card and Add model host are
  checked by hand on a real host.
- 2026-10-12, PR 13 (the Sleep section): `src/Sleep.tsx`, the sidebar link
  with its badge, the Sleep mode select (then in Settings → Model profiles, now Settings → Sleep), the
  administrator's Sleep section moved into the same file (docs/web.md, ux
  row "What she did at night"). Memory links open the Memory page, not the
  panel: the panel exists only beside a thread. Next: the Models page (carry
  the Fallback default), Pin in the remaining places, the speech drawer.
- 2026-10-12, PR 12 (the rest of the queue in one PR, Li's ask): the
  password follow-up (the administrator's own password, the user logged
  out); reactions on messages, hers too (DESIGN.md "Reactions",
  docs/daemon.md, docs/web.md, ux row "Reacting to a message"; pool schema
  step 2 adds `entries.reactions`); the setup page, her name and the Tailnet
  section (web-bootstrap.md); the Updates section (web-updates.md); Direct
  and Tailnet as Web access modes. Next: the Models page (carry the
  Fallback default), the Sleep section, Pin in the remaining places, the
  speech drawer.
- 2026-10-12, PR 11 (Notifications and Share with): `thread_shares` in
  `self.db` holds a sent copy until the recipient adds or declines it;
  `GET …/notifications` lists what waits (docs/daemon.md "Share with and
  Notifications"); the sidebar count, the welcome card and Settings →
  Notifications (docs/web.md). Not in the list yet: downloads, clean-up,
  image models to review, host problems, which come with the Models page.
  Next: Pin in the remaining places, the Models page (carry the Fallback
  default), the Sleep section; Web: bootstrap once the daemon API is pushed;
  the Updates page after releases.
