# Clicking through web pages

**Status:** Merged as #934 (9905e0c).

The owner's decision (2026-11-10): she should be able to click through
web pages. Today `web_fetch` reads one address and nothing else, so a page
that needs a click, a field filled in, a login or several steps is out of
her reach unless she writes a Playwright script by hand in `bash`.

Principles: 1 (the user notices it the first time a page needs a click),
3 and 8 (one tool, on the Chromium and DevTools pipe `web_fetch` already
uses, no new package or process type), 2 and 6 (what asks is decided by
the page's structure in the driver and the `tool_call` hook, never by her
prompt).

## What is built

1. **One tool, `browse`**, behind the Web search switch with
   `web_search` and `web_fetch`, in a conversation, in a project chat,
   and in a subagent whose role lists it (the researcher, beside
   `web_fetch`; a role of the user's own can list it). Project chats and
   subagents were left out at first; the owner asked why on 2026-11-11
   and there was no good reason, since both have `web_fetch`. A
   subagent's browser and profile are its own: it has none of its
   parent's logins, a form it would send asks in both threads as its
   other approvals do, and its browser closes when it ends. She had exactly 30 tools (23 in a
   conversation, 6 only in sleep, `ask_parent` only in a subagent), so
   this is the 31st. The owner raised principle 8's budget to 50
   (2026-11-10).
   `browse({ action, url?, ref?, text?, submit?, direction?, offset?, path? })`,
   actions `open`, `read`, `click`, `type`, `select`, `attach`, `scroll`,
   `back`, `screenshot`, `close`.
2. **How she picks it.** The two descriptions say so and nothing else
   does: `web_fetch` reads a page whose address she has; `browse` is for
   when reading isn't enough (a click, a field, a login, several steps,
   or a page that comes back empty because a script draws it). The
   sandbox's tools line no longer names Playwright for "clicks, several
   pages", which sent her to a script of her own instead (2026-11-11). She
   still never reached for it when a site refused `web_fetch` (a 403 from a
   review site), so both descriptions name a refused fetch (401, 403, 429)
   as browse's, and that failure itself says to open the address with
   `browse` (2026-11-11, later). Anubis's check page counts as refused,
   and `browse` waits up to 30 seconds for the check to load the real
   page by itself (the owner, same day).
3. **A page as text with numbers.** Every action answers with the page as
   it is now: its text in reading order, each thing she can act on (link,
   button, field, checkbox, select) on a line of its own with a number,
   `[12] link "Docs"`. She acts by number, so a model without vision can
   use it. A password's value is never read back. A long page is cut and
   `read` with `offset` goes on. The text is outside content, between the
   same markers as `web_fetch`.
4. **`screenshot`** returns the visible part as an image, the same way a
   `read` of an image file does, so a model without vision is told it
   can't see it and the Look at images list applies.
5. **One browser per thread, in its sandbox.** A driver script
   (`core/src/browse.cjs`) runs on the sandbox's node and drives its
   Chromium over the DevTools pipe; `lyricad` talks to it over the
   process's stdin and stdout. It reaches the network only as the thread's
   switches and allowed hosts let any sandbox command. It holds one of
   the thread's background slots (it shows in `jobs`, and `stop` ends it)
   and closes after 10 minutes unused.
6. **A profile that lasts.** Chromium's profile is the thread's own
   folder in the user's encrypted home (`browser/<thread>`), mounted only
   into that thread's browser run, so a login outlasts the browser's
   idle close and a restart. The driver keeps the cookies in a file there
   after each action and gives them back at the next start. The sweep
   removes it with the thread.
7. **What asks first, in every mode.** Sending a form: a click on a
   form's submit control, or `type` with `submit` in a form's field. The
   card names the site and shows what would be sent, passwords as dots.
   A form that only searches (sent by GET to a stated address, or marked
   as a search, with no password, file or long text field) doesn't ask.
   Nor does a posted form whose only thing to fill in is one plain text
   box (the owner, 2026-11-11, after DuckDuckGo's plain page asked for
   each search): a one-line comment or chat box goes the same way. One
   that says it deletes or removes still asks (the owner, 2026-11-11: a
   "type DELETE to confirm" box is one text box too). It is read from
   the form's buttons, the box's name, where it goes and a hidden
   `_method`, in English only.
   The driver decides this from the page, the hook asks, and the driver
   acts only with the hook's go-ahead for that call. Behind it, a page
   load that posts without a go-ahead is stopped in the browser and
   nothing is sent; the same click then asks.
8. **Modes.** Plan mode leaves `open`, `read`, `scroll`, `back` and
   `screenshot`. Ask and Accept edits ask before `click`, `type` and
   `select`, as before a command. Auto doesn't, apart from (7).
9. **The guarantee, in one sentence** (principle 7): sending a form and
   any page load that posts always ask, except a search and a form that
   is one plain text box; a plain click can still make a
   page's own script send something, as a command she runs in the
   sandbox can.
10. A download is saved in her `downloads/` folder (the owner, 2026-11-11;
    first built refused); a file of hers can be attached to a file field,
    asking first in every mode (the owner, same day); pages she browsed
    show in the Sources row under her reply (the owner, same day); and what
    is inside a frame is read where it stands, and used under the same
    rules (the owner, 2026-11-11: "this would break a lot of website
    contents"; first built without).

## Not built, on the owner's word

- **CAPTCHAs** (the owner, 2026-11-10): she is given no guidance about
  them, in the tool, its results or her prompt, including none to hand
  one to the user. Nothing solves one. Two exceptions, both the owner's
  (2026-11-11): Anubis's proof of work, which browse waits out and
  web_fetch calls refused; and, only while an administrator turns on
  **Tick bot checks** (off by default; the owner means it for sites of
  their own), a line after a browse page that shows a check box naming a
  robot, human or bot says she may tick it.

## Open for the owner

- Whether clicks and typing on a site where she is logged in should ask
  once per site and thread, on top of (7). Built without it: Auto mode
  works freely, as her commands do.

## Out of scope

A screenshot shown in the tool
marker, stored website passwords, several
tabs (a link that opens a new tab opens in the same one), a visible
browser the user can watch or take over.

## Handoff

Done: everything under "What is built", merged as #934. PR review left one
optional note, not built: the user's yes is for the tool call, not for the
exact form the card showed, so a page's script could change the form
between the card and the click; binding the yes to a digest of the form
would close that. The dev deployment's test (2026-11-11, 16 steps on a variety of sites)
found three things, fixed after it: a login lost after `close`, a doubled
colon on the card when a field's label ends in one, and a first `open`
failing once with a network-changed error (now tried once more). The lost
login wasn't reproduced outside that deployment, so it wants a retest
there. A search form that posts (DuckDuckGo's plain page) asked; the
owner chose that a posted form of one plain text box goes without
asking (7). Open
question: the one under "Open for the owner".
