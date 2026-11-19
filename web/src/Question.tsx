// Principles 1 and 6: a decision stays beside the work, and its answer is a message.
import { useEffect, useId, useState } from "react";
import { del, get, post, type MessagePage, type MessagePart, type QuestionCardData, type QuestionState, type RootStep } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { ErrorText, useAction, useLoad } from "./ui.tsx";

interface Question { question: string; context?: string; recommended: number; options: { label: string; consequence: string }[] }

/** The tool whose card asks to run a script as root (core ROOT_TOOL), and the one that asks for a secret (core SECRET_TOOL). */
export const ROOT_TOOL = "run_as_root";
export const SECRET_TOOL = "run_with_secret";
/** The longest a sudo password may be kept, in minutes (core KEEP_PASSWORD_MINUTES). */
const KEEP_MAX = 60;

/** Whether a tool part is a question card: threads ask, a root step, or a secret's card. */
export const isQuestionPart = (p: MessagePart): boolean =>
  p.type === "tool" && !p.isError && ((p.name === "threads" && (p.args as { action?: string })?.action === "ask") || p.name === ROOT_TOOL || p.name === SECRET_TOOL);

/** A root step's question, as core's rootAsk numbers its answers (Done 0, Not now 1, Run 2), in her name. */
function rootQuestion(args: unknown): Question | undefined {
  const a = args as { machine?: unknown; why?: unknown } | null;
  if (typeof a?.machine !== "string" || typeof a.why !== "string") return undefined;
  return {
    question: `Run as root on ${a.machine}?`, recommended: 0,
    options: [
      { label: "Done", consequence: `Already run by hand. ${her()} checks the result and carries on.` },
      { label: "Not now", consequence: `Nothing runs. ${her()} says what waits on this.` },
      { label: "Run", consequence: `Sudo takes the password for this script only. It never goes into the chat.` },
    ],
  };
}

/** A secret's question, as core's secretAsk numbers its answers (Run 0, Not now 1). */
function secretQuestion(args: unknown): Question | undefined {
  const a = args as { machine?: unknown; why?: unknown; secret?: unknown } | null;
  if (typeof a?.machine !== "string" || typeof a.why !== "string" || typeof a.secret !== "string") return undefined;
  return {
    question: `Run with a secret on ${a.machine}?`, recommended: 0,
    options: [
      { label: "Run", consequence: `What's typed here goes to this script, never into the chat. The script runs under ${her()}'s account and can read the secret there, so use a key that expires.` },
      { label: "Not now", consequence: `Nothing runs. ${her()} says what waits on this.` },
    ],
  };
}

/** A block of mono text with Copy, as a code block in a message is. */
function Block({ label, text }: { label: string; text: string }) {
  return <div className="code-block">
    <div className="code-head"><span className="code-lang">{label}</span><CopyButton text={text} label="Copy" ariaLabel={`Copy ${label.toLowerCase()}`} className="code-copy" /></div>
    <pre><code>{text}</code></pre>
  </div>;
}

/** What a root step's card shows: why, the command (which checks the hash first), the hash, the script, and any sudoers lines with the command that adds them (a card from before that command existed names visudo instead; on NixOS, one Configuration block of extraRules and the rebuild). */
function RootDetails({ root }: { root: RootStep }) {
  return <div className="root-step">
    <Block label="Command" text={root.command} />
    <p className="muted">SHA-256 <span className="mono">{root.sha256}</span></p>
    <div className="root-script"><Block label={root.path} text={root.script} /></div>
    {root.sudoers && <>
      <Block label={root.sudoersNixos ? "Configuration" : "Sudoers"} text={root.sudoersNixos ?? root.sudoers.map((l) => l.line).join("\n")} />
      {root.sudoers.filter((l) => l.warning).map((l, i) => <p key={i} className="warn-text">{`${l.line.split(" ").slice(3).join(" ")}: ${l.warning}.`}</p>)}
      {root.sudoersNixos ? null : root.sudoersCommand ? <Block label="Command" text={root.sudoersCommand} /> : <p className="muted mono">sudo visudo -f /etc/sudoers.d/lyrica</p>}
    </>}
  </div>;
}

/**
 * The field on a root step's or a secret's card (docs/ux.md): masked, with Show; a box of several lines when the
 * secret asks for one; on a root step, Keep for in minutes, or the kept password's minutes left with Forget.
 */
function SecretField({ label, lines, sudo, kept, value, setValue, keep, setKeep, onForget, disabled }: {
  label: string; lines?: boolean; sudo: boolean; kept?: number; value: string; setValue: (v: string) => void;
  keep: string; setKeep: (v: string) => void; onForget: () => void; disabled: boolean;
}) {
  const [shown, setShown] = useState(false);
  const id = useId(), keepId = useId();
  const tip = sudo ? `Goes to sudo for this script, never into the chat; forgotten when the script ends.` : `Goes only to this script's input, never into the chat; forgotten when the script ends.`;
  const common = { id, value, autoComplete: "off", spellCheck: false, disabled, onChange: (e: { target: { value: string } }) => setValue(e.target.value) };
  return <div className="card-secret">
    <label htmlFor={kept ? undefined : id} title={tip}>{label}<Icon name="lock" /></label>
    {kept ? <div className="card-secret-row"><span className="muted">Kept · <span className="num">{kept}</span> min left</span><button type="button" className="sm" disabled={disabled} onClick={onForget}>Forget</button></div> : <>
      <div className="card-secret-row">
        {lines ? <textarea {...common} className={shown ? "" : "masked"} rows={5} /> : <input {...common} type={shown ? "text" : "password"} />}
        <button type="button" className="sm" aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>
      </div>
      {sudo && <div className="card-keep">
        <label htmlFor={keepId}>Keep for</label>
        <input id={keepId} type="text" inputMode="numeric" value={keep} disabled={disabled} onChange={(e) => setKeep(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          onBlur={() => setKeep(String(Math.min(KEEP_MAX, Math.max(0, Number(keep) || 0))))} />
        <span className="muted">min, of <span className="num">{KEEP_MAX}</span></span>
      </div>}
      {sudo && <p className="muted card-keep-note">The server holds the password in memory for that long, so later root steps on this machine skip typing it. Each still waits for Run.</p>}
    </>}
  </div>;
}

export function QuestionCard({ args, root, name, state, base, onChange }: { args: unknown; root?: RootStep; name?: string; state?: QuestionState; base: string; onChange: () => void }) {
  const q = (name === ROOT_TOOL ? rootQuestion(args) : name === SECRET_TOOL ? secretQuestion(args) : args) as Question;
  const [run, busy, error] = useAction();
  const [answered, setAnswered] = useState<number>();
  const [value, setValue] = useState("");
  const [keep, setKeep] = useState("0");
  useEffect(() => setAnswered(undefined), [base, state?.n, state?.answer]);
  const answer = state?.answer ?? answered;
  const closed = !!state?.closed || answer !== undefined;
  if (!q?.question || !Array.isArray(q.options)) return null;
  const sudo = name === ROOT_TOOL;
  // Run is the option the card's own route answers: shown first, and only with the step the card read.
  const runAt = name === ROOT_TOOL ? 2 : name === SECRET_TOOL ? 0 : -1;
  const hasRun = runAt >= 0 && !!root;
  const order = hasRun ? [runAt, ...q.options.map((_, i) => i).filter((i) => i !== runAt)] : q.options.map((_, i) => i).filter((i) => i !== runAt);
  const recommended = hasRun ? runAt : q.recommended;
  const ready = !!value.trim() || !!state?.kept;
  const press = (i: number) => run(async () => {
    try {
      if (i === runAt) {
        const minutes = sudo && !state?.kept ? Math.min(KEEP_MAX, Math.max(0, Number(keep) || 0)) : 0;
        // Raw bytes, never JSON: lyricad wipes them once the script has them.
        await post(`${base}/questions/${state!.n}/run${minutes ? `?keep=${minutes}` : ""}`, new Blob([value]));
        setValue("");
      } else await post(`${base}/questions/${state!.n}/answer`, { option: i });
      setAnswered(i);
    } finally { onChange(); }
  });
  return <section className="question-card" aria-label={q.question} {...(!closed && state ? { "data-pending": "Question" } : {})}>
    <div className="question-title">{q.question}</div>
    {closed ? <p className="question-result">{typeof answer === "number" ? <><Icon name="check" />{q.options[answer]?.label}</> : answer === "words" ? "Answered in words." : "Withdrawn."}</p> : <>
      {root ? <>
        <p>{root.why}</p>
        {hasRun && <SecretField label={root.secret ?? "Password"} lines={root.lines} sudo={sudo} kept={state?.kept} value={value} setValue={setValue} keep={keep} setKeep={setKeep} disabled={!state || busy}
          onForget={() => run(async () => { try { await del(`${base}/questions/${state!.n}/run`); } finally { onChange(); } })} />}
        <RootDetails root={root} />
      </> : q.context && <p className="muted">{q.context}</p>}
      <div className="question-options">{order.map((i) => { const o = q.options[i]!; return <button type="button" key={i} className={i === recommended ? "primary" : ""} disabled={!state || busy || (i === runAt && !ready)} onClick={() => press(i)}>
        <span>{o.label}{i === recommended && <span className="question-recommended">Recommended</span>}</span><span className="question-consequence">{o.consequence}</span></button>; })}</div>
    </>}
    <ErrorText error={error} />
  </section>;
}

/** Read only the waiting thread's encrypted conversation, including older pages if needed. */
export function ProjectQuestion({ base, n, onChange }: { base: string; n: number; onChange: () => void }) {
  const loaded = useLoad(() => loadProjectQuestion(base, n), [base, n]);
  return <><ErrorText error={loaded.error} />{loaded.data && <QuestionCard {...loaded.data} base={base} onChange={() => { loaded.reload(); onChange(); }} />}</>;
}

/** One thread's open question's card from its route (GET …/question/card), for a Notifications row to show it in place. */
export async function loadQuestionCard(base: string) {
  return get<QuestionCardData>(`${base}/question/card`);
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
