import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Which tools a session offers. Several extensions turn tools off for their
// own reasons (an unlogged thread, a subagent's role, Plan mode, a switch), so
// each says which tools its reason has off, and a tool is active only while no
// reason has it off. A tool comes back only if a reason took it away, so
// tools Pi leaves off by default stay off.

interface Gate { off: Map<string, Set<string>>; taken: Set<string> }
const gates = new WeakMap<object, Gate>();

function gateOf(pi: ExtensionAPI, ctx: ExtensionContext | undefined): Gate {
  // One gate per session: every extension of a session shares its session manager.
  const key = ctx?.sessionManager ?? pi;
  let gate = gates.get(key);
  if (!gate) gates.set(key, gate = { off: new Map(), taken: new Set() });
  return gate;
}

const offIn = (gate: Gate) => new Set([...gate.off.values()].flatMap((s) => [...s]));

/** Sets which tools `reason` has off in this session, and applies the result at once. */
export function setToolsOff(pi: ExtensionAPI, ctx: ExtensionContext | undefined, reason: string, names: Iterable<string>): void {
  const gate = gateOf(pi, ctx);
  gate.off.set(reason, new Set(names));
  const off = offIn(gate);
  const active = pi.getActiveTools();
  const want = new Set(active.filter((t) => !off.has(t)));
  for (const t of active) if (off.has(t)) gate.taken.add(t);
  for (const t of gate.taken) {
    if (off.has(t)) continue;
    want.add(t);
    gate.taken.delete(t);
  }
  if (want.size === active.length && active.every((t) => want.has(t))) return;
  // Tools keep their registered order, so the prompt prefix stays the same.
  pi.setActiveTools(pi.getAllTools().map((t) => t.name).filter((t) => want.has(t)));
}

/**
 * Turns on registered tools that aren't on, as when a new session on a thread
 * brings back what she loaded in an earlier one. A tool a reason has off now
 * stays off, and comes on once no reason has it off.
 */
export function bringBack(pi: ExtensionAPI, ctx: ExtensionContext | undefined, names: Iterable<string>): void {
  const gate = gateOf(pi, ctx);
  const off = offIn(gate);
  const active = new Set(pi.getActiveTools());
  const all = pi.getAllTools().map((t) => t.name);
  let added = false;
  for (const name of names) {
    if (active.has(name) || !all.includes(name)) continue;
    if (off.has(name)) { gate.taken.add(name); continue; }
    active.add(name);
    added = true;
  }
  if (added) pi.setActiveTools(all.filter((t) => active.has(t)));
}
