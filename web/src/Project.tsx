// Projects (DESIGN.md "Projects", docs/ux.md §6): the project chat's Threads fact and
// tokens, the card each of its threads gets under the message that started it, the
// Suggested threads card, and the Project settings page.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  del, get, patch, post, put, STARTS_MAX, threadPath, u,
  type CommandRule, type AllowedPaths, type EvidenceSetting, type GitRepository, type Grant, type MachineInfo, type MessagePart, type ModelRef, type Pool, type ProjectOverview, type ThinkingLevel, type ThreadChange, type ThreadSettings, type ThreadSummary,
} from "./api.ts";
import { ProjectQuestion } from "./Question.tsx";
import { FoldConfirm, foldLosses, foldLossNames } from "./FoldConfirm.tsx";
import { ChecklistButton, checklistOf, StepLine } from "./Checklist.tsx";
import { checksState } from "./Changes.tsx";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { go, href, parse } from "./route.ts";
import { Repositories } from "./Git.tsx";
import { McpServers } from "./Mcp.tsx";
import { FilesSection } from "./ProjectFiles.tsx";
import { CODE_MODE_HINT, EVIDENCE_CHOICES, EVIDENCE_HINT, Folders, Machines } from "./Settings.tsx";
import { Main, PageHead, useWide, type ShellContext } from "./Shell.tsx";
import { ConfirmDialog, Dialog, ErrorText, Prose, shortTime, Switch, useAction, useDismiss, useInView, useLoad, wakeTime } from "./ui.tsx";
import { isChatModel, modelName } from "./ModelLabel.tsx";

/**
 * A project thread's chips (docs/ux.md §6, "A thread of a project at a glance"): its checklist's count, its open pull
 * request with Draft while it is one and the checks' dot, and how many subagents work for it now. In a row that is
 * itself a link they are plain spans; on a card (`link`) the pull request is a link to it, and the checklist is the
 * card's own button, so left out.
 */
export function ThreadChips({ t, link }: { t: Pick<ThreadSummary, "steps" | "pull" | "subagents">; link?: boolean }) {
  const list = !link && t.steps?.length ? checklistOf(t.steps) : undefined;
  const checks = t.pull && checksState(t.pull.checks);
  if (!list && !t.pull && !t.subagents) return null;
  const said = checks && checks.tone !== "none" ? `checks ${checks.tone === "ok" ? "passed" : checks.tone === "bad" ? "failed" : "running"}` : "";
  const pull = t.pull && (
    <>
      <Icon name="pull" /><span className="num">#{t.pull.number}</span>
      {t.pull.draft && <>{" "}<span className="draft">Draft</span></>}
      {said && <><span className={`dot ${checks!.tone === "ok" ? "up" : checks!.tone === "bad" ? "down" : "away"}`} /><span className="sr-only">, {said}</span></>}
    </>
  );
  const pullTitle = t.pull && `Pull request #${t.pull.number} on ${t.pull.repo}${said ? `\n${checks!.text}` : ""}`;
  const pullLabel = t.pull && `Pull request #${t.pull.number}${t.pull.draft ? ", draft" : ""}${said ? `, ${said}` : ""}`;
  return (
    <span className="tchips">
      {list && <span className="chip" title="Checklist"><span className="num">{list.done}</span> of <span className="num">{list.total}</span><span className="sr-only"> steps done</span></span>}
      {t.pull && (link
        ? <a className="chip pull" href={t.pull.url} target="_blank" rel="noreferrer" title={pullTitle} aria-label={pullLabel}>{pull}</a>
        : <span className="chip pull" title={pullTitle}><span className="sr-only">Pull request </span>{pull}</span>)}
      {!!t.subagents && <span className="chip" title={`${t.subagents} subagent${t.subagents === 1 ? "" : "s"} working`}><Icon name="agents" /><span className="num">{t.subagents}</span><span className="sr-only"> subagents</span></span>}
    </span>
  );
}

/** A project thread's state, in the sidebar's words. */
export function stateWord(t: Pick<ThreadSummary, "state" | "needsYou" | "question">): string {
  if (t.needsYou || t.question) return "Waiting on you";
  switch (t.state) {
    case "waiting": return "Waiting for approval";
    case "working": return "Working";
    case "queued": return "Queued";
    case "held": return "Blocked";
    case "resolved": return "Resolved";
    default: return "Idle";
  }
}

/** A held thread's tooltip: the file and the thread it is to agree with (the same-file rule, docs/workspace.md). */
export const heldTitle = (t: Pick<ThreadSummary, "state" | "held">) =>
  t.state === "held" && t.held ? `Blocked until it agrees with ${t.held.title || "the other thread"} on who changes ${t.held.path}.` : undefined;

/** "312k tokens", "1.2M tokens". */
export const tokenCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The project's threads, how many wait on the user and its tokens; reloaded when `tick` changes. Nothing for a plain thread. */
export function useOverview(userId: string, pool: Pool, threadId: string, project: boolean, tick: number) {
  const base = threadPath(userId, pool, threadId);
  return useLoad(() => (project ? get<ProjectOverview>(`${base}/overview`) : Promise.resolve(undefined)), [base, project], [tick]);
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
  { label: "Blocked", of: (t) => t.state === "held" },
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
  useInView(anchor, open);
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
                  <ThreadChips t={t} />
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
          <a className="sm" title="Project settings" href={href({ page: "project", userId, pool, threadId })} aria-label="Project settings"><Icon name="gear" /><span className="long keep">Project settings</span></a>
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
                    <ThreadChips t={t} />
                    <span className="tstate" data-state={state} title={heldTitle(t)}>{stateWord(t)}</span>
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
        <span className="tstate" data-state={state} title={heldTitle(t)}>{stateWord(t)}</span>
        {!!t.steps?.length && <ChecklistButton steps={t.steps} card />}
        <ThreadChips t={t} link />
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
      {t.worktreeReason && <p className="tcard-line muted" title={`No worktree: ${t.worktreeReason}`}>No worktree: {t.worktreeReason}</p>}
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

const SECTIONS = [{ key: "project", label: "Project" }, { key: "threads", label: "Threads" }, { key: "access", label: "Access" }, { key: "code", label: "Code" }, { key: "files", label: "Files" }];
/** Addresses from before the sections were regrouped. */
const OLD_SECTIONS: Record<string, string> = { general: "project", memory: "project" };
const THINKING: ThinkingLevel[] = ["off", "low", "medium", "high"];
const levelName = (l: ThinkingLevel) => l[0]!.toUpperCase() + l.slice(1);
const refOf = (m?: ModelRef | ModelRef[]) => { const one = Array.isArray(m) ? m[0] : m; return one && "offeringId" in one ? one.offeringId : ""; };

/**
 * The **Project settings** page, opened by **Settings** in the project chat's
 * header: sections at the left (docs/ux.md §6), each a form with its own Save,
 * and **Pause** in the header. The chat's own drawer (its models, network and
 * local-only) is the **Chat settings** link under the sections.
 */
export function ProjectPage({ ctx, pool, threadId, section }: { ctx: ShellContext; pool: Pool; threadId: string; section?: string }) {
  const userId = ctx.user.id;
  const base = threadPath(userId, pool, threadId);
  const summary = useLoad(() => get<ThreadSummary>(base), [base]);
  const settings = useLoad(() => get<ThreadSettings>(`${base}/settings`), [base]);
  const key = OLD_SECTIONS[section ?? ""] ?? section;
  const cur = SECTIONS.find((s) => s.key === key) ?? SECTIONS[0]!;
  const s = summary.data;
  const title = s?.title || "New project";
  const [run, busy, error] = useAction();
  useEffect(() => {
    if (!s?.busy) return;
    const timer = setInterval(summary.reload, 1000);
    return () => clearInterval(timer);
  }, [s?.busy, summary.reload]);
  // The shell reloads its list when anything of the user's changes (a draft she wrote while the page sat idle): follow it.
  useEffect(() => summary.reload(), [ctx.threads, summary.reload]);
  const onSummary = (x: ThreadSummary) => { summary.set(x); ctx.refreshThreads(); };
  const paused = !!s?.projectSettings?.paused;
  const props = s?.project && settings.data ? { ctx, base, summary: s, settings: settings.data, onSummary, onSettings: settings.set } : undefined;
  return (
    <Main className="main">
      <PageHead ctx={ctx} title="Project settings" facts={s && <><a href={href({ page: "thread", userId, pool, threadId })}>{title}</a>{paused && <span className="status-word"><span className="status" data-state="held" aria-hidden="true" />Paused</span>}</>}>
        {s?.project && (
          <div className="head-actions">
            {/* An action, so it applies at once (docs/ux.md §3); the facts line says Paused while it holds. */}
            <button type="button" className="sm" disabled={busy} title={paused ? undefined : "Running threads stop and queued ones wait."}
              onClick={() => run(async () => { onSummary(await patch<ThreadSummary>(base, { paused: !paused })); })}>{paused ? "Resume" : "Pause"}</button>
          </div>
        )}
      </PageHead>
      <div className="page-body">
        <nav className="subnav" aria-label="Project settings sections">
          {SECTIONS.map((x) => <a key={x.key} href={href({ page: "project", userId, pool, threadId, section: x.key })} aria-current={x.key === cur.key ? "page" : undefined}>{x.label}</a>)}
          {/* The project chat's own models, mode, network and local-only stay in its drawer. */}
          <a className="subnav-link" href={href({ page: "thread", userId, pool, threadId, drawer: true })} title="This chat's own models, network and local-only.">Chat settings</a>
        </nav>
        <div className="content">
          <ErrorText error={summary.error || settings.error || error} />
          {s && !s.project && <p>This thread isn't a project. Make it one from its menu in the sidebar.</p>}
          {s?.project && cur.key === "files" && <FilesSection ctx={ctx} pool={pool} threadId={threadId} />}
          {props && cur.key === "project" && <ProjectSection {...props} />}
          {props && cur.key === "threads" && <ThreadsSection {...props} />}
          {props && cur.key === "access" && <AccessSection {...props} />}
          {props && cur.key === "code" && <CodeSection {...props} />}
        </div>
      </div>
    </Main>
  );
}

interface SectionProps { ctx: ShellContext; base: string; summary: ThreadSummary; settings: ThreadSettings; onSummary: (s: ThreadSummary) => void; onSettings: (s: ThreadSettings) => void }

/** A section's one Save, at the card's foot and in view while the card is taller than the screen (docs/ux.md §7). */
function SaveBar({ busy, saved, disabled, children }: { busy: boolean; saved: boolean; disabled?: boolean; children?: React.ReactNode }) {
  return (
    <div className="savebar">
      <button type="submit" className="primary" disabled={busy || disabled}>Save</button>
      {children}
      {saved && <span className="muted" role="status">Saved.</span>}
    </div>
  );
}

/** A label at the left and its control at the right; stacked when the card is narrow. */
function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div className="prow" role={htmlFor ? undefined : "group"} aria-labelledby={htmlFor ? undefined : id}>
      {htmlFor ? <label htmlFor={htmlFor} title={hint}>{label}</label> : <span id={id} title={hint}>{label}</span>}
      <div className="pctl">{children}</div>
    </div>
  );
}

/** Goal; Instructions with their count, the link to the project page and Ask first; Group; one Save. */
export function ProjectSection({ ctx, base, summary, onSummary }: SectionProps) {
  const ps = summary.projectSettings;
  const [goal, setGoal] = useState(ps?.draftGoal ?? summary.goal ?? "");
  useEffect(() => { if (ps?.draftGoal !== undefined) setGoal(ps.draftGoal); }, [ps?.draftGoal]);
  const [instructions, setInstructions] = useState(ps?.draftInstructions ?? summary.instructions ?? "");
  useEffect(() => setInstructions(ps?.draftInstructions ?? summary.instructions ?? ""), [summary.instructions, ps?.draftInstructions]);
  const askNow = ps?.askFirstInstructions === true;
  const [ask, setAsk] = useState(askNow);
  // She may turn it on herself while the page is open.
  useEffect(() => setAsk(askNow), [askNow]);
  const [group, setGroup] = useState(summary.group ?? "");
  const [run, busy, error] = useAction();
  const [saved, setSaved] = useState(false);
  const draft = ps?.draftGoal !== undefined || ps?.draftInstructions !== undefined;
  const save = () => run(async () => {
    setSaved(false);
    // Only what changed, so an untouched field writes no new version of the project page; a draft's field is applied as edited.
    const change: ThreadChange = {
      ...(goal !== (summary.goal ?? "") || ps?.draftGoal !== undefined ? { goal } : {}),
      ...(instructions !== (summary.instructions ?? "") || ps?.draftInstructions !== undefined ? { instructions } : {}),
      ...(ask !== askNow ? { askFirstInstructions: ask } : {}),
      ...(group !== (summary.group ?? "") ? { group: group || null } : {}),
    };
    if (Object.keys(change).length) onSummary(await patch<ThreadSummary>(base, change));
    setSaved(true);
  });
  return (
    <form className="card project-form" aria-label="Project" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Row label="Goal" htmlFor="p-goal">
        <textarea id="p-goal" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What the project is for, in your words." />
      </Row>
      <Row label="Instructions" htmlFor="p-instructions">
        <textarea id="p-instructions" rows={6} maxLength={4000} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={`How ${her()} should work in this project. Every thread of it reads this.`} />
        <div className="with-count">
          <small className="muted num">{instructions.length} / 4000</small>
          <a className="small" href={href({ page: "memory", userId: ctx.user.id, pool: summary.pool, id: ps!.pageId })} title={`What ${her()} knows about the project, rewritten while she sleeps.`}>Project page</a>
        </div>
        <Switch label="Ask first" hint={`${her()} can change these instructions herself. On, her changes wait here as a draft for you to save.`} checked={ask} onChange={setAsk} />
      </Row>
      <Row label="Group" htmlFor="p-group">
        <select id="p-group" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">Not in a group</option>
          {ctx.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </Row>
      <ErrorText error={error} />
      <SaveBar busy={busy} saved={saved}>
        {draft && <button type="button" disabled={busy} onClick={() => run(async () => { const updated = await patch<ThreadSummary>(base, { discardDraft: true }); onSummary(updated); setGoal(updated.goal ?? ""); setInstructions(updated.instructions ?? ""); })}>Discard draft</button>}
      </SaveBar>
    </form>
  );
}

/** Check on threads and Thread starts; New threads (Model, Thinking, Fallback, Code mode, and Evidence judge while Code mode is on); one Save. */
export function ThreadsSection({ base, summary, settings, onSummary }: SectionProps) {
  const ps = summary.projectSettings;
  // One switch for both: looks at the threads (watchThreads) and waiting on them in a turn (checkInOnThreads).
  const checkingNow = ps?.watchThreads !== false && ps?.checkInOnThreads !== false;
  const [checkIn, setCheckIn] = useState(checkingNow);
  const [model, setModel] = useState(refOf(ps?.threadsModel));
  const [code, setCode] = useState(ps?.threadsCode ?? settings.code);
  const [evidence, setEvidence] = useState<EvidenceSetting | "">(ps?.threadsEvidence ?? "");
  const [thinking, setThinking] = useState<ThinkingLevel | "">(ps?.threadsThinking ?? "");
  const [fallback, setFallback] = useState<"" | "on" | "off">(ps?.threadsFallback === undefined ? "" : ps.threadsFallback ? "on" : "off");
  const [starts, setStarts] = useState(ps?.threadsStarts === undefined ? "" : String(ps.threadsStarts));
  // Typed numbers are clamped to 1 to the most; empty follows the default.
  const clampStarts = (v: string) => v.trim() ? String(Math.min(STARTS_MAX, Math.max(1, Math.round(Number(v) || 1)))) : "";
  const [run, busy, error] = useAction();
  const [saved, setSaved] = useState(false);
  const save = () => run(async () => {
    setSaved(false);
    onSummary(await patch<ThreadSummary>(base, {
      ...(checkIn !== checkingNow ? { watchThreads: checkIn, checkInOnThreads: checkIn } : {}),
      threadsModel: model ? { offeringId: model } : null,
      ...(code !== (ps?.threadsCode ?? settings.code) ? { threadsCode: code } : {}),
      threadsEvidence: evidence || null,
      threadsThinking: thinking || null,
      threadsFallback: fallback ? fallback === "on" : null,
      threadsStarts: clampStarts(starts) ? Number(clampStarts(starts)) : null,
    }));
    setSaved(true);
  });
  // Each select's empty choice is the project chat's own value, named so the default isn't a riddle.
  const chatModel = settings.models?.[code ? "code" : "chat"];
  const chatModelName = chatModel?.name ?? chatModel?.modelId;
  const withDefault = (value?: string) => value ? `Default (${value})` : "Default";
  const newThreadsHint = `Threads ${her()} starts in this project. Each one can be changed after it starts. Default follows this chat's own settings.`;
  return (
    <form className="card project-form" aria-label="Threads" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Row label="Watching">
        <Switch label="Check on threads" hint={`While its threads work, ${her()} looks in on them and tells the others what affects them. Off, the chat only hears their reports, which takes far fewer tokens.`} checked={checkIn} onChange={setCheckIn} />
      </Row>
      <Row label="Thread starts" htmlFor="p-starts" hint={`Threads ${her()} may start from one of your messages, a routine or a wake-up. Her threads' reports don't count as new messages. Default is 3, or 6 while this chat's model runs in the cloud.`}>
        <span className="with-unit">
          <input id="p-starts" type="number" min={1} max={STARTS_MAX} step={1} inputMode="numeric" placeholder={withDefault(String(ps?.startsDefault ?? 3))}
            value={starts} onChange={(e) => setStarts(e.target.value)} onBlur={() => setStarts(clampStarts(starts))} />
          <span className="unit">of <span className="num">{STARTS_MAX}</span></span>
        </span>
      </Row>
      <h2 className="eyebrow" title={newThreadsHint}>New threads</h2>
      <Row label="Model" htmlFor="p-model" hint="The model a new thread talks on: Coding in Code mode, Main conversation otherwise.">
        <select id="p-model" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">{withDefault(chatModelName)}</option>
          {settings.allowed.filter((ep) => ep.models.some(isChatModel)).map((ep) => (
            <optgroup key={ep.id} label={`${ep.name} (${ep.kind})`}>
              {ep.models.filter(isChatModel).map((m) => <option key={m.id} value={m.id}>{ep.kind} · {modelName(m)} · {ep.name}</option>)}
            </optgroup>
          ))}
          {model && !settings.allowed.some((ep) => ep.models.some((m) => m.id === model && isChatModel(m))) && <option value={model}>{model} (not available)</option>}
        </select>
      </Row>
      <Row label="Thinking" htmlFor="p-thinking">
        <select id="p-thinking" value={thinking} onChange={(e) => setThinking(e.target.value as ThinkingLevel | "")}>
          <option value="">{withDefault(settings.thinking && levelName(settings.thinking))}</option>
          {THINKING.map((l) => <option key={l} value={l}>{levelName(l)}</option>)}
        </select>
      </Row>
      <Row label="Fallback" htmlFor="p-fallback" hint="When off, only the first model in each list answers; if it can't, the message waits for it.">
        <select id="p-fallback" value={fallback} onChange={(e) => setFallback(e.target.value as "" | "on" | "off")}>
          <option value="">{withDefault(settings.fallbackOn === undefined ? undefined : settings.fallbackOn ? "On" : "Off")}</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </Row>
      <Row label="Code">
        <Switch label="Code mode" hint={CODE_MODE_HINT} checked={code} onChange={setCode} />
        {/* The judge only runs on code turns, so it shows only with Code mode on; its saved choice is kept either way. */}
        {code && (
          <label className="field" title={EVIDENCE_HINT}>
            <span>Evidence judge</span>
            <select value={evidence} onChange={(e) => setEvidence(e.target.value as EvidenceSetting | "")}>
              <option value="">{withDefault(EVIDENCE_CHOICES.find(([v]) => v === settings.evidence)?.[1].replace(/ \(.*/, ""))}</option>
              {EVIDENCE_CHOICES.map(([v, name]) => <option key={v} value={v}>{name}</option>)}
            </select>
          </label>
        )}
      </Row>
      <ErrorText error={error} />
      <SaveBar busy={busy} saved={saved} />
    </form>
  );
}

const ACCESS_HINT = "This chat's. Every thread it starts gets these or fewer.";
/** What the project's threads may reach: Folders, Machines, Repositories and MCP servers, the thread drawer's own controls; one Save. */
export function AccessSection({ ctx, base, summary, settings, onSettings }: SectionProps) {
  // The chat's own, which every thread of the project inherits; undefined until changed here.
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
    if (grants || granted || repositories || mcpServers) {
      onSettings(await patch<ThreadSettings>(`${base}/settings`, {
        ...(grants ? { grants } : {}), ...(granted ? { machines: granted } : {}), ...(repositories ? { repositories } : {}), ...(mcpServers ? { mcpServers } : {}),
      }));
      setGrants(undefined); setGranted(undefined); setRepositories(undefined); setMcpServers(undefined);
    }
    setSaved(true);
  });
  return (
    <form className="card project-form" aria-label="Access" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Row label="Folders" hint={ACCESS_HINT}><Folders grants={grants ?? settings.grants} allowed={paths.data?.[summary.pool] ?? []} onChange={setGrants} /></Row>
      <Row label="Machines" hint={ACCESS_HINT}><Machines granted={granted ?? settings.machines} machines={(machines.data ?? []).filter((m) => m.pool === summary.pool)} onChange={setGranted} /></Row>
      <Row label="Repositories" hint={ACCESS_HINT}><Repositories userId={ctx.user.id} pool={summary.pool} granted={repositories ?? settings.repositories} onChange={setRepositories} /></Row>
      <Row label="MCP servers" hint={ACCESS_HINT}><McpServers userId={ctx.user.id} pool={summary.pool} granted={mcpServers ?? settings.mcpServers} onChange={setMcpServers} /></Row>
      <ErrorText error={paths.error || machines.error || error} />
      <SaveBar busy={busy} saved={saved} />
    </form>
  );
}

/** Install (each clone's dependencies), Checks (run after a code turn that changed something) and Command rules; one Save. */
export function CodeSection({ base, summary, onSummary }: SectionProps) {
  const ps = summary.projectSettings;
  const [rules, setRules] = useState<CommandRule[]>(ps?.commandRules ?? []);
  const [checks, setChecks] = useState<string[]>(ps?.checks ?? []);
  const [setup, setSetup] = useState(ps?.setup ?? "");
  const [run, busy, error] = useAction();
  const [saved, setSaved] = useState(false);
  const save = () => run(async () => {
    setSaved(false);
    const updated = await patch<ThreadSummary>(base, { commandRules: rules.filter(r => r.prefix.trim()), checks: checks.map(c => c.trim()).filter(Boolean), setup: setup.trim() || null });
    setRules(updated.projectSettings?.commandRules ?? rules);
    setChecks(updated.projectSettings?.checks ?? checks);
    setSetup(updated.projectSettings?.setup ?? "");
    onSummary(updated);
    setSaved(true);
  });
  const filled = rules.filter(r => r.prefix.trim());
  const normal = (prefix: string) => prefix.trim().split(/\s+/).join(" ");
  const ruleError = filled.some(r => /[\x00-\x1f\x7f-\x9f]/.test(r.prefix) || r.prefix.trim().split(/\s+/).length > 8 || r.prefix.trim().split(/\s+/).some(w => w.length > 64))
    || new Set(filled.map(r => normal(r.prefix))).size < filled.length
    ? "A command prefix has 1 to 8 words, each at most 64 characters, with no control characters. Each prefix can have one rule." : "";
  const checkError = checks.some(c => c.trim().length > 300 || /[\x00-\x1f\x7f-\x9f]/.test(c))
    ? "A check is one line of at most 300 characters, with no control characters." : "";
  const setupError = setup.trim().length > 300 || /[\x00-\x1f\x7f-\x9f]/.test(setup)
    ? "Install is one line of at most 300 characters, with no control characters." : "";
  return (
    <form className="card project-form" aria-label="Code" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Row label="Install" htmlFor="p-install" hint="Installs each clone's dependencies when it is cloned and whenever a lockfile changes. Empty, the lockfile picks the install: npm, pnpm, yarn, uv or pip.">
        <input id="p-install" className="mono" placeholder="From the lockfile" value={setup} onChange={e => setSetup(e.target.value)} />
        <ErrorText error={setupError} />
      </Row>
      <Row label="Checks" hint={`Run in each repository when a code thread ends a turn that changed something; if one fails, ${her()} fixes it before finishing.`}>
        {!checks.length && <p className="muted">No checks: {her()} runs what the repository asks.</p>}
        {checks.map((check, i) => <div className="command-rule check-row" key={i}>
          <input className="mono" aria-label="Check command" placeholder="npm test" autoFocus={!check} value={check} onChange={e => setChecks(checks.map((c, n) => n === i ? e.target.value : c))} />
          <button type="button" className="icon sm" aria-label={`Remove ${check || "check"}`} onClick={() => setChecks(checks.filter((_, n) => n !== i))}><Icon name="close" /></button>
        </div>)}
        <ErrorText error={checkError} />
        <button type="button" className="sm" disabled={checks.length >= 8} onClick={() => setChecks([...checks, ""])}>Add check</button>
      </Row>
      <Row label="Command rules">
        {!rules.length && <p className="muted">No rules: commands ask as the mode says.</p>}
        {rules.map((rule, i) => <div className="command-rule" key={i}>
          <input className="mono" aria-label="Command prefix" placeholder="npm test" autoFocus={!rule.prefix} value={rule.prefix} onChange={e => setRules(rules.map((r, n) => n === i ? { ...r, prefix: e.target.value } : r))} />
          <div className="seg" role="group" aria-label={`Decision for ${rule.prefix || "new rule"}`}>
            {(["allow", "ask", "forbid"] as const).map(decision => <button type="button" key={decision} aria-pressed={rule.decision === decision} onClick={() => setRules(rules.map((r, n) => n === i ? { ...r, decision } : r))}>{decision[0]!.toUpperCase() + decision.slice(1)}</button>)}
          </div>
          <button type="button" className="icon sm" aria-label={`Remove ${rule.prefix || "rule"}`} onClick={() => setRules(rules.filter((_, n) => n !== i))}><Icon name="close" /></button>
        </div>)}
        <ErrorText error={ruleError} />
        <button type="button" className="sm" disabled={rules.length >= 100} onClick={() => setRules([...rules, { prefix: "", decision: "ask" }])}>Add rule</button>
      </Row>
      <ErrorText error={error} />
      <SaveBar busy={busy} saved={saved} disabled={!!ruleError || !!checkError || !!setupError} />
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

const FOLD_DISMISSED = "lyrica.fold.dismissed";
/** The Fold in cards Cancel has dismissed in this browser, by call ID, newest last. */
function foldDismissed(): string[] {
  try { const v = JSON.parse(localStorage.getItem(FOLD_DISMISSED) ?? "[]") as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

/**
 * Existing-work suggestions share the Suggested threads card's rows and actions. Nothing is folded until the dialog
 * confirms it. Which rows the dialog asks about is held by the conversation (`asked`, `setAsked`): her reply ending
 * replaces the live message holding this card with its stored copy, which mounts the card again.
 */
export function FoldCard({ part, userId, pool, projectId, env, asked, setAsked }: { part: Extract<MessagePart, { type: "tool" }>; userId: string; pool: Pool; projectId: string; env?: ProjectEnv; asked?: number[]; setAsked: (rows?: number[]) => void }) {
  const ids = (part.args as { ids?: string[] } | null)?.ids ?? [];
  const base = threadPath(userId, pool, projectId);
  // Each row loads on its own: a thread that is gone or unreadable drops its row and leaves the rest. `index` is the row's place in the call.
  const rows = useLoad(async () => (await Promise.allSettled(ids.map(async (id, index) => ({ index, thread: await get<ThreadSummary>(threadPath(userId, pool, id)), settings: await get<ThreadSettings>(threadPath(userId, pool, id, "settings")) }))))
    .flatMap(r => r.status === "fulfilled" ? [r.value] : []), [base, part.toolCallId]);
  // The thread list carries each thread's child threads; without it the dialog lists none.
  const tree = useLoad(() => get<ThreadSummary[]>(`${u(userId, "threads")}?all=1`).catch(() => [] as ThreadSummary[]), [base, part.toolCallId]);
  const summary = useLoad(() => get<ThreadSummary>(base), [base]);
  const project = useLoad(() => get<ThreadSettings>(`${base}/settings`), [base]);
  // Kept in this browser only: no server action stores a dismissal. It outlasts the card mounting again when her reply ends.
  const [dismissed, setDismissed] = useState(() => foldDismissed().includes(part.toolCallId));
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(FOLD_DISMISSED, JSON.stringify([...foldDismissed().filter(id => id !== part.toolCallId), part.toolCallId].slice(-100))); } catch { /* kept for this visit only */ } };
  const started = env?.overview.started ?? {};
  const pending = (rows.data ?? []).filter(r => !started[`${part.toolCallId}#${r.index}`]);
  // Until the rows load, every unfolded ID counts; after, only rows that loaded, so the count matches what the card can fold.
  const left = rows.data ? pending.length : ids.filter((_, i) => !started[`${part.toolCallId}#${i}`]).length;
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
    <div className="row"><button type="button" className="primary" disabled={!env || !rows.data || !project.data || !pending.length} onClick={() => setAsked(pending.map(r => r.index))}>Fold in all <span className="num">{pending.length}</span></button><button type="button" onClick={dismiss}>Cancel</button></div>
    <ErrorText error={rows.error || project.error} />
    {asked && project.data && chosen.length > 0 && <FoldConfirm chosen={chosen} tree={tree.data ?? []} settings={project.data} base={base} projectName={projectName}
      onFold={r => apply(r.index)} onCancel={close} onDone={() => { close(); project.reload(); env?.onChange(); }} />}
  </div>;
}
