// In the message box's row, as in the Claude app: a "+" menu with attaching
// and the tool switches at the left; the thread's mode (Shift+Tab cycles) at
// the right, before Send.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GoAhead, MachineLimit, PermissionMode, ThreadSettings, ThreadSettingsChange } from "./api.ts";
import { Icon } from "./icons.tsx";
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


/** A menu that opens above its button and closes on a pick, Escape or a click outside. */
function useMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  return { open, setOpen, anchor };
}

/** Strictest first: a mode above a machine's limit asks there. */
const RANK: Record<PermissionMode, number> = { plan: 0, ask: 1, acceptEdits: 2, auto: 3 };
/** A thread's granted machine, for the mode menu's "Asks on" line. */
export interface GrantedMachine { name: string; limit: MachineLimit }
/** The machines whose limit is below `mode`, where that mode asks instead. */
export const asksOn = (mode: PermissionMode, machines: GrantedMachine[]) => machines.filter((m) => RANK[m.limit] < RANK[mode]).map((m) => m.name);

/**
 * One mode in a menu or list: a check on the current one, the name with its
 * line, and its number key. Above a granted machine's limit the line reads
 * "Asks on <machine>".
 */
export function ModeItem({ mode, checked, n, role, machines = [], onClick }: {
  mode: PermissionMode; checked?: boolean; n?: number; role?: "menuitem" | "menuitemradio" | "radio"; machines?: GrantedMachine[]; onClick: () => void;
}) {
  const asks = asksOn(mode, machines);
  return (
    <button type="button" className="mode-item" role={role ?? (checked === undefined ? "menuitem" : "menuitemradio")} aria-checked={checked} onClick={onClick}>
      <span className="mk" aria-hidden="true">{checked ? <Icon name="check" /> : null}</span>
      <span><span>{MODES[mode].label}</span><small>{asks.length ? `Asks on ${asks.join(", ")}` : MODES[mode].description}</small></span>
      {n !== undefined && <kbd>{n}</kbd>}
    </button>
  );
}

export function ModePicker({ mode, machines, onChange }: { mode: PermissionMode; machines?: GrantedMachine[]; onChange: (m: PermissionMode) => void }) {
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
          {MODE_ORDER.map((m, i) => <ModeItem key={m} mode={m} checked={m === mode} n={i + 1} machines={machines} onClick={() => pick(m)} />)}
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
export function ToolsMenu({ settings, onAttach, onChange, onOpen }: {
  settings?: ThreadSettings; onAttach: () => void; onChange: (c: ThreadSettingsChange) => void; onOpen?: () => void;
}) {
  const { open, setOpen, anchor } = useMenu();
  let switches: ReactNode = null;
  if (settings) {
    switches = (
      <>
        <div className="sep" role="separator" />
        <Switch label="Web search" hint={settings.searchProvider ? undefined : "Search needs a SearXNG address in Administration"} checked={settings.webSearch} onChange={(webSearch) => onChange({ webSearch })} />
        <Switch label="Internet for commands" checked={settings.network.internet} onChange={(internet) => onChange({ internet })} />
        <Switch label="Images" hint="Lets the agent make and edit images in this thread." checked={settings.images} onChange={(images) => onChange({ images })} />
      </>
    );
  }
  return (
    <div className="tools-menu" ref={anchor}>
      <button type="button" className="icon" aria-label="Attach or switch tools" aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}>
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
