// The model badge and its picker, and the thread settings drawer.
import { isChatModel, matchesModel, ModelLabel, modelName, shortModel } from "./ModelLabel.tsx";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  get, patch, u,
  type AllowedPaths, type EndpointInfo, type Grant, type ModelRef, type PermissionMode, type MachineInfo, type OfferingInfo, type Presets,
  type EvidenceSetting, type TaskModel, type ThinkingLevel, type ThreadSettings, type ThreadSettingsChange, type ThreadSummary, type ThreadTask,
} from "./api.ts";
import { Repositories } from "./Git.tsx";
import { McpServers } from "./Mcp.tsx";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { MODE_ORDER, MODES } from "./Modes.tsx";
import { VoiceDrawer } from "./ModelsFrame.tsx";
import type { ShellContext } from "./Shell.tsx";
import { ConfirmDialog, ErrorText, Switch, useAction, useDismiss, useInView, useLoad } from "./ui.tsx";

export const CODE_MODE_HINT = "Focus on the code: a coding model, a short persona, and only this project's memory and your working preferences.";
export const EVIDENCE_HINT = "When a code turn that changed something ends, the coding model judges the reply against what the tools showed, and sends her back once or twice if it isn't shown. Automatic judges only on a local model; a cloud model's tokens are a choice you make here.";
/** The Evidence judge select's choices, in order. */
export const EVIDENCE_CHOICES: [EvidenceSetting, string][] = [["auto", "Automatic (local models only)"], ["on", "On"], ["off", "Off"]];

export const TASK_LABELS: Record<ThreadTask, string> = {
  chat: "Main conversation",
  code: "Coding",
  "subagent.cheap": "Cheap subagents",
  "subagent.strong": "Strong subagents",
  title: "Titles",
  watching: "Watching threads",
  "image.create": "Images",
  "image.edit": "Image edits",
  "image.upscale": "Image upscaling",
  video: "Videos",
  "speech.transcribe": "Dictation",
  "speech.speak": "Read aloud",
};
/** The drawer's Models section after Conversation, Thinking and Fallback: its two quiet groups. */
const HELPER_TASKS: readonly ThreadTask[] = ["subagent.cheap", "subagent.strong", "title", "watching"];
const MEDIA_TASKS: readonly ThreadTask[] = ["image.create", "image.edit", "image.upscale", "video", "speech.transcribe", "speech.speak"];
const levelName = (l: ThinkingLevel) => l[0]!.toUpperCase() + l.slice(1);
/** What answers after the shown model: a thread's pick is a list of one, so it replaces the preset's whole list. */
const fallbackCount = (n: number) => (n ? <><span className="num">+{n}</span> fallback{n === 1 ? "" : "s"}</> : "no fallback");
/** Whether a model can do a thread task: the image, video and speech tasks need their capability; every other one is text. */
const fits = (task: ThreadTask, m: EndpointInfo["models"][number]) => (task === "image.create" ? !!m.image : task === "image.edit" ? !!m.edit : task === "image.upscale" ? !!m.upscale
  : task === "video" ? !!(m.video || m.animate || m.motion) : task === "speech.transcribe" ? !!m.transcribe : task === "speech.speak" ? !!m.speak?.voices.length : isChatModel(m));


const refKey = (m?: { offeringId: string }) => m?.offeringId ?? "";
const named = (t: TaskModel) => t.label ?? (t.modelId ? `${t.modelId} · ${t.endpointName}` : "a model that no longer exists");

/** The speaking model a task select shows, the thread's pick or else its preset's or column's, when the thread may use it: for its Settings drawer. */
function speaker(value: TaskModel, allowed: EndpointInfo[]): OfferingInfo | undefined {
  const first = value.list?.[0];
  const id = value.model?.offeringId ?? (first && "offeringId" in first ? first.offeringId : undefined);
  return allowed.flatMap((ep) => ep.models).find((m) => m.id === id && m.speak?.voices.length);
}

/** Always visible in the header: the main conversation's model, cloud or local, and its endpoint. */
export function ModelBadge({ base, settings, onChange, readOnly }: {
  base: string; settings: ThreadSettings; onChange: (s: ThreadSettings) => void; readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  useInView(anchor, open);
  const task = settings.code ? "code" : "chat";
  const chat = settings.models[task];
  const label = (
    <>
      <span className={`k ${chat.kind ?? ""}`}>{chat.kind ?? "no model"}</span>
      <span className="name">{chat.model ? (chat.modelId ? <ModelLabel model={chat.modelId} endpoint={chat.endpointName ?? ""} /> : named(chat)) : "Choose a model"}</span>
      {chat.problem && <span className="warn" title={chat.problem}> ⚠</span>}
    </>
  );
  if (readOnly) return <span className="badge model" data-kind={chat.kind}>{label}</span>;
  return (
    <span className="picker-anchor" ref={anchor}>
      <button ref={button} type="button" className="badge model" data-kind={chat.kind} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Model: ${chat.model ? (chat.modelId ? `${chat.modelId}, ${chat.kind}, ${chat.endpointName}` : named(chat)) : "none"}. Change`}
        onClick={() => setOpen(!open)}>{label}</button>
      {open && <ModelPicker base={base} settings={settings} task={task} onChange={(s) => { onChange(s); setOpen(false); }}
        onEscape={() => { close(); button.current?.focus(); }} />}
    </span>
  );
}

function ModelPicker({ base, settings, task, onChange, onEscape }: {
  base: string; settings: ThreadSettings; task: ThreadTask; onChange: (s: ThreadSettings) => void; onEscape: () => void;
}) {
  const [run, busy, error] = useAction();
  const [q, setQ] = useState("");
  const current = settings.models[task];
  const choose = (model: ModelRef | null) => run(async () => onChange(await patch<ThreadSettings>(`${base}/settings`, { models: { [task]: model } })));
  const eps = settings.allowed.map((ep) => ({ ep, models: ep.models.filter((m) => fits(task, m)) }));
  const count = eps.reduce((n, x) => n + x.models.length, 0);
  const shown = q.trim() ? eps.map((x) => ({ ...x, models: x.models.filter((m) => matchesModel(q, m, x.ep)) })).filter((x) => x.models.length) : eps;
  // Down and Up move between the search box and the models; Enter in the box picks the first match.
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.stopPropagation(); onEscape(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const stops = [...e.currentTarget.querySelectorAll<HTMLElement>("input, .picker-item:not(:disabled)")];
    const i = stops.indexOf(document.activeElement as HTMLElement);
    const next = stops[e.key === "ArrowDown" ? Math.min(i + 1, stops.length - 1) : Math.max(i - 1, 0)];
    if (next) { e.preventDefault(); next.focus(); }
  };
  return (
    <div className="picker model-pick" role="dialog" aria-label={`Model for ${TASK_LABELS[task].toLowerCase()}`} onKeyDown={move}>
      {settings.localOnly && <p className="muted small">Only local models: this thread is {settings.parent ? "under a local-only thread" : "local-only"}.</p>}
      {count > 0 && (
        <input type="search" aria-label="Search models" placeholder={`Search ${count} models`} autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const first = shown[0]?.models[0]; if (first && !busy) choose({ offeringId: first.id }); } }} />
      )}
      {shown.map(({ ep, models }) => (
        <div key={ep.id} className="picker-group">
          <div className="picker-ep"><span className={`k ${ep.kind}`}>{ep.kind}</span> {ep.name}</div>
          {models.map((m) => {
            const ref_ = { offeringId: m.id };
            const on = current.source === "thread" && refKey(current.model) === refKey(ref_);
            return (
              <button key={m.id} type="button" className="picker-item" aria-pressed={on} disabled={busy} onClick={() => choose(ref_)}>
                <ModelLabel model={modelName(m)} endpoint={ep.name} />{on && <Icon name="check" />}
              </button>
            );
          })}
          {!ep.models.length && <p className="muted small">No models. Add one in the control panel.</p>}
        </div>
      ))}
      {q.trim() && !shown.length && <p className="muted small">No models match.</p>}
      {!settings.allowed.length && <p className="muted small">No endpoints yet. Add one in the control panel.</p>}
      <button type="button" className="picker-item" aria-pressed={current.source !== "thread"} disabled={busy} onClick={() => choose(null)}>
        Use the preset's choice
      </button>
      <ErrorText error={error} />
    </div>
  );
}

export function SettingsDrawer({ ctx, base, summary, settings, machines, onSettings, onSummary, onClose, id = "thread-settings" }: {
  ctx: ShellContext; base: string; summary: ThreadSummary; settings: ThreadSettings;
  /** The user's machines; those of the thread's pool can be granted. */
  machines: MachineInfo[];
  /** The element id the header button's aria-controls names; one per Thread tree, since two can share a page. */
  id?: string;
  onSettings: (s: ThreadSettings) => void; onSummary: (s: ThreadSummary) => void; onClose: () => void;
}) {
  const userId = ctx.user.id;
  const [run, busy, error] = useAction();
  const sub = summary.subagent;
  const pool = summary.pool;
  const change = (c: ThreadSettingsChange) => run(async () => onSettings(await patch<ThreadSettings>(`${base}/settings`, c)));
  const changeThread = (c: { title?: string; hidden?: boolean }) => run(async () => onSummary(await patch<ThreadSummary>(base, c)));
  const paths = useLoad(() => get<AllowedPaths>(u(userId, "paths")), [userId]);
  const presets = useLoad(() => get<Presets>(u(userId, "presets")), [userId]);
  // A private or local-only thread may choose only a private preset, so a general choice it can no longer use shows as its column.
  const usablePresets = (presets.data?.presets ?? []).filter((p) => !settings.localOnly || p.scope === "private");
  const chosenPreset = settings.preset && usablePresets.some((p) => p.id === settings.preset) ? settings.preset : "";
  const [title, setTitle] = useState(summary.title ?? "");
  const ref = useRef<HTMLElement>(null);
  // Read aloud's model's voice drawer (Models' own), over this one; Escape closes it first, and focus goes back to its link.
  const speaking = speaker(settings.models["speech.speak"], settings.allowed);
  const [voice, setVoice] = useState<OfferingInfo>();
  const voiceLink = useRef<HTMLButtonElement>(null);
  const closeVoice = useCallback(() => { setVoice(undefined); voiceLink.current?.focus(); }, []);
  const voiceOpen = useRef(false);
  voiceOpen.current = !!voice;
  // Focus moves in once, when the drawer opens: the thread re-renders on every streamed event, and
  // re-focusing then would pull focus out of a dialog opened from the drawer.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && !voiceOpen.current && closeRef.current();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  const talk = settings.code ? "code" : "chat";
  const taskRow = (task: ThreadTask) => {
    const select = <TaskSelect key={task} task={task} value={settings.models[task]} allowed={settings.allowed} onChange={(m) => change({ models: { [task]: m } })} />;
    return task === "speech.speak" && speaking ? (
      <div key={task} className="inline speak-row">
        {select}
        <button ref={voiceLink} type="button" className="link sm" aria-label={`${speaking.modelId} settings`} onClick={() => setVoice(speaking)}>Settings</button>
      </div>
    ) : select;
  };

  return (<>
    <aside id={id} ref={ref} tabIndex={-1} className="drawer" aria-label="Thread settings">
      <div className="drawer-head">
        <h2>Thread settings</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <div className="drawer-body">
        {sub && <p className="muted">A subagent inherits its parent's settings and can only narrow them, so they're shown read-only here.</p>}
        <ErrorText error={error} />
        <fieldset className="group" disabled={sub || busy}>
          <legend title={summary.project ? "New threads copy these." : undefined}>Models</legend>
          <label className="field">
            <span>Preset</span>
            <select value={chosenPreset} onChange={(e) => change({ preset: e.target.value || null })}>
              <option value="">{`${pool === "general" ? "General" : "Private"} threads (${settings.profile})`}</option>
              {usablePresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {/* One select for what she talks on: Coding in Code mode, Main conversation otherwise, as the header's badge. */}
          <TaskSelect task={talk} label="Conversation" value={settings.models[talk]} allowed={settings.allowed} onChange={(m) => change({ models: { [talk]: m } })} />
          <label className="field" title="How long the conversation model thinks before it answers.">
            <span>Thinking</span>
            <select value={settings.thinkingSet ? settings.thinking : ""} onChange={(e) => change({ thinking: (e.target.value || null) as ThinkingLevel | null })}>
              <option value="">{settings.thinkingSet ? "Default" : `Default (${levelName(settings.thinking)})`}</option>
              {[...new Set([...settings.thinkingLevels, ...(settings.thinkingSet ? [settings.thinking] : [])])].map((l) => <option key={l} value={l}>{levelName(l)}</option>)}
            </select>
          </label>
          <NetSwitch label="Fallback" hint="When off, only the first model in each list answers; if it can't, the message waits for it." value={settings.fallback} effective={settings.fallbackOn}
            onChange={(v) => change({ fallback: v })} />
          <fieldset className="subgroup">
            <legend>Helpers</legend>
            {/* Watching threads only in a project chat, the one thread that makes looks. */}
            {HELPER_TASKS.filter((task) => task !== "watching" || summary.project).map((task) => taskRow(task))}
          </fieldset>
          <fieldset className="subgroup">
            <legend>Images and speech</legend>
            {MEDIA_TASKS.map((task) => taskRow(task))}
          </fieldset>
        </fieldset>

        <fieldset className="group" disabled={sub || busy}>
          <legend>Privacy and network</legend>
          <Switch label="Local-only" checked={settings.localOnly} disabled={pool === "private"}
            hint={pool === "private" ? "Always on in private threads." : "This conversation's model calls stay on your own machines."}
            onChange={(v) => change({ localOnly: v })} />
          <NetSwitch label="Internet" hint="For her commands and fetches." value={settings.internet} effective={settings.network.internet}
            onChange={(v) => change({ internet: v })} />
          <NetSwitch label="Local services (localhost)" hint={`Programs running on ${her()}'s own server, such as a database. Never ${her()}'s own page.`} value={settings.services} effective={settings.network.services}
            onChange={(v) => change({ services: v })} />
          <Hosts hosts={settings.hosts ?? settings.network.hosts} overridden={settings.hosts !== null} onChange={(hosts) => change({ hosts })} />
        </fieldset>

        <fieldset className="group" disabled={sub || busy}>
          <legend>Folders</legend>
          <Folders grants={settings.grants} allowed={paths.data?.[pool] ?? []} onChange={(grants) => change({ grants })} />
        </fieldset>

        <fieldset className="group" disabled={sub || busy}>
          <legend>Machines</legend>
          <Machines granted={settings.machines} machines={machines.filter((m) => m.pool === pool)} onChange={(names) => change({ machines: names })} />
        </fieldset>

        <fieldset className="group" disabled={sub || busy}>
          <legend>Repositories</legend>
          <Repositories userId={userId} pool={pool} granted={settings.repositories} onChange={(repositories) => change({ repositories })} />
        </fieldset>

        <fieldset className="group" disabled={sub || busy}>
          <legend>MCP servers</legend>
          <McpServers userId={userId} pool={pool} granted={settings.mcpServers} onChange={(mcpServers) => change({ mcpServers })} />
        </fieldset>

        <fieldset className="group" disabled={sub || busy}>
          <legend>Behaviour</legend>
          <label className="field"><span>Mode</span>
            <select value={settings.mode} onChange={(e) => change({ mode: e.target.value as PermissionMode })}>
              {MODE_ORDER.map((m) => <option key={m} value={m} title={MODES[m].description}>{MODES[m].label}</option>)}
            </select>
          </label>
          <Switch label="Code mode" hint={CODE_MODE_HINT} checked={settings.code} onChange={(v) => change({ code: v })} />
          <label className="field" title={EVIDENCE_HINT}><span>Evidence judge</span>
            <select value={settings.evidence} onChange={(e) => change({ evidence: e.target.value as EvidenceSetting })}>
              {EVIDENCE_CHOICES.map(([v, name]) => <option key={v} value={v}>{name}</option>)}
            </select>
          </label>
          <Switch label="Web search" hint={settings.searchProvider ? undefined : "Search needs a SearXNG or Kiwix address in Administration"} checked={settings.webSearch} onChange={(v) => change({ webSearch: v })} />
          <Switch label="Images" checked={settings.images} onChange={(v) => change({ images: v })} />
          {(settings.claudeCodeOffered || settings.claudeCode) && (
            <Switch label="Claude Code" hint="Coding jobs on your Claude plan. What it reads goes to Anthropic." checked={settings.claudeCode} onChange={(v) => change({ claudeCode: v })} />
          )}
          <Switch label="Do not log thread in memory" hint="She can still read her memory here. Subagents inherit this."
            checked={settings.unlogged} onChange={(v) => change({ unlogged: v })} />
        </fieldset>

        <fieldset className="group" disabled={busy}>
          <legend>Thread</legend>
          <form className="inline" onSubmit={(e) => { e.preventDefault(); changeThread({ title }); }}>
            <label className="field grow"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <button type="submit" disabled={!title.trim() || title === summary.title}>Rename</button>
          </form>
          <div className="row">
            <button type="button" onClick={() => changeThread({ hidden: !summary.hidden })}>{summary.hidden ? "Unhide" : "Hide"}</button>
          </div>
        </fieldset>
      </div>
    </aside>
    {voice && <VoiceDrawer userId={userId} model={voice} onClose={closeVoice} />}
  </>);
}

export function TaskSelect({ task, label, value, allowed, onChange }: {
  task: ThreadTask; label?: string; value: TaskModel; allowed: EndpointInfo[]; onChange: (m: ModelRef | null) => void;
}) {
  // While no model can answer, `model` is absent: the thread's pick is still its list's first.
  const first = value.list?.[0];
  const current = value.source === "thread" ? refKey(value.model ?? (first && "offeringId" in first ? first : undefined)) : "";
  const fromPreset = (value.source === "preset" || value.source === "column") && value.model
    ? `${value.kind ? `${value.kind} · ` : ""}${value.modelId ? `${value.name ?? shortModel(value.modelId)} · ${value.endpointName}` : named(value)}` : "nothing set";
  // Picking a cloud Dictation model is the consent to send this thread's voice to the cloud, so it asks first.
  const [cloudPick, setCloudPick] = useState<{ id: string; name: string }>();
  // The count describes the select rather than naming it, so the select keeps the task's name.
  const countId = useId();
  const counted = value.fallbacks !== undefined;
  return (<>
    <label className="field">
      <span className="with-count">{label ?? TASK_LABELS[task]}{counted && (
        <span id={countId} className="fallbacks" aria-hidden="true" title={value.source === "thread" ? "A pick here replaces the preset's whole list." : undefined}>{fallbackCount(value.fallbacks!)}</span>
      )}</span>
      {/* An option can't carry a tooltip, so the select's holds the chosen model's whole ID. */}
      <select value={current} aria-describedby={counted ? countId : undefined} title={(current ? allowed.flatMap((x) => x.models).find((m) => m.id === current)?.modelId : value.modelId) ?? undefined} onChange={(e) => {
        const id = e.target.value;
        const ep = allowed.find((x) => x.models.some((m) => m.id === id));
        const m = ep?.models.find((x) => x.id === id);
        if (task === "speech.transcribe" && ep?.kind === "cloud" && m) setCloudPick({ id, name: `${modelName(m)} on ${ep.name}` });
        else onChange(id ? { offeringId: id } : null);
      }}>
        <option value="">Preset ({fromPreset})</option>
        {allowed.filter((ep) => ep.models.some((m) => fits(task, m))).map((ep) => (
          <optgroup key={ep.id} label={`${ep.name} (${ep.kind})`}>
            {ep.models.filter((m) => fits(task, m)).map((m) => <option key={m.id} value={m.id}>{ep.kind} · {shortModel(modelName(m))} · {ep.name}</option>)}
          </optgroup>
        ))}
        {/* A thread choice that is no longer allowed still shows, so the select says what's set. */}
        {current && !allowed.some((ep) => ep.models.some((m) => m.id === current)) && (
          <option value={current}>{named(value)} (not available)</option>
        )}
      </select>
      {value.problem && <small className="error">{value.problem}</small>}
    </label>
    {cloudPick && (
      <ConfirmDialog title="Send your voice to the cloud?" confirm="Use cloud dictation"
        sentence={`In this thread, what you dictate goes to ${cloudPick.name}, a cloud service, to be written out.`}
        onCancel={() => setCloudPick(undefined)} onConfirm={() => { onChange({ offeringId: cloudPick.id }); setCloudPick(undefined); }} />
    )}
  </>);
}

/** A network switch: the thread's override, or the default for its pool. */
function NetSwitch({ label, hint, value, effective, onChange }: {
  label: string; hint: string; value: boolean | null; effective: boolean; onChange: (v: boolean | null) => void;
}) {
  return (
    <div className="net-switch">
      <Switch label={label} hint={value === null ? `${hint} Following your default.` : hint} checked={value ?? effective} onChange={onChange} />
      {value !== null && <button type="button" className="quiet small" onClick={() => onChange(null)}>Use default</button>}
    </div>
  );
}

function Hosts({ hosts, overridden, onChange }: { hosts: string[]; overridden: boolean; onChange: (h: string[] | null) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="field">
      <span>Allowed hosts</span>
      {hosts.length ? (
        <ul className="chips">
          {hosts.map((h) => (
            <li key={h}>{h}<button type="button" className="icon sm" aria-label={`Remove ${h}`} onClick={() => onChange(hosts.filter((x) => x !== h))}><Icon name="close" /></button></li>
          ))}
        </ul>
      ) : <span className="muted small">None</span>}
      <form className="inline" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onChange([...hosts, draft.trim()]); setDraft(""); } }}>
        <input aria-label="Add an allowed host" placeholder="192.168.1.40:8006, nas.lan, 10.0.0.0/24" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" disabled={!draft.trim()}>Add</button>
      </form>
      {overridden && <button type="button" className="quiet small" onClick={() => onChange(null)}>Use default list</button>}
    </div>
  );
}

export function Folders({ grants, allowed, onChange }: { grants: Grant[]; allowed: string[]; onChange: (g: Grant[]) => void }) {
  const listId = useId();
  const [draft, setDraft] = useState("");
  const set = (i: number, g: Grant | null) => onChange(grants.flatMap((x, j) => (j === i ? (g ? [g] : []) : [x])));
  // The first allowed folder not yet granted, so the hint never invites a second grant of one.
  const next = allowed.find((p) => !grants.some((g) => g.path === p)) ?? "";
  const add = () => { if (draft) { onChange([...grants, { path: draft, writable: false }]); setDraft(""); } };
  return (
    <>
      {grants.map((g, i) => (
        <div key={g.path} className="folder">
          <span className="path">{g.path}</span>
          <select aria-label={`Access to ${g.path}`} value={g.writable ? "rw" : "ro"} onChange={(e) => set(i, { ...g, writable: e.target.value === "rw" })}>
            <option value="ro">read-only</option>
            <option value="rw">read-write</option>
          </select>
          <button type="button" className="icon sm" aria-label={`Remove ${g.path}`} onClick={() => set(i, null)}><Icon name="close" /></button>
        </div>
      ))}
      {!grants.length && <span className="muted small">No folders granted.</span>}
      {allowed.length > 0 ? (
        // Not a form of its own: on the Project settings page it sits inside the page's form.
        <div className="inline">
          <input aria-label="Add a folder" list={listId} placeholder={next} value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <datalist id={listId}>{allowed.map((p) => <option key={p} value={p} />)}</datalist>
          <button type="button" disabled={!draft} onClick={add}>Add</button>
        </div>
      ) : <span className="muted small">An administrator hasn't allowed any folders for this pool.</span>}
    </>
  );
}

/**
 * The sandbox, always, then each granted machine with ✕ to take it off; + opens a search of the pool's
 * other machines. A granted one that no longer exists still shows, so it can be taken off. Also on the Project settings page.
 */
export function Machines({ granted, machines, onChange }: { granted: string[]; machines: MachineInfo[]; onChange: (names: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  useDismiss(anchor, open, close);
  const others = machines.filter((m) => !granted.includes(m.name));
  const q = query.trim().toLowerCase();
  const found = others.filter((m) => !q || m.name.toLowerCase().includes(q) || m.address.toLowerCase().includes(q));
  const add = (name: string) => { onChange([...granted, name]); close(); plus.current?.focus(); };
  return (
    <>
      <div className="folder"><span className="path">sandbox</span><span className="muted small">always</span><span /></div>
      {granted.map((name) => {
        const m = machines.find((x) => x.name === name);
        return (
          <div key={name} className="folder">
            <span className="path" title={m ? m.address : undefined}>{name}</span>
            <span className="muted small">{m ? `up to ${MODES[m.limit].label}` : "removed"}</span>
            <button type="button" className="icon sm" aria-label={`Remove ${name}`} title={m ? undefined : "No longer one of your machines."}
              onClick={() => onChange(granted.filter((n) => n !== name))}><Icon name="close" /></button>
          </div>
        );
      })}
      {!machines.length && !granted.length && <span className="muted small">No machines in this pool.</span>}
      {others.length > 0 && (
        <span className="picker-anchor machine-add" ref={anchor}>
          <button ref={plus} type="button" className="icon sm" aria-label="Add machine" title="Add machine" aria-haspopup="dialog" aria-expanded={open}
            onClick={() => (open ? close() : setOpen(true))}><Icon name="plus" /></button>
          {open && (
            <div className="picker machine-pick" role="dialog" aria-label="Add machine"
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); plus.current?.focus(); } }}>
              <input type="search" aria-label="Search machines" autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (found[0]) add(found[0].name); } }} />
              {found.map((m) => (
                <button key={m.name} type="button" className="picker-item" onClick={() => add(m.name)}>
                  <span className="mono">{m.name}</span> <span className="muted small">{m.address}</span>
                </button>
              ))}
              {!found.length && <p className="muted small">No machine matches.</p>}
            </div>
          )}
        </span>
      )}
    </>
  );
}

