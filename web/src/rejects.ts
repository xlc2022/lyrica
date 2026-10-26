// Her rejected image attempts (docs/ux.md §6, "An image the agent made"): the image tool's reject moves an attempt into
// the images folder's rejected/, and pick brings one back to show last. Kept apart from Messages.tsx so a test can check it.
import type { ImagePart, MessagePart } from "./api.ts";

/** A message in the conversation, in order: her parts, or a person's message, which starts a new turn. */
export interface TurnEntry { key: string; parts?: MessagePart[]; user?: boolean }

/** How one message shows its image parts: each by its index, with its paths cut down, and the turn's group of rejects before one. */
export interface MessageImages {
  /** An image part as shown, or null when every path it held is shown elsewhere. */
  parts: Map<number, ImagePart | null>;
  /** The turn's rejected attempts, drawn as one group before the image part at this index. */
  groups: Map<number, RejectedImage[]>;
}

/** A rejected attempt where it lies now; `deleted` once she cleared the rejected images, at the person's word. */
export type RejectedImage = ImagePart & { deleted?: true };

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
/** Where a rejected attempt lies now: its folder's rejected/, by the same name (core/src/workspace/images.ts). */
export const rejectedPath = (path: string) => (dirOf(path).endsWith("/rejected") ? path : `${dirOf(path)}/rejected/${nameOf(path)}`);

/** A successful reject, pick or clear_rejected of the image tool: which names it moved, and which way. */
function sorting(p: MessagePart): { reject: string[] } | { pick: string } | { clear: true } | undefined {
  if (p.type !== "tool" || p.name !== "image" || p.isError || p.result === undefined) return undefined;
  const args = (p.args ?? {}) as { action?: unknown; images?: unknown; image?: unknown };
  if (args.action === "reject" && Array.isArray(args.images)) return { reject: args.images.filter((x): x is string => typeof x === "string").map(nameOf) };
  if (args.action === "pick" && typeof args.image === "string") return { pick: nameOf(args.image) };
  if (args.action === "clear_rejected") return { clear: true };
  return undefined;
}

/**
 * Each message's image parts as the conversation shows them. An attempt rejected by the end of the conversation (a
 * pick undoes a reject) leaves its part and joins its turn's one group, drawn where the turn's first rejected attempt
 * was. An image shown twice in a turn (a pick of one still in place) shows only the last time. A picked part takes the
 * model and tier of the part that first showed it. Names are the tool's own random ones, so a name stands for its file.
 */
export function sortImages(entries: TurnEntry[]): Map<string, MessageImages> {
  const rejected = new Set<string>();
  const deleted = new Set<string>();
  const facts = new Map<string, Pick<ImagePart, "model" | "tier">>();
  for (const e of entries) for (const p of e.parts ?? []) {
    if (p.type === "image" && p.model) for (const path of p.paths) if (!facts.has(nameOf(path))) facts.set(nameOf(path), { model: p.model, ...(p.tier ? { tier: p.tier } : {}) });
    const s = sorting(p);
    if (s && "reject" in s) for (const n of s.reject) rejected.add(n);
    if (s && "pick" in s) rejected.delete(s.pick);
    if (s && "clear" in s) { for (const n of rejected) deleted.add(n); rejected.clear(); }
  }
  const out = new Map<string, MessageImages>();
  type Seen = { key: string; i: number; path: string; part: ImagePart };
  const turn = (seen: Seen[]) => {
    const last = new Map<string, Seen>();
    for (const s of seen) last.set(nameOf(s.path), s);
    const group: RejectedImage[] = [];
    let anchor: Seen | undefined;
    const kept = new Map<Seen["part"], string[]>();
    const where = new Map<Seen["part"], Seen>();
    for (const s of seen) {
      where.set(s.part, s);
      const name = nameOf(s.path);
      if (rejected.has(name) || deleted.has(name)) {
        anchor ??= s;
        if (!group.some((g) => nameOf(g.paths[0]!) === name)) {
          const f = s.part.model ? { model: s.part.model, ...(s.part.tier ? { tier: s.part.tier } : {}) } : facts.get(name) ?? { model: "" };
          group.push({ type: "image", paths: [rejectedPath(s.path)], ...f, ...(deleted.has(name) ? { deleted: true as const } : {}) });
        }
      } else if (last.get(name) === s) kept.set(s.part, [...(kept.get(s.part) ?? []), s.path]);
    }
    for (const [part, s] of where) {
      const m = out.get(s.key) ?? { parts: new Map(), groups: new Map() };
      const paths = kept.get(part);
      const f = part.picked && !part.model && paths ? facts.get(nameOf(paths[0]!)) : undefined;
      m.parts.set(s.i, paths ? { ...part, paths, ...f } : null);
      out.set(s.key, m);
    }
    if (anchor) out.get(anchor.key)!.groups.set(anchor.i, group);
  };
  let seen: Seen[] = [];
  for (const e of entries) {
    if (e.user) { turn(seen); seen = []; continue; }
    (e.parts ?? []).forEach((p, i) => { if (p.type === "image") for (const path of p.paths) seen.push({ key: e.key, i, path, part: p }); });
  }
  turn(seen);
  return out;
}
