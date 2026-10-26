// Reactions on a message (docs/ux.md §6): chips under the message, the React button in its header line,
// a quick row of favourites and the full picker with search and categories.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Reaction } from "./api.ts";
import { Icon } from "./icons.tsx";
import { useDismiss } from "./ui.tsx";

/** The favourites in the quick row, with their names for screen readers and tooltips. */
const QUICK: [string, string][] = [["🙏", "folded hands"], ["👍", "thumbs up"], ["❤️", "heart"], ["🎉", "tada"], ["👀", "eyes"], ["🚀", "rocket"]];

export interface Reactor {
  /** Puts the user's `emoji` on message `n`, or takes it off. */
  react(n: number, emoji: string, on: boolean): void;
}

/** Who reacted, for a chip's tooltip. */
function who(r: Reaction, her: string): string {
  const names = [r.you ? "You" : "", r.her ? her : ""].filter(Boolean);
  return `${names.join(" and ")} reacted with ${r.emoji}`;
}

/** The chips under a message: one per emoji, counting the user and Lyrica; pressing one toggles the user's own. */
export function ReactionChips({ n, reactions, reactor, her }: { n: number; reactions: Reaction[] | undefined; reactor?: Reactor; her: string }) {
  if (!reactions?.length) return null;
  return (
    <div className="reactions" role="group" aria-label="Reactions">
      {reactions.map((r) => (
        <button key={r.emoji} type="button" className="reaction" aria-pressed={r.you} title={who(r, her)} aria-label={who(r, her)}
          disabled={!reactor} onClick={() => reactor?.react(n, r.emoji, !r.you)}>
          <span className="emoji">{r.emoji}</span><span className="num">{(r.you ? 1 : 0) + (r.her ? 1 : 0)}</span>
        </button>
      ))}
    </div>
  );
}

const FullPicker = lazy(() => import("./EmojiPicker.tsx"));

/** The React button in a message's header line: the quick row, and More… for the full picker. */
export function ReactButton({ n, reactions, reactor }: { n: number; reactions: Reaction[] | undefined; reactor: Reactor }) {
  const [open, setOpen] = useState<false | "quick" | "full">(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, !!open, close);
  const pick = (emoji: string) => { close(); reactor.react(n, emoji, !reactions?.some((r) => r.emoji === emoji && r.you)); };
  // Arrow keys move along the quick row (WCAG 2.1.1).
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".quick button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <span className="react-anchor" ref={ref}>
      <button type="button" className="icon-btn react-btn" aria-label="React" title="React" aria-haspopup="dialog" aria-expanded={!!open} onClick={() => setOpen(open ? false : "quick")}>
        <Icon name="react" />
      </button>
      {open === "quick" && (
        <div className="quick" role="dialog" aria-label="React" onKeyDown={onKey}>
          {QUICK.map(([emoji, name]) => (
            <button key={emoji} type="button" aria-pressed={reactions?.some((r) => r.emoji === emoji && r.you) ?? false} aria-label={`React with ${name}`} title={`React with ${name}`} onClick={() => pick(emoji)} autoFocus={emoji === QUICK[0]![0]}>
              {emoji}
            </button>
          ))}
          <button type="button" className="more" aria-label="More emoji" title="More emoji" onClick={() => setOpen("full")}><Icon name="plus" /></button>
        </div>
      )}
      {open === "full" && (
        <div className="full" role="dialog" aria-label="Pick an emoji">
          <Suspense fallback={<div className="muted small picker-wait">Loading emoji…</div>}>
            <FullPicker onPick={pick} />
          </Suspense>
        </div>
      )}
    </span>
  );
}

