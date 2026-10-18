// Principles 1 and 6: a decision stays beside the work, and its answer is a message.
import { useEffect, useState } from "react";
import { get, post, type MessagePage, type QuestionState } from "./api.ts";
import { Icon } from "./icons.tsx";
import { ErrorText, useAction, useLoad } from "./ui.tsx";

interface Question { question: string; context?: string; recommended: number; options: { label: string; consequence: string }[] }

export function QuestionCard({ args, state, base, onChange }: { args: unknown; state?: QuestionState; base: string; onChange: () => void }) {
  const q = args as Question;
  const [run, busy, error] = useAction();
  const [answered, setAnswered] = useState<number>();
  useEffect(() => setAnswered(undefined), [base, state?.n, state?.answer]);
  const answer = state?.answer ?? answered;
  const closed = !!state?.closed || answer !== undefined;
  if (!q?.question || !Array.isArray(q.options)) return null;
  return <section className="question-card" aria-label={q.question} {...(!closed && state ? { "data-pending": "Question" } : {})}>
    <div className="question-title">{q.question}</div>
    {closed ? <p className="question-result">{typeof answer === "number" ? <><Icon name="check" />{q.options[answer]?.label}</> : answer === "words" ? "Answered in words." : "Withdrawn."}</p> : <>
      {q.context && <p className="muted">{q.context}</p>}
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
  const part = page.messages.find(m => m.n === n)?.parts.find(p => p.type === "tool" && p.name === "threads" && (p.args as { action?: string })?.action === "ask");
  return part?.type === "tool" ? { args: part.args, state } : undefined;
}
