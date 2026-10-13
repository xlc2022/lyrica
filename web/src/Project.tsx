// Projects (DESIGN.md "Projects", docs/ux.md §6): the project chat's Threads fact and
// tokens, the card each of its threads gets under the message that started it, the
// Suggested threads card, and the Project settings page.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  del, get, patch, post, put, threadPath, u,
  type CommandRule, type AllowedPaths, type GitRepository, type Grant, type MachineInfo, type MessagePart, type ModelRef, type PermissionMode, type Pool, type ProjectOverview, type ThinkingLevel, type ThreadChange, type ThreadSettings, type ThreadSummary,
} from "./api.ts";
import { ChecklistButton, StepLine } from "./Checklist.tsx";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { MODE_ORDER, MODES } from "./Modes.tsx";
import { href } from "./route.ts";
import { Repositories } from "./Git.tsx";
import { McpServers } from "./Mcp.tsx";
import { Folders, Machines, TaskSelect } from "./Settings.tsx";
import { Main, PageHead, type ShellContext } from "./Shell.tsx";
import { ErrorText, Prose, Switch, useAction, useDismiss, useLoad, wakeTime } from "./ui.tsx";

/** A project thread's state, in the sidebar's words. */
export function stateWord(t: Pick<ThreadSummary, "state" | "needsYou">): string {
  if (t.needsYou) return "Waiting on you";
  switch (t.state) {
    case "waiting": return "Waiting for approval";
    case "working": return "Working";
    case "queued": return "Queued";
    case "resolved": return "Resolved";
    default: return "Idle";
  }
}

/** "312k tokens", "1.2M tokens". */
export const tokenCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The project's threads, how many wait on the user and its tokens; reloaded when `tick` changes. Nothing for a plain thread. */
export function useOverview(userId: string, pool: Pool, threadId: string, project: boolean, tick: number) {
  const base = threadPath(userId, pool, threadId);
  return useLoad(() => (project ? get<ProjectOverview>(`${base}/overview`) : Promise.resolve(undefined)), [base, project, tick]);
}

/** What a project chat gives its conversation: the threads for the cards, and what to do after one changes. */
export interface ProjectEnv {
  overview: ProjectOverview;
  /** The last update each thread sent, by thread ID: its first line goes on the card. */
  lastUpdates: ReadonlyMap<string, string>;
  /** A thread was started, stopped, resolved, reopened, pinned or unpinned here. */
  onChange: () => void;
  /** The shell's toast, for what Pin and Unpin did. */
  toast: (text: string) => void;
}

const GROUPS: { label: string; of: (t: ThreadSummary) => boolean }[] = [
  { label: "Waiting on you", of: (t) => t.state === "waiting" },
  { label: "Working", of: (t) => t.state === "working" },
  { label: "Queued", of: (t) => t.state === "queued" },
  { label: "Idle", of: (t) => t.state === "idle" || t.state === undefined },
  { label: "Resolved", of: (t) => t.state === "resolved" },
];

/** "Threads 4 ▾" in the project chat's facts line: a popover of its threads grouped by state. */
export function ThreadsFact({ userId, overview, phone }: { userId: string; overview: ProjectOverview; phone?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  const threads = overview.threads;
  return (
    <span className="picker-anchor" ref={anchor}>
      <button type="button" className="link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        Threads <span className="num">{threads.length}</span> <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="picker threads-pop" role="dialog" aria-label="The project's threads">
          {phone && <p className="small tokens"><span className="num">{tokenCount(overview.tokens)}</span> tokens</p>}
          {!threads.length && <p className="muted small">No threads yet. Ask {her()} for some, or pick Start a thread in a message's menu.</p>}
          {GROUPS.map((g) => {
            const mine = threads.filter(g.of);
            if (!mine.length) return null;
            return (
              <div key={g.label} className="picker-group">
                <div className="picker-ep">{g.label} <span className="num">{mine.length}</span></div>
                {mine.map((t) => (
                  <a key={t.id} className="picker-item thread-item" href={href({ page: "thread", userId, pool: t.pool, threadId: t.id })} onClick={close}>
                    {t.state === "idle" || t.state === "queued" || !t.state ? <span /> : <span className="status" data-state={t.needsYou ? "needsYou" : t.state} aria-hidden="true" />}
                    <span className="title">{t.title || "New thread"}</span>
                    {!!t.unseen && <span className="count">{t.unseen}</span>}
                  </a>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}

/**
 * One of the project's threads, under the message that started it: its title as written,
 * its state as a dot and a word (then its checklist's count, and when it next wakes), its current step, what it
 * waits on, the last update's first line, and Open, Stop, Pin or Unpin, Resolve or Reopen behind ⋯. A pinned one sits
 * first among the project's threads in the sidebar. A thread waiting on the user counts as waiting for an answer.
 */
export function ThreadCard({ t, userId, env }: { t: ThreadSummary; userId: string; env: ProjectEnv }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const [run, busy, error] = useAction();
  const base = threadPath(userId, t.pool, t.id);
  const act = (path: string) => run(async () => { close(); await post(`${base}/${path}`); env.onChange(); });
  const pin = () => run(async () => {
    close();
    await (t.pinned ? del(`${base}/pin`) : put(`${base}/pin`, {}));
    env.onChange();
    env.toast(t.pinned ? "Unpinned" : "Pinned to the top");
  });
  const state = t.needsYou ? "needsYou" : t.state ?? "idle";
  const update = env.lastUpdates.get(t.id);
  const line = update?.split("\n").find((l) => l.trim())?.trim();
  const open_ = href({ page: "thread", userId, pool: t.pool, threadId: t.id });
  return (
    <div className="tcard" data-state={state} {...(t.needsYou ? { "data-pending": "Thread" } : {})}>
      <div className="tcard-head" data-dot={state !== "idle" && state !== "queued" ? "" : undefined}>
        {state !== "idle" && state !== "queued" && <span className="status" data-state={state} aria-hidden="true" />}
        <a className="tcard-title" href={open_}>{t.title || "New thread"}</a>
        <span className="tstate" data-state={state}>{stateWord(t)}</span>
        {!!t.steps?.length && <ChecklistButton steps={t.steps} card />}
        {t.wakeAt && <span className="twake">wakes <span className="num">{wakeTime(t.wakeAt)}</span></span>}
        <span className="msg-menu" ref={ref}>
          <button type="button" className="icon-btn" aria-label={`Actions for ${t.title || "the thread"}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="more" /></button>
          {open && (
            <div className="menu end" role="menu">
              <a href={open_} role="menuitem" onClick={close}>Open</a>
              {(t.state === "working" || t.busy) && <button type="button" role="menuitem" disabled={busy} onClick={() => act("stop")}>Stop</button>}
              <button type="button" role="menuitem" disabled={busy} onClick={pin}>{t.pinned ? "Unpin" : "Pin"}</button>
              {t.state === "resolved"
                ? <button type="button" role="menuitem" disabled={busy} onClick={() => act("reopen")}>Reopen</button>
                : <button type="button" role="menuitem" disabled={busy} onClick={() => act("resolve")}>Resolve</button>}
            </div>
          )}
        </span>
      </div>
      {t.steps && t.state !== "resolved" && <StepLine steps={t.steps} />}
      {line && <p className="tcard-line">{t.needsYou ? <><span className="muted">Waits on you: </span>{line}</> : line}</p>}
      {!line && t.state === "waiting" && !t.needsYou && <p className="tcard-line muted">Waiting for an approval in the thread.</p>}
      <ErrorText error={error} />
    </div>
  );
}

/** Threads Lyrica proposed (`threads suggest`): Start per row, Start all at the foot; started ones link to their thread. */
export function SuggestedCard({ part, userId, pool, projectId, env }: { part: Extract<MessagePart, { type: "tool" }>; userId: string; pool: Pool; projectId: string; env?: ProjectEnv }) {
  const list = ((part.args as { threads?: { title?: string; task?: string }[] } | null)?.threads ?? []).filter((x) => x && typeof x === "object");
  const [run, busy, error] = useAction();
  const started = env?.overview.started ?? {};
  const startedId = (i: number) => started[`${part.toolCallId}#${i}`];
  const left = list.filter((_, i) => !startedId(i)).length;
  const start = (index?: number) => run(async () => {
    await post(threadPath(userId, pool, projectId, "suggestions", part.toolCallId, "start"), index === undefined ? {} : { index });
    env?.onChange();
  });
  return (
    <div className="permission plan suggested" role="group" aria-label="Suggested threads" {...(left && env ? { "data-pending": "Suggestions" } : {})}>
      <div className="plan-head"><b>Suggested threads</b><span className="muted">{list.length === 1 ? "1 thread" : `${list.length} threads`}</span></div>
      <ol className="suggestions">
        {list.map((x, i) => {
          const id = startedId(i);
          return (
            <li key={i}>
              <div className="suggestion-text">
                <b className="as-is">{x.title ?? ""}</b>
                {x.task && <div className="prose small"><Prose text={x.task} /></div>}
              </div>
              {id ? <a className="link sm" href={href({ page: "thread", userId, pool, threadId: id })}>Open</a>
                : <button type="button" className="sm" disabled={busy || !env} onClick={() => start(i)}>Start</button>}
            </li>
          );
        })}
      </ol>
      {left > 0 && env && (
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => start()}>Start all</button>
          {left < list.length && <span className="muted">{left} left</span>}
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

// ---- The Project settings page ----

const SECTIONS = [{ key: "general", label: "General" }, { key: "memory", label: "Memory" }];
const THINKING: ThinkingLevel[] = ["off", "low", "medium", "high"];
const refOf = (m?: ModelRef | ModelRef[]) => { const one = Array.isArray(m) ? m[0] : m; return one && "offeringId" in one ? one.offeringId : ""; };

/** Settings in the project chat's header: its own page, sections at the left (docs/ux.md §6). */
export function ProjectPage({ ctx, pool, threadId, section }: { ctx: ShellContext; pool: Pool; threadId: string; section?: string }) {
  const userId = ctx.user.id;
  const base = threadPath(userId, pool, threadId);
  const summary = useLoad(() => get<ThreadSummary>(base), [base]);
  const settings = useLoad(() => get<ThreadSettings>(`${base}/settings`), [base]);
  const cur = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0]!;
  const s = summary.data;
  const title = s?.title || "New project";
  return (
    <Main className="main">
      <PageHead ctx={ctx} title="Project settings" facts={s && <a href={href({ page: "thread", userId, pool, threadId })}>{title}</a>} />
      <div className="page-body">
        <nav className="subnav" aria-label="Project settings sections">
          {SECTIONS.map((x) => <a key={x.key} href={href({ page: "project", userId, pool, threadId, section: x.key })} aria-current={x.key === cur.key ? "page" : undefined}>{x.label}</a>)}
        </nav>
        <div className="content">
          <ErrorText error={summary.error || settings.error} />
          {s && !s.project && <p>This thread isn't a project. Make it one from its menu in the sidebar.</p>}
          {s?.project && settings.data && (cur.key === "memory"
            ? <MemorySection base={base} summary={s} pool={pool} userId={userId} onSummary={(x) => { summary.set(x); ctx.refreshThreads(); }} />
            : <GeneralSection ctx={ctx} base={base} summary={s} settings={settings.data} onSummary={(x) => { summary.set(x); ctx.refreshThreads(); }} onSettings={settings.set} />)}
        </div>
      </div>
    </Main>
  );
}

/** Goal, Paused and Watching threads; New threads (Model, Thinking, Fallback); This chat (Model, Mode, Group, Folders, Machines, Repositories, MCP servers); Commands; one Save. */
export function GeneralSection({ ctx, base, summary, settings, onSummary, onSettings }: {
  ctx: ShellContext; base: string; summary: ThreadSummary; settings: ThreadSettings; onSummary: (s: ThreadSummary) => void; onSettings: (s: ThreadSettings) => void;
}) {
  const ps = summary.projectSettings;
  const [rules, setRules] = useState<CommandRule[]>(ps?.commandRules ?? []);
  const [goal, setGoal] = useState(summary.goal ?? "");
  const [paused, setPaused] = useState(!!ps?.paused);
  const [watch, setWatch] = useState(ps?.watchThreads !== false);
  const [model, setModel] = useState(refOf(ps?.threadsModel));
  const [thinking, setThinking] = useState<ThinkingLevel | "">(ps?.threadsThinking ?? "");
  const [fallback, setFallback] = useState<"" | "on" | "off">(ps?.threadsFallback === undefined ? "" : ps.threadsFallback ? "on" : "off");
  const [chat, setChat] = useState<{ offeringId: string } | null | undefined>(undefined);
  const [mode, setMode] = useState<PermissionMode>(settings.mode);
  const [group, setGroup] = useState(summary.group ?? "");
  // The chat's workspace, which every thread of the project inherits; undefined until changed here.
  const [grants, setGrants] = useState<Grant[]>();
  const [granted, setGranted] = useState<string[]>();
  const [repositories, setRepositories] = useState<GitRepository[]>();
  const [mcpServers, setMcpServers] = useState<string[]>();
  const paths = useLoad(() => get<AllowedPaths>(u(ctx.user.id, "paths")), [ctx.user.id]);
  const machines = useLoad(() => get<MachineInfo[]>(u(ctx.user.id, "machines")), [ctx.user.id]);
  const [run, busy, error] = useAction();
  const [saved, setSaved] = useState(false);
  const save = () => run(async () => {
    setSaved(false);
    const change: ThreadChange = {
      goal, paused, commandRules: rules,
      ...(watch !== (ps?.watchThreads !== false) ? { watchThreads: watch } : {}),
      threadsModel: model ? { offeringId: model } : null,
      threadsThinking: thinking || null,
      threadsFallback: fallback ? fallback === "on" : null,
      ...(group !== (summary.group ?? "") ? { group: group || null } : {}),
    };
    const updated = await patch<ThreadSummary>(base, change);
    setRules(updated.projectSettings?.commandRules ?? rules);
    onSummary(updated);
    if (chat !== undefined || mode !== settings.mode || grants || granted || repositories || mcpServers) {
      onSettings(await patch<ThreadSettings>(`${base}/settings`, {
        ...(chat !== undefined ? { models: { chat } } : {}), ...(mode !== settings.mode ? { mode } : {}),
        ...(grants ? { grants } : {}), ...(granted ? { machines: granted } : {}), ...(repositories ? { repositories } : {}), ...(mcpServers ? { mcpServers } : {}),
      }));
      setChat(undefined); setGrants(undefined); setGranted(undefined); setRepositories(undefined); setMcpServers(undefined);
    }
    setSaved(true);
  });
  const ruleError = rules.some(r => !r.prefix.trim() || /[\x00-\x1f\x7f-\x9f]/.test(r.prefix) || r.prefix.trim().split(/\s+/).length > 8 || r.prefix.trim().split(/\s+/).some(w => w.length > 64))
    ? "A command prefix has 1 to 8 words, each at most 64 characters, with no control characters." : "";
  const newThreadsHint = `Threads ${her()} starts from this chat. Each one can be changed after it starts.`;
  return (
    <form className="card project-form" aria-labelledby="h-general" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 id="h-general">General</h2>
      <label className="field">
        <span>Goal</span>
        <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What the project is for, in your words." />
      </label>
      <div className="row switches">
        <Switch label="Paused" hint="Running threads stop and queued ones wait." checked={paused} onChange={setPaused} />
        <Switch label="Watching threads" hint={`After you write in a thread or one posts an update, ${her()} checks whether the other threads are affected and tells them.`} checked={watch} onChange={setWatch} />
      </div>

      <h3 title={newThreadsHint}>New threads</h3>
      <div className="row top defaults">
        <label className="field" title={newThreadsHint}>
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">This chat's model</option>
            {settings.allowed.map((ep) => (
              <optgroup key={ep.id} label={`${ep.name} (${ep.kind})`}>
                {ep.models.map((m) => <option key={m.id} value={m.id}>{ep.kind} · {m.modelId} · {ep.name}</option>)}
              </optgroup>
            ))}
            {model && !settings.allowed.some((ep) => ep.models.some((m) => m.id === model)) && <option value={model}>{model} (not available)</option>}
          </select>
        </label>
        <label className="field" title={newThreadsHint}>
          <span>Thinking</span>
          <select value={thinking} onChange={(e) => setThinking(e.target.value as ThinkingLevel | "")}>
            <option value="">This chat's thinking</option>
            {THINKING.map((l) => <option key={l} value={l}>{l === "off" ? "Off" : l[0]!.toUpperCase() + l.slice(1)}</option>)}
          </select>
        </label>
        <label className="field" title={newThreadsHint}>
          <span>Fallback</span>
          <select value={fallback} onChange={(e) => setFallback(e.target.value as "" | "on" | "off")}>
            <option value="">This chat's fallback</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
      </div>

      <h3>This chat</h3>
      <div className="row top defaults">
        <TaskSelect task="chat" label="Model" value={chat === undefined ? settings.models.chat : { ...settings.models.chat, source: chat ? "thread" : "profile", model: chat ?? undefined }} allowed={settings.allowed} onChange={(m) => setChat(m && "offeringId" in m ? m : null)} />
        <label className="field">
          <span>Mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
            {MODE_ORDER.map((m) => <option key={m} value={m}>{MODES[m].label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Group</span>
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Not in a group</option>
            {ctx.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
      </div>

      {/* The drawer's own three controls: every thread the project starts gets these folders, machines, repositories and MCP servers or fewer. */}
      <div className="workspace">
        <div className="field" role="group" aria-labelledby="h-folders">
          <span id="h-folders">Folders</span>
          <Folders grants={grants ?? settings.grants} allowed={paths.data?.[summary.pool] ?? []} onChange={setGrants} />
        </div>
        <div className="field" role="group" aria-labelledby="h-machines">
          <span id="h-machines">Machines</span>
          <Machines granted={granted ?? settings.machines} machines={(machines.data ?? []).filter((m) => m.pool === summary.pool)} onChange={setGranted} />
        </div>
        <div className="field" role="group" aria-labelledby="h-repositories">
          <span id="h-repositories">Repositories</span>
          <Repositories userId={ctx.user.id} pool={summary.pool} granted={repositories ?? settings.repositories} onChange={setRepositories} />
        </div>
        <div className="field" role="group" aria-labelledby="h-mcp-servers">
          <span id="h-mcp-servers">MCP servers</span>
          <McpServers userId={ctx.user.id} pool={summary.pool} granted={mcpServers ?? settings.mcpServers} onChange={setMcpServers} />
        </div>
        <ErrorText error={paths.error || machines.error} />
      </div>

      {/* Network, local-only, the other task models and speech stay in the chat's own drawer. */}
      <p className="small"><a href={href({ page: "thread", userId: ctx.user.id, pool: summary.pool, threadId: summary.id, drawer: true })} title="Network, local-only and the other task models, in the chat's drawer.">Thread settings</a></p>

      <h3>Commands</h3>
      {!rules.length && <p className="muted">No rules: commands ask as the mode says.</p>}
      {rules.map((rule, i) => <div className="command-rule" key={i}>
        <input className="mono" aria-label="Command prefix" value={rule.prefix} onChange={e => setRules(rules.map((r, n) => n === i ? { ...r, prefix: e.target.value } : r))} />
        <div className="seg" role="group" aria-label={`Decision for ${rule.prefix || "new rule"}`}>
          {(["allow", "ask", "forbid"] as const).map(decision => <button type="button" key={decision} aria-pressed={rule.decision === decision} onClick={() => setRules(rules.map((r, n) => n === i ? { ...r, decision } : r))}>{decision[0]!.toUpperCase() + decision.slice(1)}</button>)}
        </div>
        <button type="button" className="icon sm" aria-label={`Remove ${rule.prefix || "rule"}`} onClick={() => setRules(rules.filter((_, n) => n !== i))}><Icon name="close" /></button>
      </div>)}
      <ErrorText error={ruleError} />
      <button type="button" disabled={rules.length >= 100} onClick={() => setRules([...rules, { prefix: "", decision: "ask" }])}>Add rule</button>

      <div className="row">
        <button type="submit" className="primary" disabled={busy || !!ruleError}>Save</button>
        {saved && <span className="muted" role="status">Saved.</span>}
      </div>
      <ErrorText error={error} />
    </form>
  );
}

/** Instructions, kept on the project page apart from what sleep writes; and the page itself in the memory browser. */
function MemorySection({ base, summary, pool, userId, onSummary }: { base: string; summary: ThreadSummary; pool: Pool; userId: string; onSummary: (s: ThreadSummary) => void }) {
  const [instructions, setInstructions] = useState(summary.instructions ?? "");
  const [run, busy, error] = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => setInstructions(summary.instructions ?? ""), [summary.instructions]);
  const save = () => run(async () => { setSaved(false); onSummary(await patch<ThreadSummary>(base, { instructions })); setSaved(true); });
  return (
    <form className="card project-form" aria-labelledby="h-memory" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 id="h-memory">Memory</h2>
      <label className="field">
        <span>Instructions</span>
        <textarea rows={6} maxLength={2000} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={`How ${her()} should work in this project. Every thread of it reads this.`} />
        <small className="muted num">{instructions.length} / 2000</small>
      </label>
      <p className="small"><a href={href({ page: "memory", userId, pool, id: summary.projectSettings!.pageId })}>Project page</a> <span className="muted">· what {her()} knows about the project, rewritten while she sleeps</span></p>
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>Save</button>
        {saved && <span className="muted" role="status">Saved.</span>}
      </div>
      <ErrorText error={error} />
    </form>
  );
}
