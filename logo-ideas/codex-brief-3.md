# Codex brief, round 3: one signature object, Monika-bow style

Proposals only. Do not commit to main or open a PR.

## What changed
The user passed on round 1 (abstract objects) and round 2 (mascots). **No faces,
no creatures.** The user's reference is the logo of Monika, the AI companion
project that came before Lyrica (github.com/irrigationreal/monika,
docs/assets/monika.svg). Match its *vibe*, not its subject.

## The reference, described
Monika's mark is her character's signature accessory, a ribbon bow, drawn as:
- one object, instantly recognisable, no face, no text
- a **monoline outline**: one thick even stroke (about 1/18 of the width),
  rounded joins and caps, no fills, the background shows through the shapes
- **angular, geometric simplification**: the soft loops become straight-sided
  quadrilaterals with slightly rounded corners, a small square knot in the
  middle, two tails ending in V notches
- tilted slightly, with an off-centre, lively balance rather than mirrored
- a **single colour** through `currentColor` (Monika uses a bright green on
  the root svg's `color`), so it recolours anywhere
- still reads at 16 px

## The subject for Lyrica
Her character is seeded from Lyrica Prismriver (see logo-ideas/codex-brief.md
and persona/SOUL.md). That character's signature items, like Monika's bow:
- her **hat**, topped with a **star** ornament (her sisters' hats carry a
  crescent moon and a sun)
- her **keyboard**, which she plays without touching (a poltergeist)
- red as her colour

Draw 6 concepts, each one signature object in that monoline style, for
example: the star alone, faceted and tilted; the hat with its star; a short
run of keyboard keys drawn as one outline; a star whose points trail into a
ribbon or a staff line; the star and a key combined into one shape; a
two-key "L". Invent better ones if you see them. Avoid fan art; it's an
emblem, not a portrait.

## Deliverables
logo-ideas/emblem-1.svg … emblem-6.svg: viewBox 0 0 512 512, strokes only,
`stroke="currentColor"`, `fill="none"`, round linejoin and linecap, and the
root svg sets `color` (use a warm red such as #d6455a for some and teal
#1f6f78 for others). No text, no external refs, each under ~2 KB. Add
logo-ideas/emblems.md with a name and one line each. Render at 512, 32 and
16 px and simplify any that clog when small.
