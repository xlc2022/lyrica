// Projects (DESIGN.md "Projects", docs/ux.md §6): the project chat's Threads fact and
// tokens, the card each of its threads gets under the message that started it, the
// Suggested threads card, and the Project settings page.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  del, get, patch, post, put, threadPath, u,
  type CommandRule, type AllowedPaths, type GitRepository, type Grant, type MachineInfo, type MessagePart, type ModelRef, type PermissionMode, type Pool, type ProjectOverview, type ThinkingLevel, type ThreadChange, type ThreadSettings, type ThreadSummary,
} from "./api.ts";
import { ProjectQuestion } from "./Question.tsx";
import { FoldConfirm, foldLosses, foldLossNames } from "./FoldConfirm.tsx";
import { ChecklistButton, StepLine } from "./Checklist.tsx";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { MODE_ORDER, MODES } from "./Modes.tsx";
import { go, href, parse } from "./route.ts";
import { Repositories } from "./Git.tsx";
import { McpServers } from "./Mcp.tsx";
import { FilesSection } from "./ProjectFiles.tsx";
import { Folders, Machines, TaskSelect } from "./Settings.tsx";
import { Main, PageHead, useWide, type ShellContext } from "./Shell.tsx";
import { ConfirmDialog, Dialog, ErrorText, Prose, shortTime, Switch, useAction, useDismiss, useLoad, wakeTime } from "./ui.tsx";
import { modelName } from "./ModelLabel.tsx";

/** A project thread's state, in the sidebar's words. */
export function stateWord(t: Pick<ThreadSummary, "state" | "needsYou" | "question">): string {
  if (t.needsYou || t.question) return "Waiting on you";
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

/** The project's threads in the popover's groups, empty ones left out. */
function threadGroups(threads: ThreadSummary[]): { label: string; threads: ThreadSummary[] }[] {
  return GROUPS.map((g) => ({ label: g.label, threads: threads.filter(g.of) })).filter((g) => g.threads.length);
}

/** "Threads 4" in the project chat's facts line: from the split width it toggles the panel's threads list; below it, a popover of its threads grouped by state. */
export function ThreadsFact({ userId, pool, threadId, overview, footer }: { userId: string; pool: Pool; threadId: string; overview: ProjectOverview; footer?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  const wide = useWide();
  // The panel showing this project's list: the fact is pressed, and its click closes it again.
  const here = parse(location.hash);
  const onList = wide && here.page === "thread" && here.panel?.page === "threads" && here.panel.pool === pool && here.panel.threadId === threadId;
  const threads = overview.threads;
  return (
    <span className="picker-anchor" ref={anchor}>
      <button type="button" className="link" aria-haspopup={wide ? undefined : "dialog"} aria-expanded={wide ? undefined : open} aria-pressed={wide ? onList : undefined}
        onClick={() => { if (!wide) return setOpen(!open); go(onList ? { page: "thread", userId, pool, threadId } : { page: "thread", userId, pool, threadId, panel: { page: "threads", pool, threadId } }); }}>
        Threads <span className="num">{threads.length}</span>{!wide && <span className="caret" aria-hidden="true">▾</span>}
      </button>
      {!wide && open && (
        <div className="picker threads-pop" role="dialog" aria-label="The project's threads">
          {!threads.length && <p className="muted small">No threads yet. Ask {her()} for some, or pick Start a thread in a message's menu.</p>}
          {threadGroups(threads).map((g) => (
            <div key={g.label} className="picker-group">
              <div className="picker-ep">{g.label} <span className="num">{g.threads.length}</span></div>
              {g.threads.map((t) => (
                <a key={t.id} className="picker-item thread-item" href={href({ page: "thread", userId, pool: t.pool, threadId: t.id })} onClick={close}>
                  {t.state === "idle" || t.state === "queued" || !t.state ? <span /> : <span className="status" data-state={t.needsYou ? "needsYou" : t.state} aria-hidden="true" />}
                  <span className="title">{t.title || "New thread"}</span>
                  {!!t.unseen && <span className="count">{t.unseen}</span>}
                </a>
              ))}
            </div>
          ))}
          {footer}
        </div>
      )}
    </span>
  );
}

/**
 * A project's threads as a page of their own (`…/t/<pool>/<thread>/threads`): what the panel shows beside its chat from the split width,
 * and that address on its own below it. The popover's groups; rows per docs/ux.md §5 — state as a dot and a word, time in mono.
 */
export function ThreadsPage({ ctx, pool, threadId }: { ctx: ShellContext; pool: Pool; threadId: string }) {
  const userId = ctx.user.id;
  const overview = useOverview(userId, pool, threadId, true, 0);
  const threads = overview.data?.threads ?? [];
  return (
    <Main className="main">
      <PageHead ctx={ctx} title="Threads">
        <div className="head-actions">
          {/* The project's settings page, from its overview (docs/ux.md §6): in the panel it opens one crumb deeper. */}
          <a className="sm" title="Project settings" href={href({ page: "project", userId, pool, threadId })} aria-label="Project settings"><Icon name="gear" /><span className="long">Project settings</span></a>
        </div>
      </PageHead>
      <div className="page-body">
        <div className="content threads-list">
          <ErrorText error={overview.error} />
          {overview.data && !threads.length && <p className="muted small">No threads yet. Ask {her()} for some, or pick Start a thread in a message's menu.</p>}
          {threadGroups(threads).map((g) => (
            <div key={g.label} className="picker-group">
              <div className="picker-ep">{g.label} <span className="num">{g.threads.length}</span></div>
              {g.threads.map((t) => {
                const state = t.needsYou ? "needsYou" : t.state ?? "idle";
                return (
                  <a key={t.id} className="picker-item thread-item" href={href({ page: "thread", userId, pool: t.pool, threadId: t.id })}>
                    <span className="status" data-state={state} aria-hidden="true" />
                    <span className="title">{t.title || "New thread"}</span>
                    <span className="tstate" data-state={state}>{stateWord(t)}</span>
                    <span className="when">{shortTime(t.updatedAt)}</span>
                  </a>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Main>
  );
}

/**
 * One of the project's threads, under the message that started it: its title as written,
 * its state as a dot and a word (then its checklist's count, and when it next wakes), its current step, what it
 * waits on, the last update's first line, View thread at its foot (a double-click on the card does the same), and Open,
 * Stop, Pin or Unpin, Resolve or Reopen behind ⋯. A pinned one sits
 * first among the project's threads in the sidebar. A thread waiting on the user counts as waiting for an answer.
 */
export function ThreadCard({ t, userId, env }: { t: ThreadSummary; userId: string; env: ProjectEnv }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const viewRef = useRef<HTMLAnchorElement>(null);
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
    <div className="tcard" data-state={state} onDoubleClick={(e) => { /* View thread by double-click (docs/briefs/thread-panel.md item 3): not when it lands on a link or button, or on its text with a word selected to copy. */ const target = e.target as HTMLElement; if (target.closest("a,button") || (target !== e.currentTarget && getSelection()?.toString().trim())) return; viewRef.current?.click(); }} {...(t.needsYou ? { "data-pending": "Thread" } : {})}>
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
      {!t.question && line && <p className="tcard-line">{t.needsYou ? <><span className="muted">Waits on you: </span>{line}</> : line}</p>}
      {!line && t.state === "waiting" && !t.needsYou && <p className="tcard-line muted">Waiting for an approval in the thread.</p>}
      {t.question && <ProjectQuestion key={t.question.n} base={base} n={t.question.n} onChange={env.onChange} />}
      <div className="row"><a className="sm" href={open_} ref={viewRef}>View thread</a></div>
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

const SECTIONS = [{ key: "general", label: "General" }, { key: "memory", label: "Memory" }, { key: "files", label: "Files and images" }];
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
  useEffect(() => {
    if (!s?.busy) return;
    const timer = setInterval(summary.reload, 1000);
    return () => clearInterval(timer);
  }, [s?.busy, summary.reload]);
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
          {s?.project && cur.key === "files" && <FilesSection ctx={ctx} pool={pool} threadId={threadId} />}
          {s?.project && settings.data && cur.key !== "files" && (cur.key === "memory"
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
  const [goal, setGoal] = useState(ps?.draftGoal ?? summary.goal ?? "");
  useEffect(() => { if (ps?.draftGoal !== undefined) setGoal(ps.draftGoal); }, [ps?.draftGoal]);
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
      goal, paused, commandRules: rules.filter(r => r.prefix.trim()),
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
  const filled = rules.filter(r => r.prefix.trim());
  const normal = (prefix: string) => prefix.trim().split(/\s+/).join(" ");
  const ruleError = filled.some(r => /[\x00-\x1f\x7f-\x9f]/.test(r.prefix) || r.prefix.trim().split(/\s+/).length > 8 || r.prefix.trim().split(/\s+/).some(w => w.length > 64))
    || new Set(filled.map(r => normal(r.prefix))).size < filled.length
    ? "A command prefix has 1 to 8 words, each at most 64 characters, with no control characters. Each prefix can have one rule." : "";
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
                {ep.models.map((m) => <option key={m.id} value={m.id}>{ep.kind} · {modelName(m)} · {ep.name}</option>)}
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
        <TaskSelect task="chat" label="Model" value={chat === undefined ? settings.models.chat : { ...settings.models.chat, source: chat ? "thread" : "preset", model: chat ?? undefined }} allowed={settings.allowed} onChange={(m) => setChat(m && "offeringId" in m ? m : null)} />
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
        <input className="mono" aria-label="Command prefix" placeholder="npm test" autoFocus={!rule.prefix} value={rule.prefix} onChange={e => setRules(rules.map((r, n) => n === i ? { ...r, prefix: e.target.value } : r))} />
        <div className="seg" role="group" aria-label={`Decision for ${rule.prefix || "new rule"}`}>
          {(["allow", "ask", "forbid"] as const).map(decision => <button type="button" key={decision} aria-pressed={rule.decision === decision} onClick={() => setRules(rules.map((r, n) => n === i ? { ...r, decision } : r))}>{decision[0]!.toUpperCase() + decision.slice(1)}</button>)}
        </div>
        <button type="button" className="icon sm" aria-label={`Remove ${rule.prefix || "rule"}`} onClick={() => setRules(rules.filter((_, n) => n !== i))}><Icon name="close" /></button>
      </div>)}
      <ErrorText error={ruleError} />
      <button type="button" disabled={rules.length >= 100} onClick={() => setRules([...rules, { prefix: "", decision: "ask" }])}>Add rule</button>

      <div className="row">
        <button type="submit" className="primary" disabled={busy || !!ruleError}>Save</button>
        {ps?.draftGoal !== undefined && <button type="button" disabled={busy} onClick={() => run(async () => { const updated = await patch<ThreadSummary>(base, { discardDraft: true }); onSummary(updated); setGoal(updated.goal ?? ""); })}>Discard draft</button>}
        {saved && <span className="muted" role="status">Saved.</span>}
      </div>
      <ErrorText error={error} />
    </form>
  );
}

/** Instructions, kept on the project page apart from what sleep writes; and the page itself in the memory browser. */
function MemorySection({ base, summary, pool, userId, onSummary }: { base: string; summary: ThreadSummary; pool: Pool; userId: string; onSummary: (s: ThreadSummary) => void }) {
  const [instructions, setInstructions] = useState(summary.projectSettings?.draftInstructions ?? summary.instructions ?? "");
  const [run, busy, error] = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => setInstructions(summary.projectSettings?.draftInstructions ?? summary.instructions ?? ""), [summary.instructions, summary.projectSettings?.draftInstructions]);
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
        {summary.projectSettings?.draftInstructions !== undefined && <button type="button" disabled={busy} onClick={() => run(async () => { const updated = await patch<ThreadSummary>(base, { discardDraft: true }); onSummary(updated); setInstructions(updated.instructions ?? ""); })}>Discard draft</button>}
        {saved && <span className="muted" role="status">Saved.</span>}
      </div>
      <ErrorText error={error} />
    </form>
  );
}

/** Empty project state; only explicitly selected work is supplied to the next turn. */
export function ProjectWelcome({ userId, pool, project, settings, onChange }: { userId: string; pool: Pool; project: ThreadSummary; settings: ThreadSettings; onChange: () => void }) {
  const base = threadPath(userId, pool, project.id);
  const [recent, setRecent] = useState<ThreadSummary[]>();
  const [picked, setPicked] = useState<string[]>([]);
  const [run, busy, error] = useAction();
  const setup = () => run(async () => {
    const rows = await get<ThreadSummary[]>(`${u(userId, "threads", pool, "recent")}?top=10&project=${encodeURIComponent(project.id)}`);
    setPicked(rows.map(t => t.id)); setRecent(rows);
  });
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => { setRecent(undefined); setTimeout(() => opener.current?.focus()); };
  const makePlan = () => run(async () => {
    const plan = await post<ThreadSummary>(`${base}/plan`, {});
    onChange(); go({ page: "thread", userId, pool, threadId: plan.id });
  });
  return <div className="permission plan project-welcome">
    <h2>Welcome to {project.title || "your project"}</h2>
    <p>Let's get to work!</p>
    <div className="row welcome-starters">
      <button type="button" ref={opener} disabled={busy} onClick={setup}>Set up from recent work</button>
      <Repositories starter userId={userId} pool={pool} granted={settings.repositories} onChange={repositories => run(async () => { await patch(`${base}/settings`, { repositories }); await post(`${base}/messages`, { text: `I added ${repositories.at(-1)!.name}.` }); onChange(); })} />
      <button type="button" disabled={busy} onClick={makePlan}>Make a plan</button>
    </div>
    <ErrorText error={error} />
    {recent && <Dialog className="recent-work" labelledBy="recent-work-title" onCancel={close} onSubmit={() => run(async () => { await post(`${base}/messages`, { text: "Set up this project from my recent work.", recentThreadIds: picked }); close(); onChange(); })}>
      <h2 id="recent-work-title">Set up from recent work</h2>
      {recent.map(t => <label className="check" key={t.id}><input type="checkbox" checked={picked.includes(t.id)} onChange={e => setPicked(e.target.checked ? [...picked, t.id] : picked.filter(id => id !== t.id))} /> {t.title || "New thread"}</label>)}
      {!recent.length && <p className="muted">No recent work.</p>}
      <ErrorText error={error} />
      <div className="dlg-actions"><button type="button" onClick={close}>{recent.length ? "Cancel" : "Close"}</button>{!!recent.length && <button type="submit" className="primary" disabled={busy || !picked.length}>Continue</button>}</div>
    </Dialog>}
  </div>;
}

/** Existing-work suggestions share the Suggested threads card's rows and actions. Nothing is folded until the dialog confirms it. */
export function FoldCard({ part, userId, pool, projectId, env }: { part: Extract<MessagePart, { type: "tool" }>; userId: string; pool: Pool; projectId: string; env?: ProjectEnv }) {
  const ids = (part.args as { ids?: string[] } | null)?.ids ?? [];
  const base = threadPath(userId, pool, projectId);
  // Each row loads on its own: a thread that is gone or unreadable drops its row and leaves the rest. `index` is the row's place in the call.
  const rows = useLoad(async () => (await Promise.allSettled(ids.map(async (id, index) => ({ index, thread: await get<ThreadSummary>(threadPath(userId, pool, id)), settings: await get<ThreadSettings>(threadPath(userId, pool, id, "settings")) }))))
    .flatMap(r => r.status === "fulfilled" ? [r.value] : []), [base, part.toolCallId]);
  // The thread list carries each thread's child threads; without it the dialog lists none.
  const tree = useLoad(() => get<ThreadSummary[]>(`${u(userId, "threads")}?all=1`).catch(() => [] as ThreadSummary[]), [base, part.toolCallId]);
  const summary = useLoad(() => get<ThreadSummary>(base), [base]);
  const project = useLoad(() => get<ThreadSettings>(`${base}/settings`), [base]);
  const [asked, setAsked] = useState<number[]>();
  // Kept in this browser only: no server action stores a dismissal.
  const [dismissed, setDismissed] = useState(false);
  const started = env?.overview.started ?? {};
  const left = ids.filter((_, i) => !started[`${part.toolCallId}#${i}`]).length;
  const pending = (rows.data ?? []).filter(r => !started[`${part.toolCallId}#${r.index}`]);
  const apply = (index: number) => post(`${base}/folds/${encodeURIComponent(part.toolCallId)}/apply`, { index });
  const projectName = summary.data?.title || "the project";
  if (!left || dismissed) return null;
  const chosen = pending.filter(r => asked?.includes(r.index));
  const close = () => { setAsked(undefined); };
  return <div className="permission plan suggested" role="group" aria-label="Fold in" data-pending="Suggestions">
    <div className="plan-head"><b>Fold in</b><span className="num">{left}</span></div>
    <ol className="suggestions fold-rows">{rows.data?.map(({ thread, settings, index: i }) => {
      if (started[`${part.toolCallId}#${i}`]) return null;
      const lost = project.data ? foldLosses(settings, project.data) : [];
      return <li key={thread.id}><div className="suggestion-text"><b className="as-is">{thread.title || "New thread"}</b>{!!lost.length && <div className="muted small fold-loss" title={lost.join(", ")}>Loses {foldLossNames(lost)}</div>}</div><button type="button" className="sm" disabled={!env || !project.data} onClick={() => setAsked([i])}>Fold in</button></li>;
    })}</ol>
    <div className="row"><button type="button" className="primary" disabled={!env || !rows.data || !project.data || !pending.length} onClick={() => setAsked(pending.map(r => r.index))}>Fold in all <span className="num">{pending.length}</span></button><button type="button" onClick={() => setDismissed(true)}>Cancel</button></div>
    <ErrorText error={rows.error || project.error} />
    {asked && project.data && chosen.length > 0 && <FoldConfirm chosen={chosen} tree={tree.data ?? []} settings={project.data} base={base} projectName={projectName}
      onFold={r => apply(r.index)} onCancel={close} onDone={() => { close(); project.reload(); env?.onChange(); }} />}
  </div>;
}
