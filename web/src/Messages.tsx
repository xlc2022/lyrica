// The conversation: stored messages, then what's streaming now.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { get, post, threadPath, u, type GoAhead, type ImagePart, type ImageRetryOptions, type MemoryDetail, type Message, type MessagePage, type MessagePart, type PermissionRequest, type Pool, type Reaction, type SendResponse, type Speech, type ThreadRef, type ThreadSummary } from "./api.ts";
import { storedUserItems, type LiveItem } from "./live.ts";
import { useMentionText, useThreadMentions } from "./mentions.ts";
import { GoAheadMenu } from "./Modes.tsx";
import { ScheduleText } from "./Routines.tsx";
import { Icon } from "./icons.tsx";
import { go, href, idHref } from "./route.ts";
import { RowMenu } from "./Machines.tsx";
import { ask, EDIT_MESSAGE_EVENT, type EditMessageRequest, EDIT_IMAGE_EVENT, type EditImageRequest } from "./links.ts";
import type { ShellContext } from "./Shell.tsx";
import type { useThread } from "./stream.ts";
import { FoldCard, stateWord, SuggestedCard, ThreadCard, type ProjectEnv } from "./Project.tsx";
import { ChecklistButton, StepLine } from "./Checklist.tsx";
import { findThread } from "./Thread.tsx";
import { EditBox, MessageActions, MessageMenu, type Rewinder } from "./Rewind.tsx";
import { ErrorText, fullTime, Prose, useAction, useDismiss, wakeTime } from "./ui.tsx";
import { basename, InlineImage, Lightbox, PathText, useFileLinks, type FileLinks } from "./paths.tsx";
import type { ReactNode } from "react";
import { foldLooks, raisedIn, toldIn, type Told } from "./looks.ts";
import { her } from "./name.ts";
import { ReactButton, ReactionChips } from "./Reactions.tsx";
import { ReadAloudButton } from "./Voice.tsx";

interface Props {
  ctx: ShellContext;
  pool: Pool;
  base: string;
  threadId: string;
  /** A subagent's thread: its messages say who sent them, and its replies are the subagent's. */
  subagent: boolean;
  thread: ReturnType<typeof useThread>;
  /** Branch, regenerate, edit and delete; not in a subagent's thread. */
  rewinder?: Rewinder;
  /** Messages from here on are being deleted (waiting for Undo). */
  hideFrom?: number;
  /** A child thread's parent's title, for what the parent sent. */
  parentTitle?: string;
  /** Whether Read aloud can be used here now, for its button's state. */
  speech?: Speech;
  /** Read aloud's problems, for the conversation's error line. */
  onError?: (message: string) => void;
  /** A project chat: its threads' cards go under the messages that started them, and its updates stay off the chat. */
  project?: ProjectEnv;
}

export function Conversation({ ctx, pool, base, threadId, subagent, thread, rewinder, hideFrom, parentTitle, speech, onError, project }: Props) {
  const { messages, live, hasMore, loadOlder, loaded } = thread;
  const [run, loading, error] = useAction();
  // Expanded tool markers, by call ID, so they stay open when the stored copy replaces the live one.
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(new Set());
  const toggleTool = (id: string) => setOpenTools((o) => { const n = new Set(o); if (!n.delete(id)) n.add(id); return n; });
  // Subagents whose work is shown in their delegate card here: their approvals show there too.
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const show = (id: string, on: boolean) => setShown((o) => { const n = new Set(o); if (on) n.add(id); else n.delete(id); return n; });
  // The image open large, held here: the message it was opened from may be replaced by its stored copy meanwhile.
  const [large, setLarge] = useState<{ path: string; url: string }>();
  const openLarge = useCallback((path: string, files: FileLinks) => setLarge({ path, url: files.url(path) }), []);
  const env: Env = {
    busy: live.busy, settingsVersion: live.settings, lastUser: messages.findLast(m => m.role === "user")?.n, userId: ctx.user.id, you: ctx.user.displayName, pool, base, threadId, subagent, openTools, toggleTool,
    permissions: live.permissions, ticks: live.subagents, show, rewinder, parentTitle, speech, onError: onError ?? (() => {}), project,
    lastHers: messages.findLast((m) => m.role === "assistant")?.n, large: openLarge, threads: ctx.threads,
  };
  const shownMessages = hideFrom === undefined ? messages : messages.filter((m) => m.n < hideFrom);
  // Anchors are entry numbers, including entries the API doesn't display. Use the first
  // message at or after the anchor (contracts.md), so a card stays put as later messages arrive.
  // Threads with no remaining anchor sit under the last message instead.
  const cards = new Map<number, ThreadSummary[]>();
  for (const t of project?.overview.threads ?? []) {
    const anchor = t.anchor;
    const message = anchor === undefined ? undefined : shownMessages.find((m) => m.n >= anchor);
    const n = (message ?? shownMessages.at(-1))?.n;
    if (n !== undefined) cards.set(n, [...cards.get(n) ?? [], t]);
  }
  const looks = useMemo(() => foldLooks(shownMessages, pool), [shownMessages, pool]);
  const storedUsers = storedUserItems(live.items, messages);
  return (
    <>
      {hasMore && <button type="button" className="older" disabled={loading} onClick={() => run(loadOlder)}>Show earlier messages</button>}
      <ErrorText error={error} />
      {loaded && !project && !messages.length && !live.items.length && <p className="muted empty">Say hello.</p>}
      {!shownMessages.length && project?.overview.threads.map(t => <ThreadCard key={t.id} t={t} userId={ctx.user.id} env={project} />)}
      {conversationNodes(shownMessages, hideFrom === undefined ? live.items.filter((_, i) => !storedUsers.has(i)) : [], live.busy, env, ctx.user.displayName, looks, cards)}
      {live.busy && !live.items.some((x) => x.role === "assistant") && <p className="thinking-dots" role="status">{her()} is thinking…</p>}
      {live.permissions.filter((p) => !p.subagent || !shown.has(p.subagent.threadId) || p.subagent.threadId === threadId)
        .map((p) => <PermissionPrompt key={p.requestId} base={base} p={p} env={env} />)}
      {live.errors.map((e, i) => <p key={i} className="error turn-error" role="alert">{e}</p>)}
      {live.offline && (
        <p className="turn-error" role="status" title={live.offline.tried.map((t) => `${t.label}: ${t.reason}`).join("\n")}>
          No model can be reached.{live.queued.length ? " Your message goes when one is back." : ""}
        </p>
      )}
      {live.queued.map((q, i) => (
        <div key={`q-${i}`} className="msg user queued">
          <div className="who">{ctx.user.displayName} · waiting</div>
          <div className="body">{q}</div>
        </div>
      ))}
      {large && createPortal(<Lightbox path={large.path} url={large.url} bare onClose={() => setLarge(undefined)} />, document.body)}
    </>
  );
}

interface Env {
  busy: boolean;
  settingsVersion: number;
  lastUser?: number;
  userId: string;
  parentTitle?: string;
  you: string;
  pool: Pool;
  /** The open thread's API path, where its permission requests are answered. */
  base: string;
  threadId: string;
  subagent: boolean;
  openTools: ReadonlySet<string>;
  toggleTool: (id: string) => void;
  permissions: PermissionRequest[];
  ticks: Record<string, number>;
  /** A delegate card shows or hides a subagent's work. */
  show: (threadId: string, on: boolean) => void;
  rewinder?: Rewinder;
  /** Her last stored message, which takes over a reading begun while she wrote it. */
  lastHers?: number;
  speech?: Speech;
  onError: (message: string) => void;
  project?: ProjectEnv;
  /** The thread list, where a child's card finds its checklist. */
  threads: ThreadSummary[];
  /** Opens an image from a message large, over the conversation. */
  large: (path: string, files: FileLinks) => void;
}

/** Her messages that hold only markers, waiting to be drawn together once the run ends. */
interface Quiet { key: string; n?: number; parts: MessagePart[]; streaming: boolean }

/** A part that is one of her inner workings (docs/ux.md §6): a marker, never text, an image or a card. */
function isMarker(p: MessagePart): boolean {
  if (p.type === "thinking" || p.type === "recall" || p.type === "remember") return true;
  if (p.type !== "tool") return false;
  if (p.name === "delegate" || p.name === "propose_plan" || p.name === "image") return false;
  if (p.name === "threads") return (p.args as { action?: string } | null)?.action === "steps";
  return true;
}

/**
 * The conversation's nodes, in order: stored messages, then the live ones. Her messages that are only markers get no
 * header line; a run of three or more such markers, up to her next text, image or card or the person's next message,
 * folds into one ToolRun marker (docs/ux.md §6, Lyrica's inner workings). Along the way, the images her image parts
 * showed since the person's last message are collected, so her prose doesn't show the same image again.
 */
function conversationNodes(stored: Message[], liveItems: LiveItem[], busy: boolean, env: Env, you: string,
  looks: { told: Map<string, Told[]>; folded: Set<string> }, cards: Map<number, ThreadSummary[]>): ReactNode[] {
  const nodes: ReactNode[] = [];
  let quiet: Quiet[] = [];
  let shown = new Set<string>();
  const flush = () => {
    if (!quiet.length) return;
    const markers = quiet.reduce((a, q) => a + q.parts.length, 0);
    if (markers >= 3) nodes.push(<ToolRun key={`run-${quiet[0]!.key}`} runs={quiet} env={env} />);
    else for (const q of quiet) nodes.push(<section key={q.key} className="turn quiet" id={q.n !== undefined ? `m-${q.n}` : undefined}><Parts parts={q.parts} env={env} bare streaming={q.streaming} /></section>);
    quiet = [];
  };
  type E = { key: string; stored?: Message; live?: LiveItem; streaming: boolean };
  const entries: E[] = [
    ...stored.map((m): E => ({ key: m.id, stored: m, streaming: false })),
    ...liveItems.map((item, i): E => ({ key: `live-${i}`, live: item, streaming: busy && i === liveItems.length - 1 })),
  ];
  for (const e of entries) {
    const m = e.stored;
    const hers = m ? (m.role === "assistant" && !m.error && !cards.has(m.n) ? m.parts : undefined) : e.live?.role === "assistant" ? e.live.parts : undefined;
    if (hers && hers.length && hers.every(isMarker)) { quiet.push({ key: e.key, n: m?.n, parts: hers, streaming: e.streaming }); continue; }
    flush();
    const user = m ? m.role === "user" : e.live?.role === "user";
    if (user) shown = new Set();
    for (const p of hers ?? []) if (p.type === "image") for (const path of p.paths) shown.add(path);
    const seen = new Set(shown);
    if (m) nodes.push(<StoredMessage key={m.id} m={m} env={env} you={you} told={looks.told.get(m.id)} folded={looks.folded.has(m.id)} cards={cards.get(m.n)} shown={seen} />);
    else if (e.live) nodes.push(<LiveMessage key={e.key} item={e.live} env={env} you={you} streaming={e.streaming} shown={seen} />);
  }
  flush();
  return nodes;
}

/**
 * A run of her tool calls as one marker (docs/ux.md §6): "<n> tool calls", running while the turn goes on, which opens
 * to a box that scrolls, every marker in it opening as before. Open state follows the first call's ID, so it survives
 * the stored copy replacing the live one.
 */
function ToolRun({ runs, env }: { runs: Quiet[]; env: Env }) {
  const parts = runs.flatMap((r) => r.parts);
  const first = parts.find((p) => p.type === "tool");
  const key = `run:${first?.type === "tool" ? first.toolCallId : runs[0]!.key}`;
  const open = env.openTools.has(key);
  const tools = parts.filter((p) => p.type === "tool");
  const streaming = runs.at(-1)!.streaming;
  const running = streaming || tools.some((p) => p.type === "tool" && p.result === undefined);
  const failed = tools.some((p) => p.type === "tool" && p.isError);
  const body = useRef<HTMLDivElement>(null);
  // While she works, an open box follows the newest call.
  useEffect(() => { if (open && streaming && body.current) body.current.scrollTop = body.current.scrollHeight; }, [open, streaming, parts.length]);
  const n = tools.length || parts.length;
  const word = tools.length ? (n === 1 ? "tool call" : "tool calls") : (n === 1 ? "step" : "steps");
  return (
    <div className="marker tool-run" data-type="toolrun" id={runs[0]!.n !== undefined ? `m-${runs[0]!.n}` : undefined}>
      <button type="button" aria-expanded={open} onClick={() => env.toggleTool(key)}>
        <span className="num">{n}</span> {word}
        {running ? <span className="state" data-state="running">running</span> : failed ? <span className="state" data-state="failed">failed</span> : null}
        <Icon name="down" />
      </button>
      {open && (
        <div ref={body} className="marker-body run-body">
          {runs.map((r) => r.parts.map((p, i) => (p.type === "text" || p.type === "image" ? null : <Marker key={`${r.key}-${i}`} part={p} env={env} />)))}
          {streaming && <span className="writing-dots" aria-hidden="true"><i /><i /><i /></span>}
        </div>
      )}
    </div>
  );
}

function StoredMessage({ m, env, you, cards, told, folded, shown }: { m: Message; env: Env; you: string; cards?: ThreadSummary[]; told?: Told[]; folded?: boolean; shown?: ReadonlySet<string> }) {
  const after = cards?.map((t) => <ThreadCard key={t.id} t={t} userId={env.userId} env={env.project!} />);
  if (m.role === "user") {
    if (m.from?.kind === "parent" || m.from?.kind === "thread") return <><FromThread text={m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")} from={m.from} env={env} n={m.n} />{after}</>;
    if (m.from?.kind === "routine") return <><ScheduledMarker text={m.parts.map(p => p.type === "text" ? p.text : "").join("")} schedule={m.from.schedule} env={env} n={m.n} />{after}</>;
    if (m.from?.kind === "wakeup") return <><ScheduledMarker text={m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")} setAt={m.from.setAt} dueAt={m.from.dueAt} env={env} n={m.n} />{after}</>;
    if (m.from?.kind === "watching") return <><LookMarker text={m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")} told={told ?? []} env={env} n={m.n} />{after}</>;
    const hers = m.from?.kind === "lyrica";
    const who = hers ? her() : m.from?.kind === "user" ? (m.from.name || you) : you;
    return <><UserMessage text={m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")} you={who} n={m.n} at={m.createdAt} rewinder={env.rewinder} env={env} hers={hers} reactions={m.reactions} />{after}</>;
  }
  if (m.role === "notice") {
    return <>{m.parts.map((p, i) => (p.type === "delegation"
      ? <Notice key={i} text={p.text} status={p.status} threads={p.threads} env={env} />
      : <Notice key={i} text={p.type === "text" ? p.text : p.type === "compacted" ? compactedLabel(p) : ""} env={env} />))}{after}</>;
  }
  return (
    <>
      <Parts parts={m.parts} env={env} model={m.model} n={m.n} at={m.createdAt} folded={folded} reactions={m.reactions} shown={shown} />
      {m.error && <p className="error turn-error">{m.error}</p>}
      {after}
    </>
  );
}

const WATCHING_MARK = "[Watching threads]\n\n";
/** The line lyricad puts on what a parent or a sibling thread sent, as a live item carries it (core/src/threads.ts). */
const FROM_PARENT = /^\[From t:([^\]\s]+)\]\n\n/;
/** The line lyricad puts on her note when a wake-up fires, as a live item carries it (core/src/threads.ts, WAKEUP). */
const WAKEUP = /^\[Wake-up, set ([0-9T:-]+Z)(?:, due ([0-9T:-]+Z))?\]\n\n/;

/**
 * A look at the project's threads (docs/ux.md §6: one-line markers for her inner workings): "Checked the other threads",
 * with how many she told, expanding to the threads looked at and what she sent each. Never the person's bubble.
 */
function LookMarker({ text, told, env, n }: { text: string; told: Told[]; env: Env; n?: number }) {
  const [open, setOpen] = useState(false);
  const ids = [...new Set([...text.matchAll(/^In \[t:([^\]\s]+)\]:/gm)].map((m) => m[1]!))];
  const raised = raisedIn(text);
  return (
    <div className="marker look" data-type="watching" id={n !== undefined ? `m-${n}` : undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Checked the other threads{told.length > 0 && <> · told <span className="num">{told.length}</span></>}<Icon name="down" />
      </button>
      {open && (
        <div className="marker-body">
          {ids.length > 0 && <div className="prose small"><HerProse text={`Looked at ${ids.map((id) => `[t:${id}]`).join(", ")}.`} env={env} /></div>}
          {told.map((t, i) => (
            <div key={i} className="prose small look-told">
              <HerProse text={`To ${t.threads.map((x) => `[t:${x.pool === env.pool ? "" : `${x.pool}/`}${x.id}]`).join(", ") || "a thread"}: ${t.text}`} env={env} elsewhere />
            </div>
          ))}
          {raised && <div className="prose small"><HerProse text={`Raised with you: ${raised}`} env={env} /></div>}
          {env.rewinder && n !== undefined && <div className="row"><MessageMenu n={n} role="user" rewinder={env.rewinder} branch /></div>}
        </div>
      )}
    </div>
  );
}

function LiveMessage({ item, env, you, streaming, shown }: { item: LiveItem; env: Env; you: string; streaming: boolean; shown?: ReadonlySet<string> }) {
  if (item.role === "user") {
    if (item.text.startsWith(WATCHING_MARK)) { const text = item.text.slice(WATCHING_MARK.length); return <LookMarker text={text} told={toldIn(text, env.pool)} env={env} />; }
    const parent = FROM_PARENT.exec(item.text);
    if (parent) return <FromThread text={item.text.slice(parent[0].length)} from={{ kind: "thread", threadId: parent[1]! }} env={env} />;
    const routine = /^\[Routine, ([^\]\n]+)\]\n\n/.exec(item.text);
    if (routine) return <ScheduledMarker text={item.text.slice(routine[0].length)} schedule={routine[1]!} env={env} />;
    const wake = WAKEUP.exec(item.text);
    if (wake) return <ScheduledMarker text={item.text.slice(wake[0].length)} setAt={wake[1]!} dueAt={wake[2]} env={env} />;
    return <UserMessage text={item.text} you={you} env={env} />;
  }
  // A look kept without a turn: the same marker, until its stored copy replaces this one.
  if (item.role === "notice" && item.status === "watching") {
    const text = item.text.startsWith(WATCHING_MARK) ? item.text.slice(WATCHING_MARK.length) : item.text;
    return <LookMarker text={text} told={item.told ? item.told.map((t) => ({ threads: [{ pool: env.pool, id: t.threadId }], text: t.text })) : toldIn(text, env.pool)} env={env} />;
  }
  if (item.role === "notice") return <Notice text={item.text} status={item.status} threads={item.threads} env={env} />;
  return <Parts parts={item.parts} env={env} model={item.model} streaming={streaming} shown={shown} />;
}

/** A message in the person's place; `hers` when Lyrica wrote it (a subagent's task), so the threads she mentions show by title. Its paths are links. */
function UserMessage({ text, you, n, at, rewinder, env, hers, reactions }: { text: string; you: string; n?: number; at?: string; rewinder?: Rewinder; env: Pick<Env, "userId" | "pool" | "threadId" | "large">; hers?: boolean; reactions?: Reaction[] }) {
  const [editing, setEditing] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const files = useFileLinks(env.userId, env.pool, env.threadId);
  const menu = rewinder && n !== undefined;
  return (
    <div className="msg user" id={n !== undefined ? `m-${n}` : undefined}>
      <div className="who sent">
        <span className="who-head">
          <span className="who-name" title={you}>{you}</span>
          {at && <SentAt at={at} />}
        </span>
        {menu && rewinder.pinned.has(n) && <span className="badge pin-badge">pinned</span>}
      </div>
      {editing && menu
        ? <EditBox text={text} onCancel={() => setEditing(false)} onSend={(t) => { setEditing(false); rewinder.rewind(n, { action: "edit", text: t }, n); }} />
        : hers ? <div className="body prose"><HerProse text={text} env={env} /></div> : <div className="body"><PathText text={text} files={files} large={(p) => env.large(p, files)} /></div>}
      {n !== undefined && <ReactionChips n={n} reactions={reactions} reactor={rewinder} her={her()} />}
      {menu && !editing && (
        <MessageActions n={n} role="user" rewinder={rewinder} text={text} onEdit={() => setEditing(true)} onRemember={() => setRemembering(true)}
          react={<ReactButton n={n} reactions={reactions} reactor={rewinder} />} />
      )}
      {remembering && n !== undefined && <RememberBox text={text} n={n} env={env} onClose={() => setRemembering(false)} />}
    </div>
  );
}

/**
 * Remember this: a note in the User introduced collection, in the thread's pool,
 * prefilled with the message's first line and citing the message (docs/ux.md §6).
 */
function RememberBox({ text, n, env, onClose }: { text: string; n: number; env: Pick<Env, "userId" | "pool" | "threadId">; onClose: () => void }) {
  const [value, setValue] = useState(() => text.split("\n").find((l) => l.trim()) ?? "");
  const [saved, setSaved] = useState<MemoryDetail>();
  const [run, busy, error] = useAction();
  const save = () => run(async () => {
    setSaved(await post<MemoryDetail>(u(env.userId, "memory", env.pool, "notes"), { text: value.trim(), links: [`e:${env.threadId}#${n}`] }));
  });
  if (saved) {
    return <p className="cap remembered">Remembered as <a href={idHref(env.userId, saved.item.pool, saved.item.id)}>a note</a>.</p>;
  }
  return (
    <form className="remember-box" onSubmit={(e) => { e.preventDefault(); if (value.trim()) void save(); }}>
      <label htmlFor={`remember-${n}`}>Remember this as a note <span className="eyebrow">{env.pool}</span></label>
      <textarea id={`remember-${n}`} rows={2} value={value} autoFocus onChange={(e) => setValue(e.target.value)} />
      <ErrorText error={error} />
      <div className="row">
        <button type="submit" className="primary sm" disabled={busy || !value.trim()}>Remember</button>
        <button type="button" className="sm" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * When a message was sent (docs/ux.md §6): muted and mono after the name (and the model), its full date and time as the
 * tooltip. Only a stored message has a time, so a reply that is still streaming shows none.
 */
function SentAt({ at }: { at: string }) {
  if (Number.isNaN(Date.parse(at))) return null;
  return <span className="muted sent-at"><Sep /><time className="num" dateTime={at} title={fullTime(at)}>{wakeTime(at)}</time></span>;
}

/** The dot between the parts of a message's header line, with the same air on both sides. */
function Sep() {
  return <span className="sep"> · </span>;
}

/**
 * Her message: prose for text, one-line markers for everything else. `bare`: only markers, drawn without a header line
 * (the run they belong to is her inner workings). `shown`: image paths her image parts already showed this turn, so her
 * prose keeps them as links.
 */
function Parts({ parts, env, model, streaming, n, at, folded, reactions, bare, shown }: { parts: MessagePart[]; env: Env; model?: string; streaming?: boolean; n?: number; at?: string; folded?: boolean; reactions?: Reaction[]; bare?: boolean; shown?: ReadonlySet<string> }) {
  const [remembering, setRemembering] = useState(false);
  const out: React.ReactNode[] = [];
  let prose: string[] = [];
  const flush = (key: number) => {
    if (!prose.length) return;
    out.push(
      <div key={`p${key}`} className="msg her">
        <div className="body prose">
          <HerProse text={prose.join("")} env={env} skipImages={shown} />
        </div>
      </div>,
    );
    prose = [];
  };
  parts.forEach((p, i) => {
    if (p.type === "text") { prose.push(p.text); return; }
    // In a project chat, a thread's start has its card under the message; no marker, so a turn that only started one takes no room.
    if (p.type === "tool" && p.name === "threads" && env.project && !p.isError && (p.args as { action?: string } | null)?.action === "start") return;
    // After a look, the threads she told are in the look's marker; the messages would show twice.
    if (folded && p.type === "tool" && p.name === "threads" && !p.isError && (p.args as { action?: string } | null)?.action === "message") return;
    flush(i);
    out.push(p.type === "image" ? <MessageImages key={i} part={p} env={env} /> : <Marker key={i} part={p} env={env} />);
  });
  flush(parts.length);
  // The one indicator while she writes (docs/ux.md §6): three muted dots fading in turn, at the end of the live reply and only when its last part isn't text.
  if (streaming && parts.at(-1)?.type !== "text") out.push(
    <span key="dots" className="writing-dots" aria-hidden="true"><i /><i /><i /></span>,
  );
  // A turn with nothing to show (a project chat's thread start, whose card stands under the message) takes no room.
  if (!out.length && !streaming) return null;
  if (bare) return <>{out}</>;
  // In a subagent's thread, the replies are the subagent's own work.
  const who = env.subagent ? "Subagent" : her();
  return (
    <section className="turn" id={n !== undefined ? `m-${n}` : undefined} aria-label={model ? `${who} (${model})` : who}>
      <div className="who sent">
        <span className="who-head">
          <span className="who-name" title={model ?? who}>{who}{model && <span className="muted"><Sep />{model}</span>}</span>
          {at && <SentAt at={at} />}
        </span>
        {env.rewinder && n !== undefined && env.rewinder.pinned.has(n) && <span className="badge pin-badge">pinned</span>}
      </div>
      {out}
      {n !== undefined && <ReactionChips n={n} reactions={reactions} reactor={env.rewinder} her={who} />}
      {env.rewinder && n !== undefined && (
        <MessageActions n={n} role="assistant" rewinder={env.rewinder} text={parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")} onRemember={() => setRemembering(true)}
          readAloud={<ReadAloudButton url={`${env.base}/messages/${n}/speech`} also={n === env.lastHers ? `${env.base}/messages/live/speech` : undefined} speech={env.speech} onError={env.onError} />}
          react={<ReactButton n={n} reactions={reactions} reactor={env.rewinder} />} />
      )}
      {/* With Read aloud while agent writes on, the reply she is writing has the one button in its row. */}
      {env.rewinder && n === undefined && streaming && env.speech?.readAloudLive && (
        <div className="msg-actions" role="group" aria-label="Message actions"><ReadAloudButton url={`${env.base}/messages/live/speech`} speech={env.speech} onError={env.onError} /></div>
      )}
      {remembering && n !== undefined && <RememberBox text={parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")} n={n} env={env} onClose={() => setRemembering(false)} />}
    </section>
  );
}

/** Principle 1: made images stay in the conversation, with their facts and rare actions (ux §3 and §6). */
function MessageImages({ part, env }: { part: ImagePart; env: Env }) {
  const links = useFileLinks(env.userId, env.pool, env.threadId);
  const files: FileLinks = { ...links, url: (path) => `${env.base}/file?path=${encodeURIComponent(path)}` };
  return (
    <div className="message-images">
      {part.paths.map((path) => (
        <div key={path} className="message-image">
          <InlineImage src={path} alt={basename(path)} label={basename(path)} files={files} large={(p) => env.large(p, files)} />
          <div className="image-facts">
            <span className="cap">Made with {part.model}{part.tier && <> · {part.tier}</>}</span>
            <RowMenu label={`Image actions for ${basename(path)}`} items={[
              { label: "Download", onPick: () => { const a = document.createElement("a"); a.href = files.url(path); a.download = basename(path); a.click(); } },
              { label: "Copy path", onPick: () => { void navigator.clipboard.writeText(path).catch((e: Error) => env.onError(e.message)); } },
              { label: "Show in Files", onPick: () => go({ page: "files", userId: env.userId, pool: env.pool, threadId: env.threadId, path }) },
              { label: "Edit…", onPick: () => { ask<EditImageRequest>(EDIT_IMAGE_EVENT, { base: env.base, path }); } },
            ]} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Marker({ part, env }: { part: Exclude<MessagePart, { type: "text" | "image" }>; env: Env }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = part.type === "tool" ? env.openTools.has(part.toolCallId) : localOpen;
  const toggle = () => (part.type === "tool" ? env.toggleTool(part.toolCallId) : setLocalOpen(!localOpen));
  if (part.type === "tool" && part.name === "delegate") return <SubagentCard part={part} env={env} />;
  // While her plan waits for an answer, its card shows it; the marker would be a second copy.
  if (part.type === "tool" && part.name === "propose_plan" && part.result === undefined) return null;
  if (part.type === "tool" && part.name === "threads") {
    const action = (part.args as { action?: string } | null)?.action;
    if (action === "fold") return <FoldCard part={part} userId={env.userId} pool={env.pool} projectId={env.threadId} env={env.project} />;
    if (action === "draft") return <a href={href({ page: "project", userId: env.userId, pool: env.pool, threadId: env.threadId })}>Project settings</a>;
    if (action === "suggest") return <SuggestedCard part={part} userId={env.userId} pool={env.pool} projectId={env.threadId} env={env.project} />;
    // Her checklist shows in the header's facts line; its call is a marker like any tool's.
    if (action !== "steps") return <ThreadsCard part={part} env={env} />;
  }
  if (part.type === "delegation") return <Notice text={part.text} status={part.status} threads={part.threads} env={env} />;
  let label: React.ReactNode;
  let body: React.ReactNode;
  switch (part.type) {
    case "thinking":
      label = "Thought";
      body = <p className="thought">{part.text}</p>;
      break;
    case "recall":
    case "remember":
      label = part.type === "recall"
        ? `Recalled ${part.ids.length} ${part.ids.length === 1 ? "memory" : "memories"}`
        : `Remembered ${part.ids.length === 1 ? "a note" : `${part.ids.length} notes`}`;
      body = <ul>{part.ids.map((id) => <li key={id}><a href={idHref(env.userId, env.pool, id)}>{id}</a></li>)}</ul>;
      break;
    case "tool": {
      const state = part.result === undefined ? "running" : part.isError ? "failed" : "done";
      // A call on a machine names it first, and an MCP call its server.
      const mcp = mcpOf(part.name);
      const place = mcp?.server ?? machineOf(part.args);
      label = <>{place && <b className="place">{place}</b>}<b className="tool-name">{mcp?.tool ?? part.name}</b> <code>{summarizeArgs(part.args)}</code> <span className="state" data-state={state}>{state}</span></>;
      if (part.name === "image") {
        const args = (part.args ?? {}) as { action?: string; tier?: string };
        const making = args.action === "edit" ? "Editing an image" : args.action === "upscale" ? "Upscaling an image" : "Making an image";
        label = <><span>{making}{args.action === "create" && args.tier && <> · {args.tier}</>}</span><span className="state" data-state={state}>{state}</span></>;
      }
      body = (
        <>
          <pre>{JSON.stringify(part.args, null, 2)}</pre>
          {part.result !== undefined && <pre className={part.isError ? "tool-error" : ""}>{part.result}</pre>}
        </>
      );
      break;
    }
  }
  return (
    <div className="marker" data-type={part.type}>
      <button type="button" aria-expanded={open} onClick={toggle}>{label}</button>
      {open && <div className="marker-body">{body}</div>}
      {part.type === "tool" && part.name === "image" && part.imageRefusal && <ImageRefusalLinks part={part} env={env} />}
    </div>
  );
}

function ImageRefusalLinks({ part, env }: { part: Extract<MessagePart, { type: "tool" }>; env: Env }) {
  const [options, setOptions] = useState<ImageRetryOptions>();
  const [run, busy, error] = useAction();
  const path = `${env.base}/image-calls/${encodeURIComponent(part.toolCallId)}`;
  useEffect(() => {
    let live = true;
    setOptions(undefined);
    if (!env.busy && !env.subagent) void get<ImageRetryOptions>(path).then(o => { if (live) setOptions(o); }, () => {});
    return () => { live = false; };
  }, [path, env.busy, env.settingsVersion, env.lastUser]);
  const retry = (next: boolean) => void run(async () => { await post(path, { next }); });
  const edit = () => void run(async () => {
    const current = await get<ImageRetryOptions>(path);
    if (current.canEdit && current.userMessage) ask<EditMessageRequest>(EDIT_MESSAGE_EVENT, { base: env.base, text: current.userMessage.text });
    setOptions(current);
  });
  return <>
    <span className="image-refusal-note">The model declined this image.</span>
    {!busy && !env.busy && <div className="image-refusal-links">
      {options?.canEdit && <button type="button" className="link sm" onClick={edit}>Edit message</button>}
      <button type="button" className="link sm" onClick={() => retry(false)}>Resend</button>
      {options?.next && <button type="button" className="link sm" onClick={() => retry(true)}>Try {options.next.label}</button>}
    </div>}
    <ErrorText error={error} />
  </>;
}

function SubagentCard({ part, env }: { part: Extract<MessagePart, { type: "tool" }>; env: Env }) {
  const args = (part.args ?? {}) as { task?: string; role?: string; tier?: string };
  const state = part.result === undefined ? "running" : part.isError ? "failed" : "done";
  return (
    <div className="subagent">
      <div className="sub-head">
        <span className="status" data-state={state} aria-label={state} />
        <b>{args.role ?? "subagent"}</b>
        {args.tier && <span className="muted">{args.tier}</span>}
        <ThreadLinks threads={part.threads} env={env} />
      </div>
      {args.task && <div className="prose"><HerProse text={args.task} env={env} /></div>}
      {part.threads?.map((t, i) => <SubagentWork key={t.id} thread={t} label={part.threads!.length > 1 ? `Subagent ${i + 1}` : "Its work"} env={env} />)}
    </div>
  );
}

/** A `threads` call: a child thread started (with its checklist's count and current step), messaged or listed, linking to it. */
function ThreadsCard({ part, env }: { part: Extract<MessagePart, { type: "tool" }>; env: Env }) {
  const args = (part.args ?? {}) as { action?: string; title?: string; task?: string; text?: string; to?: string };
  const state = part.result === undefined ? "running" : part.isError ? "failed" : "done";
  const head = args.action === "start" ? `Child thread: ${args.title ?? ""}` : args.action === "list" ? "Child threads"
    : args.to === "parent" ? "Update to the parent thread" : "Message to a child thread";
  const started = args.action === "start" ? part.threads?.[0] : undefined;
  const child = started && findThread(env.threads, started.pool, started.id);
  return (
    <div className="subagent threads-card">
      <div className="sub-head">
        <span className="status" data-state={state} aria-label={state} />
        {/* A thread's title is as the user wrote it, so this head isn't capitalised as a role's is. */}
        <b className="as-is">{head}</b>
        {!!child?.steps?.length && <ChecklistButton steps={child.steps} card />}
        {args.to === "parent" ? null : <ThreadLinks threads={part.threads} env={env} />}
      </div>
      {child?.steps && child.state !== "resolved" && <StepLine steps={child.steps} />}
      {(args.task ?? args.text) && <div className="prose"><HerProse text={(args.task ?? args.text)!} env={env} /></div>}
      {part.isError && <ToolError text={String(part.result ?? "")} env={env} />}
    </div>
  );
}

/**
 * A message written in another thread (the parent's, or a sibling's in a project): collapsed
 * to one line, since it was said elsewhere, and expanded on tap; a long one shows its first lines
 * and Show more (docs/ux.md §6).
 */
function FromThread({ text, from, env, n }: { text: string; from: { kind: "parent" | "thread"; threadId: string }; env: Env; n?: number }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const title = useMentionText(`[t:${from.threadId}]`, env.userId, env.pool);
  const name = from.kind === "parent" ? env.parentTitle || title : title;
  // Clamped until Show more; the button shows only when the clamp hides something.
  useLayoutEffect(() => {
    if (!open || more) return;
    const el = body.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [open, more, text]);
  return (
    <div className="msg user from-thread" id={n !== undefined ? `m-${n}` : undefined}>
      <button type="button" className="from-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>Message received from <span className="from-name">{name}</span></span><Icon name="down" />
      </button>
      {open && (
        <>
          <div className="who">
            {her()}<span className="muted"> · from <a href={href({ page: "thread", userId: env.userId, pool: env.pool, threadId: from.threadId })}>{name}</a></span>
            {/* Branch and delete, as any message; it isn't hers to edit. */}
            {env.rewinder && n !== undefined && <MessageMenu n={n} role="user" rewinder={env.rewinder} branch />}
          </div>
          <div ref={body} className="body prose" data-clamped={more ? undefined : ""}><HerProse text={text} env={env} elsewhere /></div>
          {long && <button type="button" className="link show-more" onClick={() => setMore(!more)}>{more ? "Show less" : "Show more"}</button>}
        </>
      )}
    </div>
  );
}

/**
 * Her scheduled note (docs/ux.md §6): Routine ran with its schedule, or Woke up with when it was set
 * (and when it was due, if it fired late), opening to the note as a tinted block, as Message received does.
 */
export function ScheduledMarker({ text, setAt, dueAt, schedule, env, n }: { text: string; setAt?: string; dueAt?: string; schedule?: string; env: Env; n?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg user from-thread" data-type={schedule ? "routine" : "wakeup"} id={n !== undefined ? `m-${n}` : undefined}>
      <button type="button" className="from-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{schedule ? <>Routine ran · <ScheduleText text={schedule} /></> : <>Woke up · set <span className="num">{wakeTime(setAt!)}</span>{dueAt && <> · due <span className="num">{wakeTime(dueAt)}</span></>}</>}</span><Icon name="down" />
      </button>
      {open && (
        <>
          <div className="who">
            {her()}
            {env.rewinder && n !== undefined && <MessageMenu n={n} role="user" rewinder={env.rewinder} branch />}
          </div>
          <div className="body prose"><HerProse text={text} env={env} /></div>
        </>
      )}
    </div>
  );
}

/** A failed tool call's message, written for her: threads it names show by their current title. */
function ToolError({ text, env }: { text: string; env: Pick<Env, "userId" | "pool"> }) {
  return <p className="error">{useMentionText(text, env.userId, env.pool)}</p>;
}

/** A subagent's work, inline: its transcript, its waiting approvals, and a message box. */
function SubagentWork({ thread, label, env }: { thread: ThreadRef; label: string; env: Env }) {
  const [open, setOpen] = useState(false);
  const toggle = () => { env.show(thread.id, !open); setOpen(!open); };
  useEffect(() => () => env.show(thread.id, false), [thread.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="sub-work">
      <button type="button" className="quiet" aria-expanded={open} onClick={toggle}>{open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}</button>
      {open && (
        <>
          <Transcript thread={thread} env={env} />
          {env.permissions.filter((p) => p.subagent?.threadId === thread.id).map((p) => <PermissionPrompt key={p.requestId} base={env.base} p={p} env={env} />)}
          <MessageBox thread={thread} env={env} />
        </>
      )}
    </div>
  );
}

/** A subagent's stored thread, read-only, reloaded as it works. */
function Transcript({ thread, env }: { thread: ThreadRef; env: Env }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const tick = env.ticks[thread.id] ?? 0;
  useEffect(() => {
    let current = true;
    get<MessagePage>(threadPath(env.userId, thread.pool, thread.id, "messages")).then(
      (page) => { if (current) { setMessages(page.messages); setError(""); } },
      (e: Error) => current && setError(e.message),
    );
    return () => { current = false; };
  }, [env.userId, thread.pool, thread.id, tick]);
  const inner = { ...env, pool: thread.pool, threadId: thread.id, subagent: true, rewinder: undefined };
  return (
    <div className="transcript" aria-label="The subagent's work">
      <ErrorText error={error} />
      {messages.map((m) => <StoredMessage key={m.id} m={m} env={inner} you={env.you} />)}
    </div>
  );
}

/** Opens each subagent thread a run made: one Open link, or more than one behind a Threads pill (docs/briefs/thread-panel.md item 3). */
function ThreadLinks({ threads, env }: { threads?: ThreadRef[]; env: Env }) {
  if (!threads?.length) return null;
  if (threads.length === 1) {
    const t = threads[0]!;
    return <span className="open"><a href={href({ page: "thread", userId: env.userId, pool: t.pool, threadId: t.id })}>Open</a></span>;
  }
  return <ThreadsPill threads={threads} env={env} />;
}

/** A run's threads behind one "Threads 3 >" button in the card's head (docs/briefs/thread-panel.md item 3): it opens to them, each row its title cut to one line and its state as a dot and a word (docs/ux.md §5); a row opens the panel at 1180 px and wider and the page below. */
function ThreadsPill({ threads, env }: { threads: ThreadRef[]; env: Env }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  return (
    <span className="picker-anchor open threads-pill" ref={anchor}>
      <button type="button" className="link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        Threads <span className="num">{threads.length}</span> <Icon name="right" className="chev-ic" />
      </button>
      {open && (
        <div className="picker threads-pop" role="dialog" aria-label="The threads this run made">
          {threads.map((t) => {
            const s = findThread(env.threads, t.pool, t.id);
            return (
              <a key={t.id} className="picker-item thread-item" href={href({ page: "thread", userId: env.userId, pool: t.pool, threadId: t.id })} onClick={close}>
                {!s || s.state === "idle" || s.state === "queued" ? <span /> : <span className="status" data-state={s.needsYou ? "needsYou" : s.state} aria-hidden="true" />}
                <span className="title">{s?.title || "New thread"}</span>
                {s && <span className="tstate" data-state={s.needsYou ? "needsYou" : s.state ?? "idle"}>{stateWord(s)}</span>}
              </a>
            );
          })}
        </div>
      )}
    </span>
  );
}

const NOTICE_HEADS: Record<string, string> = {
  question: "Subagent asks", note: "Subagent note", user_message: "Message to a subagent", interrupted: "Subagent interrupted",
  update: "Child thread", limit: "Tool limit",
};

/** Something a subagent run delivered into the thread: a result, a question, a note, or what someone wrote to one. */
function Notice({ text, status, threads, env }: { text: string; status?: string; threads?: ThreadRef[]; env: Env }) {
  // In a project chat, a thread's updates go on its card (no card per update).
  if (env.project && (status === "update" || status === "waiting")) return null;
  return (
    <div className="subagent delivered" data-status={status}>
      <div className="sub-head"><b>{NOTICE_HEADS[status ?? ""] ?? "Subagent result"}</b><ThreadLinks threads={threads} env={env} /></div>
      <div className="prose"><HerProse text={text} env={env} /></div>
    </div>
  );
}

/**
 * Her text, with each thread she mentions shown by its current title, this thread's paths as links and its images
 * shown. `elsewhere`: the text was written in another thread, whose /workspace is not this one's, so paths stay text.
 */
function HerProse({ text, env, elsewhere, skipImages }: { text: string; env: Pick<Env, "userId" | "pool" | "threadId" | "large">; elsewhere?: boolean; /** Images shown already this turn, kept as links. */ skipImages?: ReadonlySet<string> }) {
  const files = useFileLinks(env.userId, env.pool, env.threadId);
  const { large } = env;
  const onLarge = useCallback((path: string) => large(path, files), [large, files]);
  return <Prose text={useThreadMentions(text, env.userId, env.pool)} files={elsewhere ? undefined : files} onLarge={onLarge} copyCode skipImages={skipImages} />;
}

/**
 * Writes to a subagent as the user: it joins its work, answers its question,
 * or continues it, and Lyrica is told.
 */
export function MessageBox({ thread, env, onSent }: { thread: ThreadRef; env: Pick<Env, "userId">; onSent?: () => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [run, busy, error] = useAction();
  const send = () => run(async () => {
    await post<SendResponse>(threadPath(env.userId, thread.pool, thread.id, "messages"), { text: text.trim() });
    setText("");
    setSent(true);
    onSent?.();
  });
  return (
    <form className="sub-message" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send(); }}>
      <textarea rows={2} aria-label="Message to the subagent" placeholder={`Message the subagent (${her()} is told)`} value={text}
        onChange={(e) => { setText(e.target.value); setSent(false); }} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !text.trim()}>Send</button>
        {sent && <span className="muted" role="status">Sent.</span>}
      </div>
      <ErrorText error={error} />
    </form>
  );
}

/** One line for a tool call: the command, path, Proxmox action or first argument; never the machine, which is named on its own. */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const { machine: _, ...a } = args as Record<string, unknown>;
  if (typeof a.action === "string") return [a.action, a.vm].filter((x) => typeof x === "string" && x).join(" ");
  const main = a.command ?? a.path ?? a.query ?? a.url ?? Object.values(a)[0];
  return typeof main === "string" ? main.split("\n")[0]! : JSON.stringify(main ?? "");
}

/** An MCP tool's server and its own name there, from Pi's `mcp__<server>__<tool>`. */
export function mcpOf(name: string): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : undefined;
}

/** The machine a call runs on, when its arguments name one. */
function machineOf(args: unknown): string | undefined {
  const m = args && typeof args === "object" ? (args as { machine?: unknown }).machine : undefined;
  return typeof m === "string" && m ? m : undefined;
}

/** What is being approved, in mono: the command, the path, or the Proxmox action and VM. */
function permissionText(args: unknown): string {
  if (!args || typeof args !== "object") return JSON.stringify(args);
  const { machine: _, ...a } = args as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.repository === "string") return `${a.repository} · ${String(a.account ?? "")}`;
  if (typeof a.action === "string") return [a.action, a.vm].filter((x) => typeof x === "string" && x).join(" ");
  if (typeof a.path === "string" && Object.keys(a).length === 1) return a.path;
  return JSON.stringify(a, null, 2);
}

export function PermissionPrompt({ base, p, env }: { base: string; p: PermissionRequest; env: Env }) {
  const [run, busy, error] = useAction();
  const answer = (allow: boolean, mode?: GoAhead, allowInThread?: boolean, alwaysAllow?: true) => run(() => post(`${base}/permissions/${encodeURIComponent(p.requestId)}`, { allow, mode, allowInThread, alwaysAllow }));
  const left = useCountdown(p.expiresAt);
  if (p.tool === "image") return <PortraitPrompt p={p} answer={answer} busy={busy} left={left} error={error} />;
  if (p.tool === "propose_plan" && !p.subagent) {
    // Her plan, from Plan mode: going ahead switches the thread to the mode picked.
    const plan = String((p.args as { plan?: unknown } | null)?.plan ?? "");
    const steps = plan.split("\n").filter((l) => /^\s*(\d+[.)]|[-*])\s/.test(l)).length;
    return (
      <div className="permission plan" role="group" aria-label={`${her()}'s plan`} data-pending="Plan">
        <div className="plan-head"><b>Plan</b>{steps > 1 && <span className="muted">{steps} steps</span>}</div>
        <div className="prose"><HerProse text={plan} env={env} /></div>
        <div className="row">
          <GoAheadMenu disabled={busy} onPick={(m) => answer(true, m)} />
          <button type="button" disabled={busy} onClick={() => answer(false)}>Keep planning</button>
          <span className="muted">{left}</span>
        </div>
        <ErrorText error={error} />
      </div>
    );
  }
  if (p.tool === "models" && !p.subagent) return <ServingPrompt p={p} answer={answer} busy={busy} left={left} error={error} />;
  if (p.tool === "download_model" && !p.subagent) return <DownloadPrompt p={p} answer={answer} busy={busy} left={left} error={error} />;
  const sub = p.subagent;
  // A subagent's request shows here and in its parent's thread; the first answer counts.
  const who = !sub ? <>{her()} wants</>
    : sub.threadId === env.threadId ? <>This subagent ({sub.role}) wants</>
    : <>Her <a href={href({ page: "thread", userId: env.userId, pool: env.pool, threadId: sub.threadId })}>{sub.role} subagent</a> wants</>;
  if (p.server) {
    // An MCP call its server doesn't mark read-only: the server first, the tool in mono, its arguments in full.
    return (
      <div className="permission" role="group" data-pending="Approval" aria-label={`Allow ${p.server}'s ${p.serverTool ?? p.tool}${sub ? ` for the ${sub.role} subagent` : ""}?`}>
        <p><b>{p.server}</b> · {who} to use <b className="mono">{p.serverTool ?? p.tool}</b>:</p>
        <pre>{JSON.stringify(p.args ?? {}, null, 2)}</pre>
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => answer(true)}>Allow</button>
          <button type="button" disabled={busy} title={`Stop asking about ${p.serverTool ?? p.tool} on ${p.server} for the rest of this thread`}
            onClick={() => answer(true, undefined, true)}>Allow in this thread</button>
          <button type="button" disabled={busy} onClick={() => answer(false)}>Deny</button>
          <span className="muted">{left}</span>
        </div>
        <ErrorText error={error} />
      </div>
    );
  }
  return (
    <div className="permission" role="group" data-pending="Approval" aria-label={`Allow ${p.tool}${p.machine ? ` on ${p.machine}` : ""}${sub ? ` for the ${sub.role} subagent` : ""}?`}>
      <p>{p.machine && <><b className="mono">{p.machine}</b> · </>}{who} to use <b>{p.tool}</b>{p.machine && p.cwd ? <> in <span className="mono">{p.cwd}</span></> : null}:</p>
      {p.warning && <p role="alert">{p.warning}</p>}
      <pre>{permissionText(p.args)}</pre>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => answer(true)}>Allow</button>
        {p.alwaysAllow && <button type="button" className="always-allow" disabled={busy} onClick={() => answer(true, undefined, undefined, true)}>Always allow <span className="mono">{p.alwaysAllow}</span></button>}
        <button type="button" disabled={busy} onClick={() => answer(false)}>Deny</button>
        {p.suspect && <button type="button" disabled={busy} onClick={() => answer(true, undefined, true)}>Allow in this thread</button>}
        <span className="muted">{left}</span>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

/** Daily portrait consent, including a subagent's request: no thread-wide Allow. */
export function PortraitPrompt({ p, answer, busy, left, error }: { p: PermissionRequest; answer: (allow: boolean) => void; busy: boolean; left: string; error: string }) {
  const a = (p.args ?? {}) as { model?: string; provider?: string };
  const question = `Send your portrait photos to ${a.model ?? a.provider ?? "the image model"} (cloud) for this image? A yes lasts until the end of the day.`;
  return (
    <div className="permission" role="group" data-pending="Approval" aria-label="Send portrait photos?">
      <p>{question}</p>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => answer(true)}>Send today</button>
        <button type="button" disabled={busy} onClick={() => answer(false)}>Not today</button>
        <span className="muted">{left}</span>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

/** Her `download_model` call: what, from where and to which host, in one question; the files in mono. */
function DownloadPrompt({ p, answer, busy, left, error }: { p: PermissionRequest; answer: (allow: boolean) => void; busy: boolean; left: string; error: string }) {
  const a = (p.args ?? {}) as { host?: string; repo?: string; files?: string[]; companions?: boolean };
  const files = Array.isArray(a.files) ? a.files : [];
  return (
    <div className="permission" role="group" data-pending="Approval" aria-label={`Download from ${a.repo ?? "a repository"}?`}>
      <p>
        Download from <b className="mono">{a.repo}</b>{a.host ? <> to <b>{a.host}</b></> : null}?
        {a.companions !== false && " A model's vision projector and MTP file come with it."}
      </p>
      <pre>{files.join("\n")}</pre>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => answer(true)}>Allow</button>
        <button type="button" disabled={busy} onClick={() => answer(false)}>Deny</button>
        <span className="muted">{left}</span>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

/** Her `models` tool's proposal: the change in one question, its numbers in mono. */
function ServingPrompt({ p, answer, busy, left, error }: { p: PermissionRequest; answer: (allow: boolean) => void; busy: boolean; left: string; error: string }) {
  const a = (p.args ?? {}) as { name?: string; contextLength?: number; kvBytes?: number | null; documented?: { factor: number; by: string } | null };
  const gb = (n: number) => { const g = n / 1024 ** 3; return g >= 10 ? String(Math.round(g)) : g.toFixed(1); };
  return (
    <div className="permission" role="group" data-pending="Approval" aria-label={`Serve ${a.name ?? "this model"} with a longer context?`}>
      <p>
        Serve <b>{a.name}</b> with <span className="mono">{(a.contextLength ?? 0).toLocaleString("en-US")}</span> tokens of context? It reloads
        {typeof a.kvBytes === "number" ? <>, and its KV cache grows to <span className="mono">{gb(a.kvBytes)}</span> GB.</> : "."}
        {a.documented && <> {a.documented.by} documents <span className="mono">{a.documented.factor}</span>.</>}
      </p>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => answer(true)}>Allow</button>
        <button type="button" disabled={busy} onClick={() => answer(false)}>Deny</button>
        <span className="muted">{left}</span>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

function useCountdown(iso: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  return s > 0 ? `Denied in ${s >= 60 ? `${Math.floor(s / 60)} min ` : ""}${s % 60} s if nobody answers` : "Denying…";
}

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** A compaction as one line until the Web UI 2 thread's marker, which expands to the summary. */
function compactedLabel(p: { before: number; after?: number }): string {
  return `Compacted · ${tokens(p.before)}${p.after !== undefined ? ` → ${tokens(p.after)}` : ""}`;
}
