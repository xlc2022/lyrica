// The model badge and its picker, and the thread settings drawer.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  del, get, patch, u, THREAD_TASKS,
  type AllowedPaths, type EndpointInfo, type Grant, type ModelRef, type PermissionMode, type MachineInfo,
  type TaskModel, type ThreadSettings, type ThreadSettingsChange, type ThreadSummary, type ThreadTask,
} from "./api.ts";
import { Icon } from "./icons.tsx";
import { MODE_ORDER, MODES } from "./Modes.tsx";
import { go } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { Confirm, ConfirmDialog, ErrorText, Switch, useAction, useDismiss, useLoad } from "./ui.tsx";

export const TASK_LABELS: Record<ThreadTask, string> = {
  chat: "Main conversation",
  "subagent.cheap": "Cheap subagents",
  "subagent.strong": "Strong subagents",
  title: "Titles",
  "speech.transcribe": "Dictation",
  "speech.speak": "Read aloud",
};
/** Speech tasks offer only models that transcribe or speak. */
const fits = (task: ThreadTask, m: EndpointInfo["models"][number]) => (task === "speech.transcribe" ? !!m.transcribe : task === "speech.speak" ? !!m.speak?.voices.length : true);


const refKey = (m?: { offeringId: string }) => m?.offeringId ?? "";
const named = (t: TaskModel) => t.label ?? (t.modelId ? `${t.modelId} · ${t.endpointName}` : "a model that no longer exists");

/** Always visible in the header: the main conversation's model, cloud or local, and its endpoint. */
export function ModelBadge({ base, settings, onChange, readOnly }: {
  base: string; settings: ThreadSettings; onChange: (s: ThreadSettings) => void; readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  const chat = settings.models.chat;
  const label = (
    <>
      <span className={`k ${chat.kind ?? ""}`}>{chat.kind ?? "no model"}</span>
      <span className="name">{chat.model ? (chat.modelId ? `${chat.modelId} · ${chat.endpointName}` : named(chat)) : "Choose a model"}</span>
      {chat.problem && <span className="warn" title={chat.problem}> ⚠</span>}
    </>
  );
  if (readOnly) return <span className="badge model" data-kind={chat.kind}>{label}</span>;
  return (
    <span className="picker-anchor" ref={anchor}>
      <button type="button" className="badge model" data-kind={chat.kind} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Model: ${chat.model ? (chat.modelId ? `${chat.modelId}, ${chat.kind}, ${chat.endpointName}` : named(chat)) : "none"}. Change`}
        onClick={() => setOpen(!open)}>{label}</button>
      {open && <ModelPicker base={base} settings={settings} task="chat" onChange={(s) => { onChange(s); setOpen(false); }} />}
    </span>
  );
}

function ModelPicker({ base, settings, task, onChange }: {
  base: string; settings: ThreadSettings; task: ThreadTask; onChange: (s: ThreadSettings) => void;
}) {
  const [run, busy, error] = useAction();
  const current = settings.models[task];
  const choose = (model: ModelRef | null) => run(async () => onChange(await patch<ThreadSettings>(`${base}/settings`, { models: { [task]: model } })));
  return (
    <div className="picker" role="dialog" aria-label={`Model for ${TASK_LABELS[task].toLowerCase()}`}>
      {settings.localOnly && <p className="muted small">Only local models: this thread is {settings.parent ? "under a local-only thread" : "local-only"}.</p>}
      {settings.allowed.map((ep) => (
        <div key={ep.id} className="picker-group">
          <div className="picker-ep"><span className={`k ${ep.kind}`}>{ep.kind}</span> {ep.name}</div>
          {ep.models.map((m) => {
            const ref_ = { offeringId: m.id };
            const on = current.source === "thread" && refKey(current.model) === refKey(ref_);
            return (
              <button key={m.id} type="button" className="picker-item" aria-pressed={on} disabled={busy} onClick={() => choose(ref_)}>
                {m.modelId}{on && <Icon name="check" />}
              </button>
            );
          })}
          {!ep.models.length && <p className="muted small">No models. Add one in the control panel.</p>}
        </div>
      ))}
      {!settings.allowed.length && <p className="muted small">No endpoints yet. Add one in the control panel.</p>}
      <button type="button" className="picker-item" aria-pressed={current.source === "profile"} disabled={busy} onClick={() => choose(null)}>
        Use the profile's choice
      </button>
      <ErrorText error={error} />
    </div>
  );
}

export function SettingsDrawer({ ctx, base, summary, settings, machines, onSettings, onSummary, onClose, children = 0, id = "thread-settings" }: {
  ctx: ShellContext; base: string; summary: ThreadSummary; settings: ThreadSettings;
  /** The user's machines; those of the thread's pool can be granted. */
  machines: MachineInfo[];
  /** Its child threads listed under it: forgetting asks whether they go too. */
  children?: number;
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
  const [title, setTitle] = useState(summary.title ?? "");
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <aside id={id} ref={ref} tabIndex={-1} className="drawer" aria-label="Thread settings">
      <div className="drawer-head">
        <h2>Thread settings</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <div className="drawer-body">
        {sub && <p className="muted">A subagent inherits its parent's settings and can only narrow them, so they're shown read-only here.</p>}
        <ErrorText error={error} />
        <fieldset className="group" disabled={sub || busy}>
          <legend>Models</legend>
          {THREAD_TASKS.map((task) => (
            <TaskSelect key={task} task={task} value={settings.models[task]} allowed={settings.allowed} onChange={(m) => change({ models: { [task]: m } })} />
          ))}
          <NetSwitch label="Fallback" hint="When off, only the first model in each list answers; if it can't, the message waits for it." value={settings.fallback} effective={settings.fallbackOn}
            onChange={(v) => change({ fallback: v })} />
        </fieldset>

        <fieldset className="group" disabled={sub || busy}>
          <legend>Privacy and network</legend>
          <Switch label="Local-only" checked={settings.localOnly} disabled={pool === "private"}
            hint={pool === "private" ? "Always on in private threads." : "This conversation's model calls stay on your own machines."}
            onChange={(v) => change({ localOnly: v })} />
          <NetSwitch label="Internet" hint="For her commands and fetches." value={settings.internet} effective={settings.network.internet}
            onChange={(v) => change({ internet: v })} />
          <NetSwitch label="Local services (localhost)" hint="Programs running on Lyrica's own server, such as a database. Never Lyrica's own page." value={settings.services} effective={settings.network.services}
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
          <legend>Behaviour</legend>
          <label className="field"><span>Mode</span>
            <select value={settings.mode} onChange={(e) => change({ mode: e.target.value as PermissionMode })}>
              {MODE_ORDER.map((m) => <option key={m} value={m} title={MODES[m].description}>{MODES[m].label}</option>)}
            </select>
          </label>
          <Switch label="Web search" checked={settings.webSearch} onChange={(v) => change({ webSearch: v })} />
          <Switch label="Images" checked={settings.images} onChange={(v) => change({ images: v })} />
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
            {!sub && (
              <Forget children={children} onForget={(withChildren) => run(async () => {
                await del(base, { children: withChildren }); ctx.refreshThreads(); go({ page: "home", userId });
              })} />
            )}
          </div>
        </fieldset>
      </div>
    </aside>
  );
}

export function TaskSelect({ task, label, value, allowed, onChange }: {
  task: ThreadTask; label?: string; value: TaskModel; allowed: EndpointInfo[]; onChange: (m: ModelRef | null) => void;
}) {
  // While no model can answer, `model` is absent: the thread's pick is still its list's first.
  const first = value.list?.[0];
  const current = value.source === "thread" ? refKey(value.model ?? (first && "offeringId" in first ? first : undefined)) : "";
  const fromProfile = value.source === "profile" && value.model
    ? `${value.kind ? `${value.kind} · ` : ""}${value.modelId ? `${value.modelId} · ${value.endpointName}` : named(value)}` : "nothing set";
  // Picking a cloud Dictation model is the consent to send this thread's voice to the cloud, so it asks first.
  const [cloudPick, setCloudPick] = useState<{ id: string; name: string }>();
  return (<>
    <label className="field">
      <span>{label ?? TASK_LABELS[task]}</span>
      <select value={current} onChange={(e) => {
        const id = e.target.value;
        const ep = allowed.find((x) => x.models.some((m) => m.id === id));
        const m = ep?.models.find((x) => x.id === id);
        if (task === "speech.transcribe" && ep?.kind === "cloud" && m) setCloudPick({ id, name: `${m.modelId} on ${ep.name}` });
        else onChange(id ? { offeringId: id } : null);
      }}>
        <option value="">Profile ({fromProfile})</option>
        {allowed.filter((ep) => ep.models.some((m) => fits(task, m))).map((ep) => (
          <optgroup key={ep.id} label={`${ep.name} (${ep.kind})`}>
            {ep.models.filter((m) => fits(task, m)).map((m) => <option key={m.id} value={m.id}>{ep.kind} · {m.modelId} · {ep.name}</option>)}
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

/** The sandbox, always, then each machine of the thread's pool with a switch; a granted one that no longer exists still shows, so it can be taken off. Also on the Project settings page. */
export function Machines({ granted, machines, onChange }: { granted: string[]; machines: MachineInfo[]; onChange: (names: string[]) => void }) {
  const gone = granted.filter((name) => !machines.some((m) => m.name === name));
  const toggle = (name: string, on: boolean) => onChange(on ? [...granted, name] : granted.filter((n) => n !== name));
  return (
    <>
      <div className="folder"><span className="path">sandbox</span><span className="muted small">always</span><span /></div>
      {machines.map((m) => <Switch key={m.name} label={m.name} hint={`${m.address} · up to ${MODES[m.limit].label}`} checked={granted.includes(m.name)} onChange={(on) => toggle(m.name, on)} />)}
      {gone.map((name) => <Switch key={name} label={name} hint="No longer one of your machines." checked onChange={() => toggle(name, false)} />)}
    </>
  );
}

/** Forgetting a thread asks first, and whether its child threads go too (ticked). */
function Forget({ children, onForget }: { children: number; onForget: (withChildren: boolean) => void }) {
  return (
    <Confirm label="Forget this thread" danger confirm="Forget it" onConfirm={onForget}
      question="Forget this thread? Its messages are deleted, along with what was learned only from it. This can't be undone."
      {...(children > 0 ? { option: `Also forget its ${children === 1 ? "child thread" : `${children} child threads`}` } : {})} />
  );
}
