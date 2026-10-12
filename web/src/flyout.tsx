// Submenus that fly out beside their item on devices that can hover
// (docs/ux.md §3). The flyout is the same menu component as the menu itself;
// this holds where it goes, when hovering opens or closes it, and the hook a
// menu spreads its handlers onto. Without hover a menu keeps replacing itself
// in place with a ‹ Back row, so nothing here runs.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** How long the pointer rests on an item before its submenu opens (ms). */
export const HOVER_OPEN_MS = 150;
/** How long a flyout stays open after the pointer leaves it, so a move back into it keeps it (ms). */
export const FLYOUT_CLOSE_MS = 300;

interface Box { x: number; y: number; width: number; height: number }

/**
 * Where a flyout sits beside its item, in viewport coordinates: the top lines
 * up with the item and shifts up to stay on screen; it opens to the right, or
 * to the left when there's no room on the right. `gap` keeps it off the edge.
 */
export function flyoutBox(item: Box, size: Box, view: { width: number; height: number }, gap = 8): { left: number; top: number } {
  let left = item.x + item.width;
  if (left + size.width > view.width - gap) left = Math.max(gap, item.x - size.width);
  let top = item.y;
  if (top + size.height > view.height - gap) top = Math.max(gap, view.height - gap - size.height);
  return { left, top };
}

/** What the pointer is over: a menu row (`key` for one with a submenu), an open flyout, or none of it. */
export type HoverTarget = { kind: "item"; key: string | null } | { kind: "flyout" } | { kind: "outside" };

/** What hovering does to the open flyout (`open`, "" for none): open one after its delay, close it, or leave things as they are. */
export function hoverIntent(open: string, target: HoverTarget): { action: "open" | "close"; key?: string; delay: number } | null {
  switch (target.kind) {
    // Moving toward or into an open flyout keeps it; so does resting on its own item.
    case "flyout": return null;
    case "outside": return open ? { action: "close", delay: FLYOUT_CLOSE_MS } : null;
    case "item":
      if (target.key === open) return null;
      // Resting on a sibling switches to its submenu, or closes the current one.
      if (target.key === null) return open ? { action: "close", delay: HOVER_OPEN_MS } : null;
      return { action: "open", key: target.key, delay: HOVER_OPEN_MS };
  }
}

/** Whether this device can hover; the flyout mode keys off this, not screen width. */
export function useCanHover(): boolean {
  const [can, setCan] = useState(() => matchMedia("(hover: hover)").matches);
  useEffect(() => {
    const mq = matchMedia("(hover: hover)");
    const on = () => setCan(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return can;
}

/** Hover intent for a menu whose open submenu is `open` ("" for none): handlers to spread on the menu's own element. */
export function useFlyout<K extends string>(open: K, setOpen: (key: K) => void, enabled: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const decide = (target: HoverTarget) => {
    if (!enabled) return;
    clearTimeout(timer.current);
    const d = hoverIntent(open, target);
    if (!d) return;
    timer.current = setTimeout(() => setOpen((d.action === "open" ? d.key! : "") as K), d.delay);
  };
  return {
    onPointerOver: (e: React.PointerEvent) => {
      const el = e.target as Element;
      if (el.closest(".flyout")) decide({ kind: "flyout" });
      else decide({ kind: "item", key: el.closest<HTMLElement>("[data-submenu]")?.dataset.submenu ?? null });
    },
    onPointerLeave: () => decide({ kind: "outside" }),
  };
}

/** A submenu beside its item, placed by flyoutBox; the same menu component as the menu itself. */
export function Flyout({ parentRef, anchor, children }: {
  /** The open menu, which holds the item this flyout belongs to. */
  parentRef: React.RefObject<HTMLElement | null>;
  /** The data-submenu value of that item. */
  anchor: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The menu keeps itself on screen in its own effect, which runs after this one, so the flyout is placed a frame later, from where the item ends up.
    const frame = requestAnimationFrame(() => {
      const el = ref.current, parent = parentRef.current;
      const item = parent?.querySelector<HTMLElement>(`[data-submenu="${anchor}"]`);
      if (!el || !item) return;
      // Its first row, not its border, lines up with the item.
      const box = el.getBoundingClientRect(), r = item.getBoundingClientRect();
      const inset = (el.firstElementChild?.getBoundingClientRect().top ?? box.top) - box.top;
      const { left, top } = flyoutBox({ x: r.x, y: r.y - inset, width: r.width, height: r.height }, box, { width: innerWidth, height: innerHeight });
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.visibility = "";
    });
    return () => cancelAnimationFrame(frame);
  });
  return <div ref={ref} className="ctx-menu flyout" role="menu" style={{ visibility: "hidden" }}>{children}</div>;
}
