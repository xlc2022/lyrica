// Finding the model a person named in plain words ("use qwen flash") among
// the ones a thread may use, or the closest few when no one model fits.

/** A model as she sees it: its offering ID and its `endpoint/model` label. */
export interface Named { id: string; label: string }

export type Match = { model: Named } | { closest: Named[] };

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).map(compact).filter(Boolean);
const modelPart = (label: string) => label.slice(label.indexOf("/") + 1);
/** A model's own name: its label after the last `/`, compacted. */
const own = (label: string) => compact(label.slice(label.lastIndexOf("/") + 1));

/** Whether two labels name the same model on different endpoints: "router/qwen/qwen3.8-27b" and "gpu/qwen3.8-27b". */
export function sameModelName(a: string, b: string): boolean {
  return !!own(a) && own(a) === own(b);
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** How alike two names are, 0 to 1 (Dice over letter pairs). */
function likeness(a: string, b: string): number {
  const x = bigrams(a), y = bigrams(b);
  if (!x.length || !y.length) return a === b ? 1 : 0;
  const left = new Map<string, number>();
  for (const g of x) left.set(g, (left.get(g) ?? 0) + 1);
  let both = 0;
  for (const g of y) { const n = left.get(g); if (n) { both++; left.set(g, n - 1); } }
  return (2 * both) / (x.length + y.length);
}

/**
 * The one model `name` means, else the closest few. In order: its ID or
 * label; its model ID on any endpoint; the only label holding every word of
 * the name. Several models that fit equally are offered, not picked.
 */
export function matchModel(name: string, models: Named[], closest = 3): Match {
  const q = name.trim().toLowerCase();
  const exact = models.find((m) => m.id === name || m.label.toLowerCase() === q);
  if (exact) return { model: exact };
  const pick = (list: Named[]): Match | undefined => (list.length === 1 ? { model: list[0]! } : list.length ? { closest: list.slice(0, Math.max(closest, 5)) } : undefined);
  const byModel = pick(models.filter((m) => modelPart(m.label).toLowerCase() === q));
  if (byModel) return byModel;
  const want = words(name);
  if (want.length) {
    const holding = pick(models.filter((m) => { const l = compact(m.label); return want.every((w) => l.includes(w)); }));
    if (holding) return holding;
  }
  const c = compact(name);
  const ranked = models.map((m) => ({ m, s: Math.max(likeness(c, compact(m.label)), likeness(c, compact(modelPart(m.label)))) }))
    .filter((r) => r.s > 0.2).sort((a, b) => b.s - a.s);
  return { closest: ranked.slice(0, closest).map((r) => r.m) };
}

/**
 * Whether `text` (the person's words) singles out `model` among `models`:
 * it holds the whole label, or the model's own name (after the last `/`)
 * when no other model shares that name. A model another one shares a name
 * with is named only by its whole label.
 */
export function singledOut(text: string, model: Named, models: Named[]): boolean {
  const said = compact(text);
  if (said.includes(compact(model.label))) return true;
  const name = own(model.label);
  return !!name && said.includes(name) && !models.some((m) => m.id !== model.id && own(m.label) === name);
}

/** What she's told when a name fits no one model: the closest, and to ask. */
export function unmatched(name: string, m: { closest: Named[] }): string {
  if (!m.closest.length) return `"${name}" isn't one of this thread's models, and none is close. Ask the person which model they meant.`;
  return `"${name}" isn't exactly one of this thread's models. Closest: ${m.closest.map((x) => x.label).join(", ")}. Ask the person which one they meant before going on.`;
}

/** Claude Code's model aliases, which a name's words may ask for. */
export type ClaudeAlias = "opus" | "sonnet" | "haiku";
const CLAUDE_WORDS = new Set(["claude", "code", "anthropic", "opus", "sonnet", "haiku"]);

/**
 * Whether a name in plain words means Claude itself ("Claude", "Claude Opus",
 * "claude sonnet 4.5"): every word is Claude's, an alias, or a version. Such
 * a name goes to Claude Code where it's on, not to a cloud copy of Claude.
 */
export function meansClaude(name: string): boolean {
  const w = words(name);
  return w.some((x) => x === "claude" || x === "anthropic" || x === "opus" || x === "sonnet" || x === "haiku")
    && w.every((x) => CLAUDE_WORDS.has(x) || /^[0-9]+$/.test(x));
}

/** The Claude Code model alias a name asks for, if its words name one. */
export function claudeAlias(name: string): ClaudeAlias | undefined {
  return words(name).find((x): x is ClaudeAlias => x === "opus" || x === "sonnet" || x === "haiku");
}

/** Whether a model is a Claude served by an endpoint (Anthropic's API, OpenRouter), by its own name. */
export function isClaudeModel(label: string): boolean {
  return own(label).includes("claude");
}

/** Whether `name` names one of the models outright: its offering ID or its whole `endpoint/model` label. */
export function namedOutright(name: string, models: Named[]): boolean {
  const q = name.trim().toLowerCase();
  return models.some((m) => m.id === name || m.label.toLowerCase() === q);
}
