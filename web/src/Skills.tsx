// Principles 3 and 6: her skills wait for the person unless they chose otherwise (docs/briefs/skills.md).
import { useRef, useState } from "react";
import { del, get, post, put, u, type Pool, type SkillInfo, type Skills, type SkillsExport, type SkillsImportResult } from "./api.ts";
import { Icon } from "./icons.tsx";
import { RowMenu } from "./Machines.tsx";
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
  const [adding, setAdding] = useState<"" | "skill" | "import">("");
  const act = (fn: () => Promise<Skills>) => run(async () => page.set(await fn()));
  return (
    <Section title="Skills" hint={`Procedures for jobs that come up again. ${her()} sees each one's name and description in every thread, and reads the steps when a job calls for them.`}>
      {page.data && <Switch label={`Approve ${her()}'s skills automatically`} hint={`When off, a skill ${her()} saves waits for you on a card in her thread and here.`}
        checked={page.data.autoApprove} disabled={busy} onChange={(on) => act(() => put<Skills>(u(userId, "skills", "auto-approve"), { autoApprove: on }))} />}
      <ErrorText error={page.error || error} />
      {page.data && !page.data.skills.length && <p className="muted">No skills yet.</p>}
      <ul className="list">
        {(page.data?.skills ?? []).map((s) => (
          <li key={`${s.pool}/${s.name}/${s.state}`} className="stack skill" data-state={s.state}>
            <SkillHead skill={s} />
            <p>{s.description}</p>
            <Steps id={`${s.pool}/${s.name}/${s.state}`} body={s.body} />
            <div className="row">
              {s.state === "waiting" && <>
                <button type="button" disabled={busy} onClick={() => act(() => post<Skills>(`${skillPath(userId, s)}/approve`))}>Approve</button>
                <button type="button" disabled={busy} onClick={() => act(() => post<Skills>(`${skillPath(userId, s)}/decline`))}>Decline</button>
              </>}
              {s.state !== "waiting" && <Confirm label="Remove" danger confirm="Remove" question={`Remove ${s.name}? ${her()} won't see it any more.`}
                onConfirm={() => act(() => del<Skills>(skillPath(userId, s)))} />}
            </div>
          </li>
        ))}
      </ul>
      {adding === "skill" ? <AddSkill userId={userId} onDone={(saved) => { setAdding(""); if (saved) page.reload(); }} />
        : adding === "import" ? <ImportSkills userId={userId} onImported={() => page.reload()} onDone={() => setAdding("")} />
        : <div className="row">
          <button type="button" onClick={() => setAdding("skill")}>Add skill</button>
          <RowMenu label="More skill actions" items={[
            ...(page.data?.skills.some((x) => x.state === "active") ? [{ label: "Export all", onPick: () => void run(() => exportAll(userId)) }] : []),
            { label: "Import…", onPick: () => setAdding("import") },
          ]} />
        </div>}
    </Section>
  );
}

/** Saves every active skill the display shows as one Markdown file; the text is held only in this page while it downloads. */
async function exportAll(userId: string): Promise<void> {
  const out = await post<SkillsExport>(u(userId, "skills", "export"));
  if (!out.count) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.markdown], { type: "text/markdown" }));
  a.download = out.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** Import: Markdown files read here and sent to lyricad; each skill is the person's and active, and nothing is replaced. */
function ImportSkills({ userId, onImported, onDone }: { userId: string; onImported: () => void; onDone: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [pool, setPool] = useState<"" | Pool>("");
  const [result, setResult] = useState<SkillsImportResult>();
  const picker = useRef<HTMLInputElement>(null);
  const [run, busy, error] = useAction();
  if (result) {
    const n = result.imported.length;
    return (
      <div className="stack">
        <p role="status">
          {n ? <>Imported <span className="num">{n}</span> {n === 1 ? "skill" : "skills"}</> : "Nothing new to import"}
          {result.duplicates > 0 && <> · <span className="num">{result.duplicates}</span> already here</>}
          {result.renamed > 0 && <> · <span className="num">{result.renamed}</span> renamed</>}
          {result.skipped > 0 && <> · <span className="num">{result.skipped}</span> skipped</>}
        </p>
        <div className="row"><button type="button" className="primary" onClick={onDone}>Done</button></div>
      </div>
    );
  }
  return (
    <form className="stack import-skills" onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        const read = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
        setResult(await post<SkillsImportResult>(u(userId, "skills", "import"), { files: read, ...(pool ? { pool } : {}) }));
        onImported();
      });
    }}>
      <div className="field"><span id="import-skill-files">Files</span>
        <div className="row">
          <button type="button" className="sm" aria-describedby="import-skill-files" onClick={() => picker.current?.click()}>Choose files…</button>
          {files.length > 0 && <span className="picked mono muted">{files.map((f) => f.name).join(", ")}</span>}
        </div>
        <input ref={picker} type="file" multiple hidden aria-labelledby="import-skill-files" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      </div>
      <label className="field"><span>Pool</span>
        <select value={pool} title="A file that doesn't name a pool goes to Private." onChange={(e) => setPool(e.target.value as "" | Pool)}>
          <option value="">As exported</option><option value="general">General</option><option value="private">Private</option>
        </select>
      </label>
      <ErrorText error={error} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !files.length}>Import</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

// Which folds are open, by skill: the conversation remounts her card when her turn ends, and an open fold stays open.
const openSteps = new Set<string>();

/** A skill's steps, folded: the chevron turns down while open. */
function Steps({ id, body }: { id: string; body: string }) {
  const [open, setOpen] = useState(() => openSteps.has(id));
  const toggle = () => {
    if (open) openSteps.delete(id); else openSteps.add(id);
    setOpen(!open);
  };
  return (
    <div>
      <button type="button" className="skill-fold" aria-expanded={open} onClick={toggle}><Icon name={open ? "down" : "right"} />Steps</button>
      {open && <pre className="skill-body">{body}</pre>}
    </div>
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
      <Steps id={`call:${call}`} body={a.body ?? ""} />
      {waiting && <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => run(async () => page.set(await post<Skills>(`${skillPath(userId, skill)}/approve`)))}>Approve</button>
        <button type="button" disabled={busy} onClick={() => run(async () => page.set(await post<Skills>(`${skillPath(userId, skill)}/decline`)))}>Decline</button>
      </div>}
      <ErrorText error={page.error || error} />
    </div>
  );
}
