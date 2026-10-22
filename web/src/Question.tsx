// Principles 1 and 6: a decision stays beside the work, and its answer is a message.
import { useEffect, useState } from "react";
import { get, post, type MessagePage, type MessagePart, type QuestionState, type RootStep } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Icon } from "./icons.tsx";
import { ErrorText, useAction, useLoad } from "./ui.tsx";

interface Question { question: string; context?: string; recommended: number; options: { label: string; consequence: string }[] }

/** The tool whose card asks to run a script as root (core ROOT_TOOL). */
export const ROOT_TOOL = "run_as_root";

/** Whether a tool part is a question card: threads ask, or a root step. */
export const isQuestionPart = (p: MessagePart): boolean =>
  p.type === "tool" && !p.isError && ((p.name === "threads" && (p.args as { action?: string })?.action === "ask") || p.name === ROOT_TOOL);

/** A root step's question, as core's rootAsk words it. */
function rootQuestion(args: unknown): Question | undefined {
  const a = args as { machine?: unknown; why?: unknown } | null;
  if (typeof a?.machine !== "string" || typeof a.why !== "string") return undefined;
  return {
    question: `Run as root on ${a.machine}?`, recommended: 0,
    options: [{ label: "Done", consequence: "You ran it. She checks the result and carries on." }, { label: "Not now", consequence: "Nothing runs. She says what waits on it." }],
  };
}

/** A block of mono text with Copy, as a code block in a message is. */
function Block({ label, text }: { label: string; text: string }) {
  return <div className="code-block">
    <div className="code-head"><span className="code-lang">{label}</span><CopyButton text={text} label="Copy" ariaLabel={`Copy ${label.toLowerCase()}`} className="code-copy" /></div>
    <pre><code>{text}</code></pre>
  </div>;
}

/** What a root step's card shows: why, the command (which checks the hash first), the hash, the script, and any sudoers lines. */
function RootDetails({ root }: { root: RootStep }) {
  return <div className="root-step">
    <p>{root.why}</p>
    <Block label="Command" text={root.command} />
    <p className="muted">SHA-256 <span className="mono">{root.sha256}</span></p>
    <div className="root-script"><Block label={root.path} text={root.script} /></div>
    {root.sudoers && <>
      <Block label="Sudoers" text={root.sudoers.map((l) => l.line).join("\n")} />
      {root.sudoers.filter((l) => l.warning).map((l, i) => <p key={i} className="warn-text">{`${l.line.split(" ").slice(3).join(" ")}: ${l.warning}.`}</p>)}
      <p className="muted mono">sudo visudo -f /etc/sudoers.d/lyrica</p>
    </>}
  </div>;
}

export function QuestionCard({ args, root, name, state, base, onChange }: { args: unknown; root?: RootStep; name?: string; state?: QuestionState; base: string; onChange: () => void }) {
  const q = (name === ROOT_TOOL ? rootQuestion(args) : args) as Question;
  const [run, busy, error] = useAction();
  const [answered, setAnswered] = useState<number>();
  useEffect(() => setAnswered(undefined), [base, state?.n, state?.answer]);
  const answer = state?.answer ?? answered;
  const closed = !!state?.closed || answer !== undefined;
  if (!q?.question || !Array.isArray(q.options)) return null;
  return <section className="question-card" aria-label={q.question} {...(!closed && state ? { "data-pending": "Question" } : {})}>
    <div className="question-title">{q.question}</div>
    {closed ? <p className="question-result">{typeof answer === "number" ? <><Icon name="check" />{q.options[answer]?.label}</> : answer === "words" ? "Answered in words." : "Withdrawn."}</p> : <>
      {root ? <RootDetails root={root} /> : q.context && <p className="muted">{q.context}</p>}
      <div className="question-options">{q.options.map((o, i) => <button type="button" key={i} className={i === q.recommended ? "primary" : ""} disabled={!state || busy} onClick={() => run(async () => {
        try { await post(`${base}/questions/${state!.n}/answer`, { option: i }); setAnswered(i); }
        finally { onChange(); }
      })}><span>{o.label}{i === q.recommended && <span className="question-recommended">Recommended</span>}</span><span className="question-consequence">{o.consequence}</span></button>)}</div>
    </>}
    <ErrorText error={error} />
  </section>;
}

/** Read only the waiting thread's encrypted conversation, including older pages if needed. */
export function ProjectQuestion({ base, n, onChange }: { base: string; n: number; onChange: () => void }) {
  const loaded = useLoad(() => loadProjectQuestion(base, n), [base, n]);
  return <><ErrorText error={loaded.error} />{loaded.data && <QuestionCard {...loaded.data} base={base} onChange={() => { loaded.reload(); onChange(); }} />}</>;
}

export async function loadProjectQuestion(base: string, n: number) {
  let page = await get<MessagePage>(`${base}/messages`);
  const state = page.questions?.find(q => q.n === n);
  while (page.hasMore && page.messages.length && page.messages[0]!.n > n) {
    page = await get<MessagePage>(`${base}/messages?before=${page.messages[0]!.n}`);
  }
  const part = page.messages.find(m => m.n === n)?.parts.find(isQuestionPart);
  return part?.type === "tool" ? { args: part.args, name: part.name, ...(part.root ? { root: part.root } : {}), state } : undefined;
}
