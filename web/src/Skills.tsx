// Principles 3 and 6: her skills wait for the person unless they chose otherwise (docs/briefs/skills.md).
import { useState } from "react";
import { del, get, post, put, u, type SkillInfo, type Skills } from "./api.ts";
import { her } from "./name.ts";
import { Section } from "./Panel.tsx";
import type { ShellContext } from "./Shell.tsx";
import { Confirm, ErrorText, Switch, useAction, useLoad } from "./ui.tsx";

const LIMITS = { name: 64, description: 200, body: 8000 };
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const skillPath = (userId: string, s: Pick<SkillInfo, "pool" | "name">) => u(userId, "skills", s.pool, s.name);

/** What's wrong with a new skill, as a sentence, or nothing. */
function skillError(name: string, description: string, body: string): string | undefined {
  if (name && (name.length > LIMITS.name || !NAME.test(name))) return `A name is lowercase letters and digits joined by -, at most ${LIMITS.name} characters.`;
  if (description.length > LIMITS.description || description.includes("\n")) return `A description is one line of at most ${LIMITS.description} characters.`;
  if (body.length > LIMITS.body) return `The steps are at most ${LIMITS.body} characters.`;
  return undefined;
}

export function SkillsSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const page = useLoad(() => get<Skills>(u(userId, "skills")), [userId]);
  const [run, busy, error] = useAction();
  const [adding, setAdding] = useState(false);
  const act = (fn: () => Promise<Skills>) => run(async () => page.set(await fn()));
  return (
    <Section title="Skills">
      <p className="muted">Procedures for jobs that come up again. {her()} sees each one's name and description in every thread, and reads the steps when a job calls for them.</p>
      {page.data && <Switch label={`Approve ${her()}'s skills automatically`} hint={`When off, a skill ${her()} saves waits for you on a card in her thread and here.`}
        checked={page.data.autoApprove} disabled={busy} onChange={(on) => act(() => put<Skills>(u(userId, "skills", "auto-approve"), { autoApprove: on }))} />}
      <ErrorText error={page.error || error} />
      {page.data && !page.data.skills.length && <p className="muted">No skills yet.</p>}
      <ul className="list">
        {(page.data?.skills ?? []).map((s) => (
          <li key={`${s.pool}/${s.name}/${s.state}`} className="stack skill" data-state={s.state}>
            <SkillHead skill={s} />
            <p>{s.description}</p>
            <details><summary>Steps</summary><pre className="skill-body">{s.body}</pre></details>
            <div className="row">
              {s.state === "waiting" && <>
                <button type="button" className="primary" disabled={busy} onClick={() => act(() => post<Skills>(`${skillPath(userId, s)}/approve`))}>Approve</button>
                <button type="button" disabled={busy} onClick={() => act(() => post<Skills>(`${skillPath(userId, s)}/decline`))}>Decline</button>
              </>}
              {s.state !== "waiting" && <Confirm label="Remove" danger confirm="Remove" question={`Remove ${s.name}? ${her()} won't see it any more.`}
                onConfirm={() => act(() => del<Skills>(skillPath(userId, s)))} />}
            </div>
          </li>
        ))}
      </ul>
      {adding
        ? <AddSkill userId={userId} onDone={(saved) => { setAdding(false); if (saved) page.reload(); }} />
        : <div className="row"><button type="button" onClick={() => setAdding(true)}>Add skill</button></div>}
    </Section>
  );
}

function SkillHead({ skill: s }: { skill: SkillInfo }) {
  return (
    <div className="row skill-head">
      <b className="mono">{s.name}</b>
      {s.state !== "active" && <span className="status-word"><span className={`dot ${s.state === "waiting" ? "away" : "down"}`} aria-hidden="true" />{s.state === "waiting" ? "Waiting" : "Declined"}</span>}
      <span className="muted small">{s.author === "user" ? "Yours" : her()}{s.pool === "private" ? " · Private" : ""}</span>
    </div>
  );
}

function AddSkill({ userId, onDone }: { userId: string; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [run, busy, error] = useAction();
  const invalid = skillError(name.trim(), description.trim(), body.trim());
  const ready = !invalid && !!name.trim() && !!description.trim() && !!body.trim();
  return (
    <div className="stack">
      <label className="field"><span>Name</span><input className="mono" autoFocus placeholder="release-notes" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>When to use it</span><input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="field"><span>Steps</span><textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      {invalid && <p className="error">{invalid}</p>}
      <ErrorText error={error} />
      <div className="row">
        <button type="button" className="primary" disabled={!ready || busy} onClick={() => run(async () => {
          await post(u(userId, "skills"), { name: name.trim(), description: description.trim(), body: body.trim() });
          onDone(true);
        })}>Save</button>
        <button type="button" onClick={() => onDone(false)}>Cancel</button>
      </div>
    </div>
  );
}

/** Her save_skill call in the conversation: the draft, and Approve or Decline while it waits. */
export function SkillCard({ args, call, userId }: { args: unknown; call: string; userId: string }) {
  const a = (args ?? {}) as { name?: string; description?: string; body?: string };
  const page = useLoad(() => get<Skills>(u(userId, "skills")), [userId, call]);
  const [run, busy, error] = useAction();
  const skill = page.data?.skills.find((s) => s.call === call);
  if (!a.name) return null;
  const waiting = skill?.state === "waiting";
  const outcome = !page.data ? "" : !skill ? "Replaced or removed" : skill.state === "active" ? `In ${her()}'s skills` : skill.state === "declined" ? "Declined" : "";
  return (
    <div className={waiting ? "permission skill-card" : "subagent delivered skill-card"} role="group" aria-label={`Skill ${a.name}`} {...(waiting ? { "data-pending": "Skill" } : {})}>
      <div className="sub-head">
        <b className="as-is">New skill</b><span className="mono">{a.name}</span>
        {outcome && <span className="status-word"><span className={`dot ${skill?.state === "active" ? "up" : "down"}`} aria-hidden="true" />{outcome}</span>}
      </div>
      {a.description && <p>{a.description}</p>}
      <details><summary>Steps</summary><pre className="skill-body">{a.body}</pre></details>
      {waiting && <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => run(async () => page.set(await post<Skills>(`${skillPath(userId, skill)}/approve`)))}>Approve</button>
        <button type="button" disabled={busy} onClick={() => run(async () => page.set(await post<Skills>(`${skillPath(userId, skill)}/decline`)))}>Decline</button>
      </div>}
      <ErrorText error={page.error || error} />
    </div>
  );
}
