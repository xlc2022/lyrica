# Working on Lyrica

This guide is for every contributor: people, Claude, ChatGPT, DeepSeek, and
eventually Lyrica herself. It is never loaded into Lyrica's own conversations.

## Before you start

Read these, in this order:

1. [PRINCIPLES.md](PRINCIPLES.md): the thesis and the ten principles. When two
   conflict, the earlier one wins.
2. [DESIGN.md](DESIGN.md): the current agreed design. Don't reopen a settled
   point without new evidence.
3. [docs/contracts.md](docs/contracts.md): the interfaces between components.
4. Your brief in `docs/briefs/`, if you have one, and the doc for the component
   you are changing.
5. [docs/ux.md](docs/ux.md) before changing anything a user sees. Every new
   control needs a home from its table; a PR that touches the interface
   says which rule each new control follows.

## Rules

- **Name the principle.** Every change says which principle or decision it
  serves. "Closes a theoretical gap" doesn't count.
- **Respect the budgets in principle 8.** Going over one takes an agreed
  change to DESIGN.md, or removing something else.
- **Keep the boundaries structural.** Private memory is reached only through
  `openThreadView`. Model calls go only through `core/models`. Never rely on
  telling the model not to do something.
- **No plaintext memory.** Memory and thread text never reach disk unencrypted:
  no logs of message text, no temp files, no fixtures copied from real data.
- **Docs describe what exists.** When you change behavior, update its doc in the
  same commit. Write plainly and keep docs short. Plans go in briefs, never in
  component docs. If a doc and the code disagree, the PR isn't done.
- **Tests protect what Li would notice:** context assembly, memory round trips,
  the privacy and cloud boundaries, and sleep output. Don't add a test for
  every hypothetical.
- **Deleting code is progress.**

## Workflow

- The design thread owns PRINCIPLES, DESIGN and the contracts. Feature threads
  work on their own branch from a brief and finish with a pull request into
  `main`.
- A pull request description says what changed and why, what is out of scope,
  and any contract change it needs.
- If your context is getting long, stop at a clean point. Write a handoff note
  at the end of your brief (done, next, open questions), push, and let a fresh
  session continue from it.

## Checks

```sh
npm install
npm run typecheck
npm test
npm run evals      # continuity scenarios in evals/; a failure is evidence, not a broken build
```

CI runs on Li's own runner ([docs/ci.md](docs/ci.md)); a job waiting in the
queue means the runner is busy or offline.
