# Brief: Web: bootstrap (the setup page, her name, the Tailnet section)

**Thread:** Web UI 2. **Branch:** `feature/web-bootstrap`. **Model:**
Fable. **Depends on:** Bootstrap ([bootstrap.md](bootstrap.md)) for the
API; the page can be built against the interfaces in `daemon/src/api.ts`
as soon as they are agreed, and merges after Bootstrap.

**Read first:** docs/ux.md (every time), docs/web.md, DESIGN.md "Storage,
encryption and unlocking" and "Runtime" (Reaching the web UI),
`/mnt/project-files/bootstrap/proposal.md` §2, §3 and §6, and the app
mockup (https://claude.ai/artifact/96BoPXPoxL2LDBg8eLxjHx). UI review as
for every UI change; the design plugin's skills apply.

## Goal

The first thing anyone sees of her is one calm page that ends with an
address that works from a phone (principle 1), built from the parts that
exist: the Gate layout, steps as sections with eyebrows, the three button
looks, the drawer and the dialog (docs/ux.md §1.4).

## In scope

1. **Set up Lyrica** (`web/src/Setup.tsx`), shown in the unlock page's
   place while `State.setup` is true: one h1, steps as sections with
   eyebrows, the current step's button the one primary, a done step's
   secondary, Skip as a link on the optional steps, no captions
   (explanations are tooltips), the code, addresses and names in mono.
   | Step | Controls | Primary |
   |---|---|---|
   | Code and passphrase | Code; Passphrase, Repeat; the **Start unlocked** switch (disabled with the reason as its tooltip where `credentials.available` is false) | Continue |
   | Lyrica | Name (default Lyrica) | Continue |
   | Administrator | Login name, Password, Name, Pronouns (the segmented control from Settings → Profile, Custom reveals the five forms) | Create (`POST /api/setup`; from here on the page is signed in) |
   | Tailnet | Auth key; Hostname (default: her name, lower-cased); Advanced → Control server; the state as a dot and word once connected, with the tailnet, her address and her DNS name in mono (her own device, beside the host's if it has one); the **Web access** switch, on by default once connected (`PUT …/admin/web-access` with mode `tailnet`; off keeps Direct) | Connect, then Continue; Skip |
   | Models | Kind (Cloud \| Local), Base URL, API key, Name: the Add an endpoint fields, saved shared and put first in the administrator's profile for the main conversation | Add; Skip |
   | Done | Facts: her addresses (the LAN one with its fingerprint while Direct is on; her tailnet name), the administrator's login, the tailnet; one sentence only with Start unlocked off ("She starts locked after each restart; the passphrase unlocks her.") | Start a chat |
   Errors replace the step's estimate line and say what happened, why
   and what to do ("The code doesn't match. It is in the journal:
   journalctl -u lyricad." / "Tailscale isn't installed on this machine.
   Run install.sh again." / "Her tailscaled isn't running: systemctl
   status lyrica-tailscaled." /
   "HTTPS certificates are off in this tailnet. Turn them on under DNS in
   the admin console, then turn Web access on.").
2. **Her name everywhere the UI says Lyrica**, from `State.name`: the
   header's brand and "Lyrica (ver. …)", the page `<title>`, "Unlock
   Lyrica" and its sentence, the author label on her messages, "Lyrica is
   thinking…", the dialog sentences, Web access's legend. One helper, not
   thirty literals.
3. **Administration → Persona** (today's "Persona changes"): **Name** with
   its Save above the list of changes; the Save's one sentence: "Memories
   and threads written so far keep the name <old>."
4. **Administration → Tailnet** (`#/u/<user>/admin/tailnet`, between Start
   unlocked and Web access): a facts line in mono (tailnet, address, DNS
   name, control server when not Tailscale, version; all hers, her own
   device); one state (Connected
   green, Disconnected amber "Disconnected · member of <tailnet>", Not
   installed red with the reason as the word's tooltip, Not joined the
   word alone); **Connect** primary (not joined: a drawer with Auth key,
   Hostname, Advanced → Control server, Connect at its foot; disconnected:
   at once); **Disconnect** secondary while connected, with its dialog
   ("Disconnect from <tailnet>? She can't be reached there until she
   connects again." Buttons Disconnect / Stay connected); **Leave** and
   **Connect to another tailnet** behind ⋯, Leave with its dialog ("Leave
   <tailnet>? Her key there is removed, Web access over the tailnet stops,
   and connecting again needs a new auth key." Buttons Leave / Stay);
   Connect to another tailnet opens the drawer and its Connect shows the
   Leave dialog first, ending "…and she joins the new one with this key."
   The host's own tailnet is not hers, so no sentence mentions the
   machine. When the daemon answers `409` because this page came through
   her tailnet address, the error says so and what to do: "This page is
   reached over the tailnet, so disconnecting would cut it off. Open her
   LAN address and do it there." The same sentence on the setup page's
   Tailnet step when its join would leave another tailnet.
5. **Web access: Direct and Tailnet** as modes next to Off, Built-in
   Caddy and External proxy: Direct's state line shows its addresses and
   the certificate's fingerprint in mono; Tailnet's the DNS name and the
   certificate, as the other modes have.
6. docs/web.md describes the page, the section and the mode; docs/ux.md's
   rows already exist (added with this brief).

## Out of scope

The daemon (Bootstrap); a per-user nickname; the getting-started guide
(Operator docs, told by Bootstrap after its merge).

## Done when

- The ux.md checklist (§10) in the PR, with screenshots at 1280 and 390 of
  the setup page at each step, Administration → Tailnet in each state,
  and Administration → Persona.
- Browser tests: the setup page appears without `self.db` and the home
  appears signed in after Create; the header and the unlock page show the
  set name; Leave asks before it acts; Web access's Tailnet mode shows its
  name.
- UI review and PR review verified; merged after Bootstrap.

## After merging

Tell the Operator docs thread what the page looks like (its steps, in
the guide's words) and the project chat the merge commit.

## Handoff notes

- 2026-10-12 (Web UI 2, the combined PR): built as `web/src/Setup.tsx`,
  `web/src/Tailnet.tsx`, `web/src/name.ts` and the Direct and Tailnet modes
  in `web/src/WebAccess.tsx`; `State.credentials` added for Start unlocked;
  the setup e2e runs its own lyricad with no `self.db`
  (`web/e2e/serve.ts … setup`, `web/e2e/setup.spec.ts`). Docs in
  docs/web.md. Not built: nothing from this brief; the Models step adds one
  endpoint and sets its first chat model, as the brief says.
