// The changes view (docs/ux.md §6, "A thread's branch and pull request", "The changes a thread made"): a badge in
// the thread header for each checkout whose branch has moved from its base, opening a dialog almost the window's
// size with the files at the left, the commits under them and each file's differences at the right, unified or
// side by side. The daemon reads git where the thread's tools run (docs/daemon.md "Changes"); the lines are
// compared here (diff.ts) and nothing is stored.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get, type ChangedFile, type CheckResult, type CommitChanges, type FileSides, type OpenPull, type RepositoryChangesInfo, type ThreadChanges } from "./api.ts";
import { blocks, FOLD_STEP, lineDiff, sideBySide, type Line } from "./diff.ts";
import { Icon } from "./icons.tsx";
import type { DiffOp } from "./memory.ts";
import { useWide } from "./Shell.tsx";
import { ErrorText, fullTime, shortTime, useLoad } from "./ui.tsx";

const VIEW_KEY = "lyrica.changes.view";
/** Files past this many start folded, so a wide branch doesn't fetch every file at once. */
const OPEN_AT_ONCE = 40;

const sum = (files: ChangedFile[]) => files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });

/** The checks in a word: what the dot means, and the tooltip. */
export function checksState(checks: OpenPull["checks"]): { tone: "pending" | "ok" | "bad" | "none"; text: string } {
  if (!checks.length) return { tone: "none", text: "No checks reported" };
  const failed = checks.filter((c) => c.result && c.result !== "passed");
  const pending = checks.filter((c) => !c.result);
  const word = (r: CheckResult | null) => (r === null ? "running" : r === "passed" ? "passed" : r === "failed" ? "failed" : r === "cancelled" ? "cancelled" : "timed out");
  const list = checks.map((c) => `${c.name}: ${word(c.result)}`).join("\n");
  if (failed.length) return { tone: "bad", text: list };
  if (pending.length) return { tone: "pending", text: list };
  return { tone: "ok", text: list };
}

const Counts = ({ added, removed }: { added: number; removed: number }) => (
  <span className="counts num"><span className="cplus">+{added}</span> <span className="cminus">−{removed}</span></span>
);

/** One badge per checkout whose branch has moved from its base (or has a pull request), opening the view. */
export function ChangesFact({ base, activity }: { base: string; activity: number }) {
  // 409 (a locked home, an SSH target) and a thread with no checkout both show nothing.
  const changes = useLoad(() => get<ThreadChanges>(`${base}/changes`).catch(() => ({ repositories: [] as RepositoryChangesInfo[] })), [base, activity]);
  const [open, setOpen] = useState<string>();
  const shown = changes.data?.repositories.filter((r) => r.files.length || r.commits.length || r.pull) ?? [];
  const opened = shown.find((r) => r.path === open);
  return (
    <>
      {shown.map((r) => {
        const totals = sum(r.files), checks = r.pull && checksState(r.pull.checks);
        return (
          <button key={r.path} type="button" className="badge changes" aria-haspopup="dialog" title={`Changes in ${r.name}: ${r.branch || "detached"}`} onClick={() => setOpen(r.path)}>
            <Icon name={r.pull ? "pull" : "branch"} />
            {r.pull && <span className="num">#{r.pull.number}</span>}
            <span className="name folder">{r.branch || "detached"}</span>
            <Counts {...totals} />
            {checks && checks.tone !== "none" && <span className={`dot ${checks.tone === "ok" ? "up" : checks.tone === "bad" ? "down" : "away"}`} title={checks.text} />}
            <span className="caret">▾</span>
          </button>
        );
      })}
      {opened && <ChangesView base={base} repo={opened} onClose={() => { setOpen(undefined); changes.reload(); }} />}
    </>
  );
}

type Pick = "all" | "working" | string;

/** The dialog: the files and commits at the left, each file's differences at the right. */
export function ChangesView({ base, repo, onClose }: { base: string; repo: RepositoryChangesInfo; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const wide = useWide();
  const [view, setView] = useState<"unified" | "split">(() => { try { return localStorage.getItem(VIEW_KEY) === "split" ? "split" : "unified"; } catch { return "unified"; } });
  const split = wide && view === "split";
  const pickView = (v: "unified" | "split") => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* a private window */ } };
  const [pick, setPick] = useState<Pick>("all");
  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); return () => el?.close(); }, []);
  useEffect(() => { addEventListener("hashchange", onClose); return () => removeEventListener("hashchange", onClose); }, [onClose]);
  const picked = useLoad(() => (pick === "all" ? Promise.resolve({ files: repo.files }) : get<CommitChanges>(`${base}/changes/commit?repo=${encodeURIComponent(repo.path)}&hash=${encodeURIComponent(pick)}`)), [base, repo.path, repo.files, pick]);
  const files = picked.data?.files;
  const totals = sum(files ?? []);
  const listRef = useRef<HTMLDivElement>(null);
  const jump = (i: number) => listRef.current?.querySelector(`[data-file="${i}"]`)?.scrollIntoView({ block: "start" });
  const checks = repo.pull && checksState(repo.pull.checks);
  const heading = pick === "all" ? `${repo.base ?? "the base"} → ${repo.branch || "detached"}` : pick === "working" ? "Not committed" : repo.commits.find((c) => c.hash === pick)?.subject ?? pick.slice(0, 7);
  return (
    <dialog ref={ref} className="viewer changes-dialog" aria-label={`Changes in ${repo.name}`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <section className="viewer-file changes">
        <div className="viewer-head">
          <h2 className="changes-title">Changes</h2>
          <span className="name" title={repo.path}>{heading}</span>
          <span className="viewer-facts">
            {repo.pull && <a href={repo.pull.url} target="_blank" rel="noopener noreferrer" className="num" title={checks?.text}>#{repo.pull.number}</a>}
            {repo.pull && " · "}
            <Counts {...totals} />
          </span>
          <span className="viewer-acts">
            {wide && (
              <div className="seg" role="group" aria-label="View">
                <button type="button" className="sm" aria-pressed={!split} onClick={() => pickView("unified")}>Unified</button>
                <button type="button" className="sm" aria-pressed={split} onClick={() => pickView("split")}>Side by side</button>
              </div>
            )}
            <button type="button" className="icon sm" aria-label="Close" title="Close" onClick={onClose}><Icon name="close" /></button>
          </span>
        </div>
        <div className="changes-body">
          <nav className="changes-side" aria-label="Files and commits">
            <ul className="changes-files">
              {files?.map((f, i) => (
                <li key={f.path}>
                  <button type="button" onClick={() => jump(i)}>
                    <Icon name="file" className={f.kind} />
                    <span className="fname">{f.path.split("/").pop()}</span>
                    {f.path.includes("/") && <span className="fdir muted">{f.path.slice(0, f.path.lastIndexOf("/"))}</span>}
                    {f.binary ? <span className="muted">binary</span> : <Counts added={f.added} removed={f.removed} />}
                  </button>
                </li>
              ))}
              {files && !files.length && <li className="empty">No changes.</li>}
            </ul>
            <div className="changes-commits">
              <div className="eyebrow">Commits <span className="num">{repo.commits.length}</span></div>
              <button type="button" className="commit" aria-pressed={pick === "all"} onClick={() => setPick("all")}><span className="subject">All changes</span></button>
              {repo.uncommitted && <button type="button" className="commit" aria-pressed={pick === "working"} onClick={() => setPick("working")}><span className="subject">Not committed</span></button>}
              {repo.commits.map((c) => (
                <button key={c.hash} type="button" className="commit" aria-pressed={pick === c.hash} onClick={() => setPick(c.hash)}>
                  <span className="subject">{c.subject}</span>
                  <span className="cfacts muted"><span className="num">{c.hash.slice(0, 7)}</span> · {c.author} · <span className="num" title={fullTime(c.at)}>{shortTime(c.at)}</span></span>
                </button>
              ))}
            </div>
          </nav>
          <div className="changes-list" ref={listRef}>
            <ErrorText error={picked.error} />
            {files?.map((f, i) => <FileSection key={`${pick}:${f.path}`} index={i} base={base} repoPath={repo.path} file={f} commit={pick} split={split} startOpen={i < OPEN_AT_ONCE} />)}
          </div>
        </div>
      </section>
    </dialog>
  );
}

type Loaded = { kind: "loading" } | { kind: "sides"; lines: Line[]; note?: string } | { kind: "error"; message: string };

/** One file: its head line to fold it, then its differences with the unchanged stretches folded. */
function FileSection({ index, base, repoPath, file, commit, split, startOpen }: {
  index: number; base: string; repoPath: string; file: ChangedFile; commit: Pick; split: boolean; startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [unfolded, setUnfolded] = useState<ReadonlyMap<number, number>>(new Map());
  const wanted = open && !file.binary;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const q = `repo=${encodeURIComponent(repoPath)}&path=${encodeURIComponent(file.path)}${file.oldPath ? `&old=${encodeURIComponent(file.oldPath)}` : ""}&commit=${encodeURIComponent(commit)}`;
    get<FileSides>(`${base}/changes/file?${q}`).then((s) => {
      if (!live) return;
      if (s.binary) setState({ kind: "sides", lines: [], note: "Binary file" });
      else if (s.tooLarge) setState({ kind: "sides", lines: [], note: "Too large to show here (over 512 KB)" });
      else setState({ kind: "sides", lines: lineDiff(s.before ?? "", s.after ?? "") });
    }, (e: Error) => { if (live) setState({ kind: "error", message: e.message }); });
    return () => { live = false; };
  }, [wanted, base, repoPath, file.path, file.oldPath, commit]);
  const shown = useMemo(() => (state.kind === "sides" ? blocks(state.lines, unfolded) : []), [state, unfolded]);
  const unfold = (from: number) => setUnfolded((m) => new Map(m).set(from, (m.get(from) ?? 0) + FOLD_STEP));
  const name = file.path.split("/").pop(), dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  return (
    <section className="cfile" data-file={index} aria-label={file.path}>
      <button type="button" className="cfile-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "down" : "right"} />
        <Icon name="file" className={file.kind} />
        <span className="fname">{file.oldPath ? `${file.oldPath} → ${file.path}` : name}</span>
        {dir && !file.oldPath && <span className="fdir muted">{dir}</span>}
        {file.kind === "added" && <span className="pill">new</span>}
        {file.kind === "deleted" && <span className="pill">deleted</span>}
        {file.binary ? <span className="muted">binary</span> : <Counts added={file.added} removed={file.removed} />}
      </button>
      {open && (
        <div className={`cdiff ${split ? "split" : "unified"}`}>
          {file.binary && <p className="muted cnote">Binary file</p>}
          {!file.binary && state.kind === "loading" && <p className="muted cnote">Loading…</p>}
          {state.kind === "error" && <p className="error cnote">{state.message}</p>}
          {state.kind === "sides" && state.note && <p className="muted cnote">{state.note}</p>}
          {state.kind === "sides" && !state.note && !state.lines.some((l) => l.kind !== "same") && <p className="muted cnote">No differences in the text.</p>}
          {state.kind === "sides" && shown.map((b) => (b.kind === "fold"
            ? <button key={`f${b.from}`} type="button" className="cfold" onClick={() => unfold(b.from)}><Icon name="down" /><span className="num">{b.to - b.from}</span> unmodified lines</button>
            : split ? <SplitLines key={`l${b.from}`} lines={state.lines} from={b.from} to={b.to} /> : <UnifiedLines key={`l${b.from}`} lines={state.lines} from={b.from} to={b.to} />))}
        </div>
      )}
    </section>
  );
}

const Code = ({ text, ops }: { text: string; ops?: DiffOp[] }) => (
  <span className="code">{ops ? ops.map((o, i) => (o.kind === "same" ? <Fragment key={i}>{o.text}</Fragment> : <mark key={i} className={o.kind}>{o.text}</mark>)) : text || " "}</span>
);

function UnifiedLines({ lines, from, to }: { lines: Line[]; from: number; to: number }) {
  const out: ReactNode[] = [];
  for (let i = from; i < to; i++) {
    const l = lines[i]!;
    out.push(
      <div key={i} className={`dl ${l.kind}`}>
        <span className="ln">{l.kind !== "ins" ? l.a : ""}</span>
        <span className="ln">{l.kind !== "del" ? l.b : ""}</span>
        <span className="sign">{l.kind === "del" ? "−" : l.kind === "ins" ? "+" : " "}</span>
        <Code text={l.text} ops={l.kind === "same" ? undefined : l.ops} />
      </div>,
    );
  }
  return <>{out}</>;
}

function SplitLines({ lines, from, to }: { lines: Line[]; from: number; to: number }) {
  const side = (l: Line | undefined, which: "left" | "right") => (l
    ? <div className={`dl ${l.kind}`}><span className="ln">{which === "left" ? (l.kind !== "ins" ? l.a : "") : (l.kind !== "del" ? l.b : "")}</span><span className="sign">{l.kind === "del" ? "−" : l.kind === "ins" ? "+" : " "}</span><Code text={l.text} ops={l.kind === "same" ? undefined : l.ops} /></div>
    : <div className="dl blank" />);
  return <>{sideBySide(lines, from, to).map((r, i) => <div key={from + i} className="dr">{side(r.left, "left")}{side(r.right, "right")}</div>)}</>;
}
