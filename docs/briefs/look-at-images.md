# A model list for looking at images

The owner's decision (2026-10-25). A project chat whose model can't see
delegated a look at an uploaded image and named a per-token cloud model,
while local vision models were up. The owner wants to choose which models
look at images, plan models (a subscription already paid for) and local
ones included, and never have Lyrica pick a model that costs money herself.

## What changes

1. **A new task, `vision`, shown as "Look at images"** in Models → Tasks, in
   both columns and in presets, with its own ordered list. It takes only
   models with vision; it never follows chat (`OWN_LIST_ONLY`), since the
   chat model may be the one that can't see. A paid model is in it only if
   the person put it there.
2. **The subagent fallback uses it.** A subagent whose model has no vision
   and meets an image switches to the first model of the thread's
   `vision` list whose machine is up (`Models.resolve("vision", ctx)`), as
   it switches to the first local vision model today. With no list set,
   it falls back to that rule: local models with vision. A private or
   local-only thread reads the Private column, so only local models.
3. **Delegated looks go through it too.** She no longer names a model to
   look at an image: the delegate guideline and the no-vision note say to
   delegate the look with no model, and the subagent switches by (2). A
   model named for a step stays only what the person named, and one that
   costs money is refused unless the person singled it out (#550).
4. Her own read in the main thread is unchanged: she is told she can't see
   it and delegates.

## What stays

- Paid per-token models never chosen by her; Free models only still skips
  them in every list.
- Local-only and private threads stay local.

## Where it shows

docs/ux.md, Models → Tasks: one more row, "Look at images", with the same
ordered model picker as the other rows, offering only models with vision.
