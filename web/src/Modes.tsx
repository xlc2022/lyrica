// Beside the message box, as in Claude Code and Open WebUI: the thread's mode
// (Shift+Tab cycles), and a "+" menu with attaching and the tool switches.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionMode, ThreadSettings, ThreadSettingsChange } from "./api.ts";
import { Switch, useDismiss } from "./ui.tsx";

/** In the order the menu lists them and Shift+Tab cycles. */
export const MODE_ORDER: PermissionMode[] = ["ask", "acceptEdits", "plan", "auto"];
export const MODES: Record<PermissionMode, { label: string; description: string }> = {
  ask: { label: "Ask", description: "Asks before commands and file changes." },
  acceptEdits: { label: "Accept edits", description: "File changes go through; commands ask." },
  plan: { label: "Plan", description: "Only reads, then asks to go ahead with a plan." },
  auto: { label: "Auto", description: "Works freely inside the thread's folders." },
};

export const nextMode = (m: PermissionMode) => MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length]!;

export function ModePicker({ mode, disabled, onChange }: { mode: PermissionMode; disabled?: boolean; onChange: (m: PermissionMode) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
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
      <button type="button" className="link" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
        title="Shift+Tab in the message box cycles" onClick={() => setOpen(!open)}>
        {MODES[mode].label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu up" role="menu" aria-label="Mode">
          {MODE_ORDER.map((m, i) => (
            <button key={m} type="button" role="menuitemradio" aria-checked={m === mode} onClick={() => pick(m)}>
              <kbd>{i + 1}</kbd>
              <span><b>{MODES[m].label}</b><small>{MODES[m].description}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The "+": attach a file, and the switches that turn tools on or off for this thread. */
export function ToolsMenu({ settings, onAttach, onChange }: {
  settings?: ThreadSettings; onAttach: () => void; onChange: (c: ThreadSettingsChange) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  return (
    <div className="tools-menu" ref={anchor}>
      <button type="button" className="attach" aria-label="Attach or switch tools" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>+</button>
      {open && (
        <div className="menu up" role="menu" aria-label="Attach and tools">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onAttach(); }}>Attach a file…</button>
          {settings && (
            <>
              <Switch label="Web search" checked={settings.webSearch} disabled={!!settings.parent} onChange={(webSearch) => onChange({ webSearch })} />
              <Switch label="Internet for commands" checked={settings.network.internet} disabled={!!settings.parent} onChange={(internet) => onChange({ internet })} />
              <Switch label="Images" checked={settings.images} disabled={!!settings.parent} onChange={(images) => onChange({ images })} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
