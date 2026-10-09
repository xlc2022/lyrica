// The conversation: stored messages, then what's streaming now.
import { useEffect, useState } from "react";
import { post, type Message, type MessagePart, type PermissionRequest, type Pool, type ThreadSummary } from "./api.ts";
import type { LiveItem } from "./live.ts";
import { href, idHref } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import type { useThread } from "./stream.ts";
import { ErrorText, Prose, useAction } from "./ui.tsx";

interface Props {
  ctx: ShellContext;
  pool: Pool;
  base: string;
  thread: ReturnType<typeof useThread>;
  /** Subagents' threads, for their cards. */
  children_: ThreadSummary[];
}

export function Conversation({ ctx, pool, base, thread, children_ }: Props) {
  const { messages, live, hasMore, loadOlder, loaded } = thread;
  const [run, loading, error] = useAction();
  const env = { userId: ctx.user.id, pool, children: children_ };
  return (
    <>
      {hasMore && <button type="button" className="older" disabled={loading} onClick={() => run(loadOlder)}>Show earlier messages</button>}
      <ErrorText error={error} />
      {loaded && !messages.length && !live.items.length && <p className="muted empty">Say hello.</p>}
      {messages.map((m) => <StoredMessage key={m.id} m={m} env={env} you={ctx.user.displayName} />)}
      {live.items.map((item, i) => (
        <LiveMessage key={`live-${i}`} item={item} env={env} you={ctx.user.displayName} streaming={live.busy && i === live.items.length - 1} />
      ))}
      {live.busy && !live.items.some((x) => x.role === "assistant") && <p className="thinking-dots" role="status">Lyrica is thinking…</p>}
      {live.permissions.map((p) => <PermissionPrompt key={p.requestId} base={base} p={p} />)}
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

interface Env { userId: string; pool: Pool; children: ThreadSummary[] }

function StoredMessage({ m, env, you }: { m: Message; env: Env; you: string }) {
  if (m.role === "user") return <UserMessage text={m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")} you={you} />;
  return (
    <>
      <Parts parts={m.parts} env={env} model={m.model} />
      {m.error && <p className="error turn-error">{m.error}</p>}
    </>
  );
}

function LiveMessage({ item, env, you, streaming }: { item: LiveItem; env: Env; you: string; streaming: boolean }) {
  if (item.role === "user") return <UserMessage text={item.text} you={you} />;
  return <Parts parts={item.parts} env={env} model={item.model} streaming={streaming} />;
}

function UserMessage({ text, you }: { text: string; you: string }) {
  return (
    <div className="msg user">
      <div className="who">{you}</div>
      <div className="body">{text}</div>
    </div>
  );
}

/** Her message: prose for text, one-line markers for everything else. */
function Parts({ parts, env, model, streaming }: { parts: MessagePart[]; env: Env; model?: string; streaming?: boolean }) {
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
  return (
    <section className="turn" aria-label={model ? `Lyrica (${model})` : "Lyrica"}>
      <div className="who">Lyrica{model && <span className="muted"> · {model}</span>}</div>
      {out}
    </section>
  );
}

function Marker({ part, env }: { part: Exclude<MessagePart, { type: "text" }>; env: Env }) {
  const [open, setOpen] = useState(false);
  if (part.type === "tool" && part.name === "delegate") return <SubagentCard part={part} env={env} />;
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
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
      {open && <div className="marker-body">{body}</div>}
    </div>
  );
}

function SubagentCard({ part, env }: { part: Extract<MessagePart, { type: "tool" }>; env: Env }) {
  const args = (part.args ?? {}) as { task?: string; role?: string; tier?: string };
  // The subagent's thread ID appears in the tool's result.
  const child = part.result ? env.children.find((c) => part.result!.includes(c.id)) : undefined;
  const state = part.result === undefined ? "running" : part.isError ? "failed" : "done";
  return (
    <div className="subagent">
      <div className="sub-head">
        <span className="status" data-state={state} aria-label={state} />
        <b>{args.role ?? "subagent"}</b>
        {args.tier && <span className="muted">{args.tier}</span>}
        {child && <a className="open" href={href({ page: "thread", userId: env.userId, pool: child.pool, threadId: child.id })}>Open</a>}
      </div>
      {args.task && <p>{args.task}</p>}
    </div>
  );
}

/** One line for a tool call: the command, path or first argument. */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  const main = a.command ?? a.path ?? a.query ?? a.url ?? Object.values(a)[0];
  return typeof main === "string" ? main.split("\n")[0]! : JSON.stringify(main ?? "");
}

function PermissionPrompt({ base, p }: { base: string; p: PermissionRequest }) {
  const [run, busy, error] = useAction();
  const answer = (allow: boolean) => run(() => post(`${base}/permissions/${encodeURIComponent(p.requestId)}`, { allow }));
  const left = useCountdown(p.expiresAt);
  return (
    <div className="permission" role="group" aria-label={`Allow ${p.tool}?`}>
      <p>Lyrica wants to use <b>{p.tool}</b>:</p>
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
