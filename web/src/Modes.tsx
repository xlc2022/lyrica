// In the message box's row, as in the Claude app: a "+" menu with attaching
// and the tool switches at the left; the thread's mode (Shift+Tab cycles) at
// the right, before Send.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GoAhead, PermissionMode, ThreadSettings, ThreadSettingsChange } from "./api.ts";
import { Switch, useDismiss } from "./ui.tsx";

/** In the order the menu lists them and Shift+Tab cycles. */
export const MODE_ORDER: PermissionMode[] = ["ask", "acceptEdits", "plan", "auto"];
export const MODES: Record<PermissionMode, { label: string; description: string }> = {
  ask: { label: "Ask", description: "Asks before commands and file changes." },
  acceptEdits: { label: "Accept edits", description: "File changes go through; commands ask." },
  plan: { label: "Plan", description: "Only reads, then asks to go ahead with a plan." },
  auto: { label: "Auto", description: "Works freely inside the thread's folders." },
};
/** The modes a plan can go ahead in. */
export const GO_AHEAD: GoAhead[] = ["ask", "acceptEdits", "auto"];

export const nextMode = (m: PermissionMode) => MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length]!;

/** Line icons for the message box's row: 1.5 px strokes on a 16 px grid. */
const PATHS = { plus: "M8 3v10M3 8h10", up: "M8 13V3M3.5 7.5 8 3l4.5 4.5", stop: "M4.5 4.5h7v7h-7z", down: "M4.5 6.5 8 10l3.5-3.5" };
export const Icon = ({ name }: { name: keyof typeof PATHS }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name]} /></svg>
);

/** A menu that opens above its button and closes on a pick, Escape or a click outside. */
function useMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  return { open, setOpen, anchor };
}

/** One mode in a menu: a check on the current one, the name with its line, and its number key. */
function ModeItem({ mode, checked, n, onClick }: { mode: PermissionMode; checked?: boolean; n?: number; onClick: () => void }) {
  return (
    <button type="button" className="mode-item" role={checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={checked} onClick={onClick}>
      <span className="mk" aria-hidden="true">{checked ? "✓" : ""}</span>
      <span><span>{MODES[mode].label}</span><small>{MODES[mode].description}</small></span>
      {n !== undefined && <kbd>{n}</kbd>}
    </button>
  );
}

export function ModePicker({ mode, onChange }: { mode: PermissionMode; onChange: (m: PermissionMode) => void }) {
  const { open, setOpen, anchor } = useMenu();
  const pick = (m: PermissionMode) => { setOpen(false); if (m !== mode) onChange(m); };
  // While the menu is open, its number keys pick a mode.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      const m = MODE_ORDER[Number(e.key) - 1];
      if (m) { e.preventDefault(); pick(m); }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });
  return (
    <div className="mode-picker" ref={anchor}>
      <button type="button" className="link" aria-haspopup="menu" aria-expanded={open}
        title="Shift+Tab in the message box cycles" onClick={() => setOpen(!open)}>
        {MODES[mode].label}<span className="drop"><Icon name="down" /></span>
      </button>
      {open && (
        <div className="menu up end" role="menu" aria-label="Mode">
          {MODE_ORDER.map((m, i) => <ModeItem key={m} mode={m} checked={m === mode} n={i + 1} onClick={() => pick(m)} />)}
        </div>
      )}
    </div>
  );
}

/** The plan card's one primary action: going ahead, in a mode picked from its menu. */
export function GoAheadMenu({ disabled, onPick }: { disabled?: boolean; onPick: (m: GoAhead) => void }) {
  const { open, setOpen, anchor } = useMenu();
  return (
    <div className="go-ahead" ref={anchor}>
      <button type="button" className="primary" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
        Go ahead in…<span className="drop"><Icon name="down" /></span>
      </button>
      {open && (
        <div className="menu up" role="menu" aria-label="Go ahead in">
          {GO_AHEAD.map((m) => <ModeItem key={m} mode={m} onClick={() => { setOpen(false); onPick(m); }} />)}
        </div>
      )}
    </div>
  );
}

/** The "+": attach a file, and the switches that turn tools on or off for this thread. */
export function ToolsMenu({ settings, onAttach, onChange }: {
  settings?: ThreadSettings; onAttach: () => void; onChange: (c: ThreadSettingsChange) => void;
}) {
  const { open, setOpen, anchor } = useMenu();
  let switches: ReactNode = null;
  if (settings) {
    switches = (
      <>
        <div className="sep" role="separator" />
        <Switch label="Web search" checked={settings.webSearch} onChange={(webSearch) => onChange({ webSearch })} />
        <Switch label="Internet for commands" checked={settings.network.internet} onChange={(internet) => onChange({ internet })} />
        <Switch label="Images" checked={settings.images} onChange={(images) => onChange({ images })} />
      </>
    );
  }
  return (
    <div className="tools-menu" ref={anchor}>
      <button type="button" className="icon" aria-label="Attach or switch tools" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="plus" />
      </button>
      {open && (
        <div className="menu up" role="menu" aria-label="Attach and tools">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onAttach(); }}>Attach a file…</button>
          {switches}
        </div>
      )}
    </div>
  );
}
