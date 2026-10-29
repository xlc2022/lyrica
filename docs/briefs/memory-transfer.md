# Memory export and import

**Status: built** (merged as #439, 4309610). The design lives in [memory.md](../memory.md#export-and-import);
the controls in [ux.md](../ux.md) §6, "A user's memory".

## Goal

A user can take some of their memories out as Markdown (to keep, read or
edit elsewhere) and bring such a file back, into their own memory or another
user's or install's, without breaking the privacy rules.

Principles served: 2 (users are protected from each other: an import goes
only into the importing user's own pools, through their owner view) and the
hard rules (no plaintext memory on the server's disk; private memory never
reaches a general context).

## Decisions (the owner, 2026-10-22)

- The export is plain, unencrypted Markdown the browser downloads. It is
  built in memory on the server and never written or logged there.
- A re-imported memory is one the user added (origin `user`), so sleep
  treats it as authoritative and never rewrites it.
- Links to memories that still exist, or arrive in the same import, are
  kept.
- A link to a memory that isn't there becomes words saying what it pointed
  at, taken from the export's `cites` header ("Replace with words", picked
  over keeping dangling IDs or dropping the link).
- A link into a pool the target can't cite (a private memory imported into
  general, pointing at a private one) reads "(from a private note)" with no
  words from it.

## Out of scope

WAKE, the journal and messages (Recent) don't export: they aren't memories a
user adds. No zip, no encrypted export (backups cover that), no import from
other assistants' formats.

## Handoff

Done: `core/src/store/transfer.ts` (`exportMemories`, `parseMemories`,
`importMemories`), `PoolStore.importMemory` and its helpers, the two routes,
the selection bar's Export, the memory ⋯'s Export, Add a memory's Import, and
`core/test/transfer.test.ts`. Next: nothing planned.
