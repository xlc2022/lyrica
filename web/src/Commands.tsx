// Commands in the message box (docs/ux.md §6, Commands in the message box): "/" as the box's first character opens
// a popover of commands, as "[[" does in the memory editor. Each command works a control that already has a home
// (the header's model picker and Context, the drawer's Thinking and Code mode, the mode menu, the "+" switches, the
// title, New thread), or compacts the thread. Ten, with the terminal's /sleep, within the budget of twelve
// (PRINCIPLES.md, 8). A line that names no command is sent as a message.
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ModelRef, PermissionMode, ThinkingLevel, ThreadSettings, ThreadSettingsChange } from "./api.ts";
import { isChatModel, matchesModel, modelName, shortModel } from "./ModelLabel.tsx";
import { MODES } from "./Modes.tsx";

/** What the commands work on: the thread's settings and the actions the thread view already has. */
export interface CommandEnv {
  settings: ThreadSettings;
  onSettings: (change: ThreadSettingsChange) => void;
  /** Picks the model she talks on (Conversation, or Coding in Code mode), as the header's picker does. */
  setModel: (model: ModelRef) => Promise<unknown>;
  openModel: () => void;
  /** Absent before the first measured turn, when the header has no Context. */
  openContext?: () => void;
  title: string;
  rename: (title: string) => Promise<unknown>;
  compact: (notes: string) => Promise<unknown>;
  /** Absent in a project, whose threads she starts. */
  newThread?: () => void;
}

interface Choice { label: string; value: string; on?: boolean }

export interface Command {
  name: string;
  /** What may follow the name, shown muted after it. */
  arg?: string;
  /** The control it works, by that control's own label. */
  label: string;
  value?: string;
  /** Mono value (a percent). */
  num?: boolean;
  tip: string;
  /** Picking the row from the menu: `run` runs it; `complete` writes "/name " so a choice or text can follow. */
  bare: "run" | "complete";
  choices?: (q: string) => Choice[];
  /** Runs it; returns what a screen reader hears, or throws to show why it can't. */
  run: (arg: string) => string | Promise<string>;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const onOff = (on: boolean) => (on ? "On" : "Off");
/** "on", "off" or nothing (which flips it). */
const toggled = (arg: string, now: boolean) => {
  const a = arg.toLowerCase();
  if (a === "on") return true;
  if (a === "off") return false;
  if (a) throw new Error("Use on or off, or nothing to switch it.");
  return !now;
};
const fromChoices = (choices: Choice[], arg: string, what: string) => {
  const a = arg.toLowerCase();
  const hit = choices.find((c) => c.value.toLowerCase() === a || c.label.toLowerCase() === a) ?? choices.find((c) => c.label.toLowerCase().startsWith(a));
  if (!hit) throw new Error(`No ${what} called "${arg}".`);
  return hit;
};

/** The commands this thread offers, in the menu's order. */
export function commandList(env: CommandEnv): Command[] {
  const s = env.settings;
  const talk = s.code ? "code" : "chat";
  const current = s.models[talk];
  const levelName = (l: ThinkingLevel) => cap(s.thinkingNames?.[l] ?? l);
  const levels = (): Choice[] => [
    { label: s.thinkingSet ? "Default" : `Default (${levelName(s.thinking)})`, value: "default", on: !s.thinkingSet },
    ...[...new Set([...s.thinkingLevels, ...(s.thinkingSet ? [s.thinking] : [])])].map((l) => ({ label: levelName(l), value: l, on: s.thinkingSet && s.thinking === l })),
  ];
  const modes = (): Choice[] => (Object.keys(MODES) as PermissionMode[]).filter((m) => m !== "bypass" || s.bypassAllowed || s.mode === "bypass")
    .map((m) => ({ label: MODES[m].label, value: m, on: s.mode === m }));
  const models = (q: string): Choice[] => s.allowed.flatMap((ep) => ep.models.filter((m) => isChatModel(m) && (!q || matchesModel(q, m, ep)))
    .map((m) => ({ label: `${modelName(m)} · ${ep.name}`, value: m.id, on: current.source === "thread" && current.model?.offeringId === m.id })))
    .slice(0, 8);
  const filter = (all: () => Choice[]) => (q: string) => all().filter((c) => !q || c.label.toLowerCase().startsWith(q.toLowerCase()) || c.value.startsWith(q.toLowerCase()));
  const list: (Command | false)[] = [
    {
      // Picked from the menu it waits for its text, so "/" and Enter never compact; a sent "/compact" line runs.
      name: "compact", arg: "[what to keep]", label: "Compaction", bare: "complete",
      tip: "Compacts now: a summary replaces the older messages. Text after the command is what the summary must keep. While she works, it waits for her turn to end.",
      run: async (arg) => { await env.compact(arg); return "Compacting"; },
    },
    !!env.openContext && {
      name: "context", label: "Context", value: s.context ? `${s.context.percent}%` : undefined, num: true, bare: "run",
      tip: "What fills the context window.", run: () => { env.openContext!(); return ""; },
    },
    {
      name: "model", arg: "[name]", label: s.code ? "Coding" : "Conversation", value: current.modelId ? shortModel(current.modelId) : current.name, bare: "run",
      tip: "The model she talks on in this thread (Coding in Code mode). With a name, the first model that matches.",
      choices: models,
      run: async (arg) => {
        if (!arg) { env.openModel(); return ""; }
        const hit = models(arg).find((c) => c.value === arg) ?? models(arg)[0];
        if (!hit) throw new Error(`No model matches "${arg}".`);
        await env.setModel({ offeringId: hit.value });
        return `Model: ${hit.label}`;
      },
    },
    {
      name: "thinking", label: "Thinking", value: s.thinkingSet ? levelName(s.thinking) : `Default (${levelName(s.thinking)})`, bare: "complete",
      tip: "How long the conversation model thinks before it answers.", choices: filter(levels),
      run: (arg) => {
        const hit = fromChoices(levels(), arg, "thinking level");
        env.onSettings({ thinking: hit.value === "default" ? null : hit.value as ThinkingLevel });
        return `Thinking: ${hit.label}`;
      },
    },
    {
      name: "mode", label: "Mode", value: MODES[s.mode].label, bare: "complete",
      tip: "What she may do without asking.", choices: filter(modes),
      run: (arg) => {
        const hit = fromChoices(modes(), arg, "mode");
        env.onSettings({ mode: hit.value as PermissionMode });
        return `Mode: ${hit.label}`;
      },
    },
    {
      name: "code", label: "Code mode", value: onOff(s.code), bare: "run", tip: "Turns Code mode on or off.",
      run: (arg) => { const on = toggled(arg, s.code); env.onSettings({ code: on }); return `Code mode: ${onOff(on)}`; },
    },
    {
      name: "web", label: "Web search", value: onOff(s.webSearch), bare: "run", tip: "Turns web search on or off in this thread.",
      run: (arg) => { const on = toggled(arg, s.webSearch); env.onSettings({ webSearch: on }); return `Web search: ${onOff(on)}`; },
    },
    {
      name: "images", label: "Images", value: onOff(s.images), bare: "run", tip: "Lets the agent make and edit images in this thread, or stops it.",
      run: (arg) => { const on = toggled(arg, s.images); env.onSettings({ images: on }); return `Images: ${onOff(on)}`; },
    },
    {
      name: "rename", arg: "<title>", label: "Title", value: env.title, bare: "complete", tip: "Renames this thread.",
      run: async (arg) => { if (!arg) throw new Error("Write the new title after /rename."); await env.rename(arg); return `Renamed to ${arg}`; },
    },
    !!env.newThread && { name: "new", label: "New thread", bare: "run", tip: "Starts a new thread in this pool and opens it.", run: () => { env.newThread!(); return ""; } },
  ];
  return list.filter((c): c is Command => !!c);
}

/** The line as a command: its name and what follows, or undefined when it names none (it's sent as a message). */
export function parseCommand(line: string, commands: Command[]): { command: Command; arg: string } | undefined {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  const command = m && commands.find((c) => c.name === m[1]!.toLowerCase());
  return command ? { command, arg: (m[2] ?? "").trim() } : undefined;
}

type Row = { kind: "command"; command: Command } | { kind: "choice"; command: Command; choice: Choice };

/** What the popover lists for the draft: commands while the name is being typed, a command's choices after it. */
export function menuRows(draft: string, commands: Command[]): Row[] {
  const m = /^\/(\S*)( +)?([^\n]*)$/.exec(draft);
  if (!m) return [];
  if (m[2] === undefined) return commands.filter((c) => c.name.startsWith(m[1]!.toLowerCase())).map((command) => ({ kind: "command", command }));
  const command = commands.find((c) => c.name === m[1]!.toLowerCase());
  return command?.choices ? command.choices(m[3]!.trim()).map((choice) => ({ kind: "choice", command, choice })) : [];
}

/**
 * The popover's state for the message box: its rows, the keys it takes (Up, Down, Enter, Tab, Escape), and running a
 * whole line on send. `say` is what a screen reader hears after a command; `fail` shows why one couldn't run.
 */
export function useCommands(draft: string, setDraft: (text: string) => void, env: CommandEnv | undefined, opts: { say: (text: string) => void; fail: (message: string) => void; id: string }) {
  const commands = useMemo(() => (env ? commandList(env) : []), [env]);
  const [active, setActive] = useState(0);
  const [closedFor, setClosedFor] = useState<string>();
  const rows = closedFor === draft ? [] : menuRows(draft, commands);
  useEffect(() => setActive(0), [draft]);
  const at = Math.min(active, Math.max(0, rows.length - 1));

  const run = async (command: Command, arg: string) => {
    setDraft("");
    try {
      const said = await command.run(arg);
      if (said) opts.say(said);
    } catch (e) {
      setDraft(`/${command.name} ${arg}`.trimEnd());
      opts.fail((e as Error).message);
    }
  };
  // Enter runs a command that needs nothing more; Tab, or a command waiting for a choice or text, writes "/name " for what follows.
  const pick = (row: Row, how: "enter" | "tab") => {
    if (row.kind === "choice") return void run(row.command, row.choice.value);
    if (how === "enter" && row.command.bare === "run") return void run(row.command, "");
    setDraft(`/${row.command.name} `);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!rows.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
      return true;
    }
    if (e.key === "Escape") { e.preventDefault(); setClosedFor(draft); return true; }
    if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); pick(rows[at]!, "tab"); return true; }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); pick(rows[at]!, "enter"); return true; }
    return false;
  };

  /** On send: a line naming a command runs it instead of going to her. */
  const runLine = (text: string): boolean => {
    const hit = parseCommand(text, commands);
    if (!hit) return false;
    // A command that needs a choice waits for one; /compact on its own runs.
    if (hit.command.choices && hit.command.bare === "complete" && !hit.arg) { setDraft(`/${hit.command.name} `); return true; }
    void run(hit.command, hit.arg);
    return true;
  };

  const optionId = (i: number) => `${opts.id}-${i}`;
  const menu: ReactNode = rows.length ? (
    <div className="popover command-menu" role="listbox" id={opts.id} aria-label={rows[0]!.kind === "choice" ? rows[0]!.command.label : "Commands"}>
      {rows[0]!.kind === "choice" && <span className="eyebrow">{rows[0]!.command.label}</span>}
      {rows.map((row, i) => row.kind === "choice" ? (
        <button key={row.choice.value} type="button" id={optionId(i)} className="item opt" role="option" aria-selected={i === at} tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); pick(row, "enter"); }}>
          <span className="lbl">{row.choice.label}</span><span className="mk" aria-hidden="true">{row.choice.on ? "✓" : ""}</span>
        </button>
      ) : (
        <button key={row.command.name} type="button" id={optionId(i)} className="item" role="option" aria-selected={i === at} tabIndex={-1} title={row.command.tip}
          onMouseDown={(e) => { e.preventDefault(); pick(row, "enter"); }}>
          <span className="cmd">/{row.command.name}{row.command.arg && <span className="arg"> {row.command.arg}</span>}</span>
          <span className="lbl">{row.command.label}</span>
          <span className={`val${row.command.num ? " num" : ""}`}>{row.command.value ?? ""}</span>
        </button>
      ))}
    </div>
  ) : null;

  return {
    menu, onKeyDown, runLine,
    /** For the textarea: it controls the popover while it shows. */
    aria: { "aria-autocomplete": "list" as const, "aria-expanded": rows.length > 0, ...(rows.length ? { "aria-controls": opts.id, "aria-activedescendant": optionId(at) } : {}) },
  };
}
