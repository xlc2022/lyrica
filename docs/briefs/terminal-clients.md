# Brief: `lyrica chat` and `lyrica mem`

**Status:** draft. Not built. The user answered (2026-11-07): build it
now, keep the terminal's threads separate, add Forget a topic to `mem`,
and choose who may run it from the options under A.

**Branch:** `feature/terminal-clients`, once the brief is agreed.
**Read first:** AGENTS.md, PRINCIPLES.md (2, 8, 10), DESIGN.md ("One
command, `lyrica`", "Each interface keeps its own threads"),
docs/contracts.md (Interface, Local socket, the thread and memory routes),
docs/daemon.md ("Starting and unlocking", "Logging in", "The event stream",
"Memory browser and settings"), docs/memory.md ("Editing memories",
"Deletion", "Export and import").

## Goal

Two terminal clients of a running `lyricad`, under the existing `lyrica`
command. DESIGN.md has reserved both names since the start:

- **`lyrica chat`**: talk with her from a terminal on her machine, for a
  user who is already in a shell there (over SSH, say) or when the web
  front door is down.
- **`lyrica mem`**: search, read, correct and remove memories at the
  prompt, as the web's memory browser does.

Principles:

- **10.** A terminal is its own room. `lyrica chat` threads are the `cli`
  interface, which the contracts already name; they are not web threads
  shown in a terminal. She is continuous across the two because she
  remembers. Principle 10 also says the next interface starts only once
  the previous one works well; the user judged the web ready for it.
- **2.** Both are clients. They hold nothing: no session file, no
  history file, no cache, no temp file. Memory and thread text pass
  through the process and the terminal, and nothing else.
- **8.** No new long-running process, no new dependency, no new
  model-facing tool, no new slash command. Both exit when the user is done.

## In scope

**A. Reaching `lyricad` and signing in** (shared by both commands).

- Connect to `<runtime>/lyricad.sock`. It serves the same API and no
  subcommand uses it yet. `--runtime <dir>` picks another runtime, as
  `serve` does. Who may connect is the open choice below.
- **Who may run it.** Being on the machine is never enough to get in:
  every option still asks for the Lyrica user's password. What differs is
  which machine accounts get as far as the password prompt. Note that the
  loopback port 7340 already answers every local account, so any of them
  can already try a password there, under the same rate limits.

  | Option | Who reaches the prompt | Cost |
  |---|---|---|
  | **a. Service user only** | root, or `sudo -u lyrica lyrica chat` | Nothing to build; the user needs sudo every time |
  | **b. A group on the socket** (recommended) | Accounts the operator adds to a `lyrica-clients` group; the socket becomes `0660` with that group | install.sh and the NixOS module make the group (empty by default); one line in the getting-started guide |
  | **c. Loopback** | Every local account, through `127.0.0.1:7340` | Nothing to build; no way to narrow it |
  | **d. Another machine** | Anyone who can reach her HTTPS front door (LAN, tailnet) | A login flow that works without a browser, and the front door's own rules; a later brief |

  The machine account is never mapped to a Lyrica user (no peer-credential
  sign-in): the password decides who you are, as it does on the web, so a
  shared machine account can't open someone else's memory.
- Sign in with `POST /api/login`: the login name as an argument or a
  prompt, the password only at a hidden prompt, never as an argument or
  environment variable (DESIGN.md's rule for every `lyrica` subcommand).
  The session cookie stays in the process's memory and is gone when it
  exits; `POST /api/logout` on a clean exit.
- Each request sends an `Origin` that matches its `Host`, so the existing
  same-origin check passes without a special case.
- A locked or still-setting-up `lyricad` gets its own one-line answer
  (where to unlock), and the command exits non-zero.
- The rate limits, Lock and logout already apply, since this is the same
  login route.

**B. `lyrica chat`.**

- `lyrica chat [--private]` lists the user's recent `cli` threads in that
  pool (General by default) and offers a new one; `lyrica chat <id>`
  opens one. A new thread is created with `interface: "cli"`.
- The prompt sends a message and streams her reply from the thread's
  event stream: text as it comes, reasoning folded to one line, one line
  per tool call (its name, then whether it ended well), recall shown as a
  count, errors in plain words.
- Permission requests and question cards are answered at the prompt
  (a numbered list of the options). Ctrl-C stops the turn; Ctrl-D or
  `/exit` leaves.
- Terminal control characters in her text and tool output are stripped
  before printing, as the sandbox does for command output.
- No local history: Node's readline keeps its in-session history in
  memory only, and nothing is saved.

**C. `lyrica mem`.** Subcommands over the memory browser's routes, which
go through `openOwnerView` already:

| Subcommand | Route | What it does |
|---|---|---|
| `lyrica mem search <words>` | `GET …/memory/search` | Matches, newest first, one line each with its ID |
| `lyrica mem show <id>` | `GET …/memory/:pool/:id` | The text, with names in place of mention tokens, and where it came from |
| `lyrica mem history <id>` | `GET …/memory/:pool/:id/history` | Its revisions |
| `lyrica mem edit <id>` | `PATCH …/memory/:pool/:id` | Corrects it as a new revision |
| `lyrica mem restore <id> <rev>` | `POST …/restore` | Brings back an earlier revision |
| `lyrica mem archive <id>` / `delete <id>` | `POST …/archive`, `DELETE` | Two of the four deletion levels, each confirmed with y/N |
| `lyrica mem note` | `POST …/memory/:pool/notes` | A note of the user's own |
| `lyrica mem forget <words>` | `GET …/memory/search`, then `POST …/memory/:pool/forget` | Forget a topic: lists the matches, the user picks which go (all, none, or numbers), then confirms once |

- **Editing never touches disk.** There is no `$EDITOR`, since an editor
  needs a temp file. The edit is a line editor in the terminal, prefilled
  with the current text; mention tokens show as `{Name}` and are saved
  back as tokens, as the web editor does.
- **Forget a topic** deletes for good, as on the web: each removed memory
  leaves a tombstone, and pages that cited it are flagged for the next
  sleep. The confirmation names how many memories go.
- **Export** (`lyrica mem export <ids…>`) prints Markdown to standard
  output and never writes a file itself. Where it goes after that is the
  user's choice, as with a download from the web.
- `--private` picks the Private pool, as in `chat`.

**D. Tests** (what the user would notice):

- Sign-in over the socket, and the refusal when the socket isn't
  readable.
- A `cli` thread made by `lyrica chat` doesn't appear in the web's thread
  list, and the reverse.
- A memory edited with `lyrica mem edit` keeps its mention tokens and
  shows as a revision in the web.
- `lyrica mem forget` removes only the matches the user picked, and leaves
  tombstones.
- Neither command writes a file anywhere (run with a fresh `HOME` and
  temp folder, and check both stay empty).

## Out of scope

- Moving a thread between the web and the terminal (an explicit export,
  per principle 10, and a separate brief).
- Forgetting a thread from the terminal; the web keeps that one.
- Using it from another machine (option d) in this build.
- Images, uploads, voice, projects and subagent drawers in `chat`.
- Pi's own terminal interface: it writes plaintext session files, which is
  why only `lyrica dev` uses it, against test data.

## Contract changes this needs

- `NewThread` gains `interface?: "web" | "cli"` (default `web`), and
  `GET …/threads` gains `interface=` (default `web`), so each room lists
  its own threads.
- docs/contracts.md "Local socket" stops saying no subcommand uses it.

## Docs the build updates

DESIGN.md (the `lyrica` table gains `chat` and `mem`, and drops "reserved
names and not built"), README (its "Not built yet" line), docs/contracts.md
(above), docs/daemon.md (the socket's clients), docs/memory.md (the
terminal as a second way to edit), the getting-started guide (one
paragraph, through Operator docs), and this brief's status.

## Open question for the user

**Who may run it** (A): options a to d. Answered so far: build now,
separate `cli` threads, and Forget a topic in `mem`.

## Handoff

- **Done:** this draft, with the user's answers to three of its four
  questions.
- **Next:** the user's choice of who may run it, then a build on
  `feature/terminal-clients` with PR review (it touches `bin/` and the
  daemon's routes).
