// The conversation: stored messages, then what's streaming now.
import { useEffect, useState } from "react";
import { get, post, threadPath, type Message, type MessagePage, type MessagePart, type PermissionRequest, type Pool, type SendResponse, type ThreadRef } from "./api.ts";
import type { LiveItem } from "./live.ts";
import { href, idHref } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import type { useThread } from "./stream.ts";
import { EditBox, MessageMenu, type Rewinder } from "./Rewind.tsx";
import { ErrorText, Prose, useAction } from "./ui.tsx";

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
}

export function Conversation({ ctx, pool, base, threadId, subagent, thread, rewinder, hideFrom }: Props) {
  const { messages, live, hasMore, loadOlder, loaded } = thread;
  const [run, loading, error] = useAction();
  // Expanded tool markers, by call ID, so they stay open when the stored copy replaces the live one.
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(new Set());
  const toggleTool = (id: string) => setOpenTools((o) => { const n = new Set(o); if (!n.delete(id)) n.add(id); return n; });
  // Subagents whose work is shown in their delegate card here: their approvals show there too.
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const show = (id: string, on: boolean) => setShown((o) => { const n = new Set(o); if (on) n.add(id); else n.delete(id); return n; });
  const env: Env = {
    userId: ctx.user.id, you: ctx.user.displayName, pool, base, threadId, subagent, openTools, toggleTool,
    permissions: live.permissions, ticks: live.subagents, show, rewinder,
  };
  const shownMessages = hideFrom === undefined ? messages : messages.filter((m) => m.n < hideFrom);
  return (
    <>
      {hasMore && <button type="button" className="older" disabled={loading} onClick={() => run(loadOlder)}>Show earlier messages</button>}
      <ErrorText error={error} />
      {loaded && !messages.length && !live.items.length && <p className="muted empty">Say hello.</p>}
      {shownMessages.map((m) => <StoredMessage key={m.id} m={m} env={env} you={ctx.user.displayName} />)}
      {hideFrom === undefined && live.items.map((item, i) => (
        <LiveMessage key={`live-${i}`} item={item} env={env} you={ctx.user.displayName} streaming={live.busy && i === live.items.length - 1} />
      ))}
      {live.busy && !live.items.some((x) => x.role === "assistant") && <p className="thinking-dots" role="status">Lyrica is thinking…</p>}
      {live.permissions.filter((p) => !p.subagent || !shown.has(p.subagent.threadId) || p.subagent.threadId === threadId)
        .map((p) => <PermissionPrompt key={p.requestId} base={base} p={p} env={env} />)}
      {live.errors.map((e, i) => <p key={i} className="error turn-error" role="alert">{e}</p>)}
      {live.queued.map((q, i) => (
        <div key={`q-${i}`} className="msg user queued">
          <div className="who">{ctx.user.displayName} · waiting</div>
          <div className="body">{q}</div>
        </div>
      ))}
    </>
  );
}

interface Env {
  userId: string;
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
}

function StoredMessage({ m, env, you }: { m: Message; env: Env; you: string }) {
  if (m.role === "user") {
    const who = m.from?.kind === "lyrica" ? "Lyrica" : m.from?.kind === "user" ? (m.from.name || you) : you;
    return <UserMessage text={m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")} you={who} n={m.n} rewinder={env.rewinder} />;
  }
  if (m.role === "notice") {
    return <>{m.parts.map((p, i) => (p.type === "delegation"
      ? <Notice key={i} text={p.text} status={p.status} threads={p.threads} env={env} />
      : <Notice key={i} text={p.type === "text" ? p.text : ""} env={env} />))}</>;
  }
  return (
    <>
      <Parts parts={m.parts} env={env} model={m.model} n={m.n} />
      {m.error && <p className="error turn-error">{m.error}</p>}
    </>
  );
}

function LiveMessage({ item, env, you, streaming }: { item: LiveItem; env: Env; you: string; streaming: boolean }) {
  if (item.role === "user") return <UserMessage text={item.text} you={you} />;
  if (item.role === "notice") return <Notice text={item.text} status={item.status} threads={item.threads} env={env} />;
  return <Parts parts={item.parts} env={env} model={item.model} streaming={streaming} />;
}

function UserMessage({ text, you, n, rewinder }: { text: string; you: string; n?: number; rewinder?: Rewinder }) {
  const [editing, setEditing] = useState(false);
  const menu = rewinder && n !== undefined;
  return (
    <div className="msg user">
      <div className="who">{you}{menu && <MessageMenu n={n} role="user" rewinder={rewinder} onEdit={() => setEditing(true)} />}</div>
      {editing && menu
        ? <EditBox text={text} onCancel={() => setEditing(false)} onSend={(t) => { setEditing(false); rewinder.rewind(n, { action: "edit", text: t }, n); }} />
        : <div className="body">{text}</div>}
    </div>
  );
}

/** Her message: prose for text, one-line markers for everything else. */
function Parts({ parts, env, model, streaming, n }: { parts: MessagePart[]; env: Env; model?: string; streaming?: boolean; n?: number }) {
  const out: React.ReactNode[] = [];
  let prose: string[] = [];
  const flush = (key: number, last: boolean) => {
    if (!prose.length) return;
    out.push(
      <div key={`p${key}`} className="msg her">
        <div className="body prose">
          <Prose text={prose.join("")} />
          {streaming && last && <span className="caret" aria-hidden="true" />}
        </div>
      </div>,
    );
    prose = [];
  };
  parts.forEach((p, i) => {
    if (p.type === "text") { prose.push(p.text); return; }
    flush(i, false);
    out.push(<Marker key={i} part={p} env={env} />);
  });
  flush(parts.length, true);
  if (streaming && parts.at(-1)?.type !== "text") out.push(<span key="caret" className="caret alone" aria-hidden="true" />);
  // In a subagent's thread, the replies are the subagent's own work.
  const who = env.subagent ? "Subagent" : "Lyrica";
  return (
    <section className="turn" aria-label={model ? `${who} (${model})` : who}>
      <div className="who">
        {who}{model && <span className="muted"> · {model}</span>}
        {env.rewinder && n !== undefined && <MessageMenu n={n} role="assistant" rewinder={env.rewinder} />}
      </div>
      {out}
    </section>
  );
}

function Marker({ part, env }: { part: Exclude<MessagePart, { type: "text" }>; env: Env }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = part.type === "tool" ? env.openTools.has(part.toolCallId) : localOpen;
  const toggle = () => (part.type === "tool" ? env.toggleTool(part.toolCallId) : setLocalOpen(!localOpen));
  if (part.type === "tool" && part.name === "delegate") return <SubagentCard part={part} env={env} />;
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
      label = <><b className="tool-name">{part.name}</b> <code>{summarizeArgs(part.args)}</code> <span className="state" data-state={state}>{state}</span></>;
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
    </div>
  );
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
      {args.task && <p>{args.task}</p>}
      {part.threads?.map((t, i) => <SubagentWork key={t.id} thread={t} label={part.threads!.length > 1 ? `Subagent ${i + 1}` : "Its work"} env={env} />)}
    </div>
  );
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

/** Opens each subagent thread a run made. */
function ThreadLinks({ threads, env }: { threads?: ThreadRef[]; env: Env }) {
  if (!threads?.length) return null;
  return (
    <span className="open">
      {threads.map((t, i) => (
        <a key={t.id} href={href({ page: "thread", userId: env.userId, pool: t.pool, threadId: t.id })}>
          {threads.length > 1 ? `Open ${i + 1}` : "Open"}
        </a>
      ))}
    </span>
  );
}

const NOTICE_HEADS: Record<string, string> = {
  question: "Subagent asks", note: "Subagent note", user_message: "Message to a subagent", interrupted: "Subagent interrupted",
};

/** Something a subagent run delivered into the thread: a result, a question, a note, or what someone wrote to one. */
function Notice({ text, status, threads, env }: { text: string; status?: string; threads?: ThreadRef[]; env: Env }) {
  return (
    <div className="subagent delivered" data-status={status}>
      <div className="sub-head"><b>{NOTICE_HEADS[status ?? ""] ?? "Subagent result"}</b><ThreadLinks threads={threads} env={env} /></div>
      <div className="prose"><Prose text={text} /></div>
    </div>
  );
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
      <textarea rows={2} aria-label="Message to the subagent" placeholder="Message the subagent (Lyrica is told)" value={text}
        onChange={(e) => { setText(e.target.value); setSent(false); }} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !text.trim()}>Send</button>
        {sent && <span className="muted" role="status">Sent.</span>}
      </div>
      <ErrorText error={error} />
    </form>
  );
}

/** One line for a tool call: the command, path or first argument. */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  const main = a.command ?? a.path ?? a.query ?? a.url ?? Object.values(a)[0];
  return typeof main === "string" ? main.split("\n")[0]! : JSON.stringify(main ?? "");
}

function PermissionPrompt({ base, p, env }: { base: string; p: PermissionRequest; env: Env }) {
  const [run, busy, error] = useAction();
  const answer = (allow: boolean) => run(() => post(`${base}/permissions/${encodeURIComponent(p.requestId)}`, { allow }));
  const left = useCountdown(p.expiresAt);
  const sub = p.subagent;
  // A subagent's request shows here and in its parent's thread; the first answer counts.
  const who = !sub ? <>Lyrica wants</>
    : sub.threadId === env.threadId ? <>This subagent ({sub.role}) wants</>
    : <>Her <a href={href({ page: "thread", userId: env.userId, pool: env.pool, threadId: sub.threadId })}>{sub.role} subagent</a> wants</>;
  return (
    <div className="permission" role="group" aria-label={`Allow ${p.tool}${sub ? ` for the ${sub.role} subagent` : ""}?`}>
      <p>{who} to use <b>{p.tool}</b>:</p>
      <pre>{typeof p.args === "object" && p.args && "command" in p.args ? String((p.args as { command: unknown }).command) : JSON.stringify(p.args, null, 2)}</pre>
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
