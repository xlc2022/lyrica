// Command output (docs/ux.md §6, "Command output" and "Background jobs"): a bash call's whole output in its open row,
// and the thread's background jobs in the Jobs dropdown on the facts line, each streaming while it runs.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { get, type CommandOutputInfo, type CommandOutputText, type OutputEvent } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Icon } from "./icons.tsx";
import { ErrorText, useDismiss, useInView } from "./ui.tsx";

// --- The thread stream's output and jobs events, for the views that show them (stream.ts feeds these) ---

type OutputListener = (e: OutputEvent) => void;
const outputListeners = new Map<string, Set<OutputListener>>();
const jobsListeners = new Map<string, Set<() => void>>();

const listen = <T,>(map: Map<string, Set<T>>, base: string, fn: T) => {
  const set = map.get(base) ?? new Set<T>();
  set.add(fn);
  map.set(base, set);
  return () => { set.delete(fn); if (!set.size) map.delete(base); };
};

/** A running command printed something, in the thread at `base`. */
export function outputArrived(base: string, e: OutputEvent): void { for (const fn of outputListeners.get(base) ?? []) fn(e); }
/** A background job started or ended in the thread at `base`. */
export function jobsChanged(base: string): void { for (const fn of jobsListeners.get(base) ?? []) fn(); }

/** The most a view holds of a command streaming in: past it, its start goes, so a chatty job can't fill the page. */
const LIVE_CHARS = 2 * 1024 * 1024;
const utf8 = new TextEncoder();

/** How a command ended, in words, under its output. */
export function endLine(o: CommandOutputInfo): string | undefined {
  if (o.state === "running") return undefined;
  if (o.state === "timed out") return "Timed out";
  if (o.state === "stopped") return o.reason ? `Stopped: ${o.reason}` : "Stopped";
  if (o.exitCode !== undefined && o.exitCode !== null) return `Exited with code ${o.exitCode}`;
  return o.reason ? `Failed: ${o.reason}` : "Failed";
}

/**
 * A command's whole output: read from lyricad when shown, then what it prints while it runs, a few times a second.
 * The box follows the end unless the person scrolled up. `call` names a bash call (its row), `id` a job (its card).
 * Without kept output (a call from before it was kept), `fallback` shows, as the row did before.
 */
export function OutputBox({ base, call, id, running, fallback, failed, label }: {
  base: string; call?: string; id?: string; running: boolean; fallback?: string; failed?: boolean; label: string;
}) {
  const [text, setText] = useState<string>();
  const [info, setInfo] = useState<CommandOutputInfo>();
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  // The bytes of output this view holds the end of, so a piece it already has (sent while it loaded) isn't added twice.
  const seen = useRef(0);
  // A background job's row or card reads it again when it ends, for its end line and whatever was kept last.
  const [ended, setEnded] = useState(0);
  const job = info?.kind === "job" && info.state === "running";
  useEffect(() => (job ? listen(jobsListeners, base, () => setEnded((n) => n + 1)) : undefined), [base, job]);

  useEffect(() => {
    let live = true;
    let loaded = false;
    const early: OutputEvent[] = [];
    const add = (e: OutputEvent) => {
      if (e.to <= seen.current) return;
      // Part of it already here (sent while the view loaded): only the rest. A gap: lyricad skipped a flood's middle.
      let piece = e.data;
      if (e.at < seen.current) piece = new TextDecoder().decode(utf8.encode(e.data).subarray(seen.current - e.at));
      else if (e.at > seen.current) piece = `\n[… ${(e.at - seen.current).toLocaleString("en-US")} bytes skipped while it streamed …]\n${piece}`;
      seen.current = e.to;
      setText((t) => { const next = (t ?? "") + piece; return next.length > LIVE_CHARS ? next.slice(next.length - LIVE_CHARS) : next; });
    };
    // Listened to from the start: a bash call's row only learns it started a job once its output is read.
    const off = listen(outputListeners, base, (e: OutputEvent) => {
      if (call ? e.call !== call : e.id !== id) return;
      if (loaded) add(e); else early.push(e);
    });
    const path = call ? `${base}/outputs?call=${encodeURIComponent(call)}` : `${base}/outputs/${encodeURIComponent(id!)}`;
    get<CommandOutputText>(path).then((r) => {
      if (!live) return;
      loaded = true;
      seen.current = r.job.bytes;
      setInfo(r.job);
      setText(r.output);
      setMissing(false);
      for (const e of early.splice(0)) add(e);
    }, (e: Error & { status?: number }) => {
      if (!live) return;
      if (e.status === 404) setMissing(true); else setError(e.message);
    });
    return () => { live = false; off(); };
  }, [base, call, id, running, ended]);

  const [big, setBig] = useState(false);

  // Nothing kept to show (a call from before output was kept, or one that failed before printing): her result, as before.
  if (fallback !== undefined && (missing || (text === "" && info?.kind === "call" && info.state !== "running" && failed))) return <pre className={failed ? "tool-error" : ""}>{fallback}</pre>;
  if (error) return <ErrorText error={error} />;
  const going = running || info?.state === "running";
  const end = info && !going ? endLine(info) : undefined;
  const endNote = end && <p className={`cap read-note${info?.state === "exited" && info.exitCode === 0 ? "" : " danger"}`}>{end.split(/(\d+)/).map((t, i) => (i % 2 ? <span key={i} className="num">{t}</span> : t))}</p>;
  return (
    <div className="read-text command-output" data-kind="code">
      <div className="code-head">
        <span className="code-lang">{label}</span>
        <button type="button" className="icon sm code-expand" aria-label={`Expand ${label.toLowerCase()}`} title="Expand" onClick={() => setBig(true)}><Icon name="expand" /></button>
        <CopyButton text={text ?? ""} label="Copy" ariaLabel="Copy output" className="code-copy" />
      </div>
      <OutputText text={text} going={going} label={label} />
      {endNote}
      {big && (
        <OutputDialog label={label} info={info} text={text} onClose={() => setBig(false)}>
          <OutputText text={text} going={going} label={label} />
          {endNote}
        </OutputDialog>
      )}
    </div>
  );
}

/** The output itself, following its end as it arrives unless the person scrolled up to read. */
function OutputText({ text, going, label }: { text: string | undefined; going: boolean; label: string }) {
  const box = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  const onScroll = useCallback(() => {
    const el = box.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  }, []);
  return (
    <pre ref={box} className="read-body" onScroll={onScroll} tabIndex={0} aria-label={label} aria-busy={going || undefined}>
      {text === undefined ? <span className="muted">Loading…</span> : text || <span className="muted">{going ? "No output yet." : "No output."}</span>}
    </pre>
  );
}

/** A command's output large, in a dialog over the conversation (the whole screen on a phone), still streaming. */
function OutputDialog({ label, info, text, onClose, children }: {
  label: string; info: CommandOutputInfo | undefined; text: string | undefined; onClose: () => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); return () => el?.close(); }, []);
  const st = info && stateOf(info);
  return (
    <dialog ref={ref} className="viewer output-dialog" aria-label={info?.name ?? label}
      onCancel={(e) => { e.preventDefault(); onClose(); }} onKeyDown={(e) => { if (e.key === "Escape") e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); if (e.target === ref.current) onClose(); }}>
      <section className="viewer-file">
        <div className="viewer-head">
          <h2 className="changes-title">{info?.name ?? label}</h2>
          {info && <code className="name output-command" title={info.command}>{info.command}</code>}
          {info && st && (
            <span className="viewer-facts muted">
              <span className="status-word"><span className={`dot ${st.dot}`} aria-hidden="true" />{st.word}</span> · {info.place} · <span className="num">{ranFor(info)}</span>
            </span>
          )}
          <span className="viewer-acts">
            <CopyButton text={text ?? ""} label="Copy" ariaLabel="Copy output" />
            <button type="button" className="icon sm" aria-label="Close" title="Close" onClick={onClose}><Icon name="close" /></button>
          </span>
        </div>
        <div className="viewer-body command-output">{children}</div>
      </section>
    </dialog>
  );
}

// --- The Jobs dropdown ---

/** What the Jobs and Files search boxes read, as their tooltip. */
export const SEARCH_TIP = "Text, or a wildcard such as *.txt or file-?.log, or /a regular expression/. Case is ignored.";

type Sort = "newest" | "oldest" | "longest" | "name";
const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest" }, { value: "oldest", label: "Oldest" }, { value: "longest", label: "Longest" }, { value: "name", label: "Name" },
];
const SORT_KEY = "lyrica.jobs.sort";
const readSort = (): Sort => { try { const s = localStorage.getItem(SORT_KEY); return SORTS.some((x) => x.value === s) ? s as Sort : "newest"; } catch { return "newest"; } };

/** A job's state as a dot and a word. */
const STATE: Record<CommandOutputInfo["state"], { dot: string; word: string }> = {
  running: { dot: "info", word: "Running" }, exited: { dot: "up", word: "Exited" }, failed: { dot: "down", word: "Failed" },
  "timed out": { dot: "down", word: "Timed out" }, stopped: { dot: "away", word: "Stopped" },
};

/** How long a job ran, or has run: "42 s", "12 min", "3 h 5 min". */
export function ranFor(o: Pick<CommandOutputInfo, "startedAt" | "endedAt">, now = Date.now()): string {
  const s = Math.max(0, Math.round(((o.endedAt ? Date.parse(o.endedAt) : now) - Date.parse(o.startedAt)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A failed job, with its code: Exited with a code other than 0 reads as failed. */
const stateOf = (j: CommandOutputInfo) => (j.state === "exited" && j.exitCode !== 0 && j.exitCode !== undefined && j.exitCode !== null ? STATE.failed : STATE[j.state]);

/** The thread's background jobs, read again whenever one starts or ends; none until the thread has one. */
function useJobs(base: string, q: string, sort: Sort): { jobs: CommandOutputInfo[] | undefined; all: number; running: number; error: string } {
  const [jobs, setJobs] = useState<CommandOutputInfo[]>();
  const [counts, setCounts] = useState({ all: 0, running: 0 });
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => listen(jobsListeners, base, () => setTick((n) => n + 1)), [base]);
  // The count on the facts line: every job, whatever the search.
  useEffect(() => {
    let live = true;
    get<CommandOutputInfo[]>(`${base}/jobs`).then((all) => { if (live) setCounts({ all: all.length, running: all.filter((j) => j.state === "running").length }); }, () => {});
    return () => { live = false; };
  }, [base, tick]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      get<CommandOutputInfo[]>(`${base}/jobs?q=${encodeURIComponent(q)}&sort=${sort}`)
        .then((j) => { if (live) { setJobs(j); setError(""); } }, (e: Error) => { if (live) { setJobs(undefined); setError(e.message); } });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [base, q, sort, tick]);
  return { jobs, ...counts, error };
}

/**
 * **Jobs** on the thread's facts line: how many background jobs the thread has had, with a running dot while any
 * runs. It opens to a search box, a Sort select and a card per job (state, name, where, how long, the command), each
 * opening to its output, streaming while it runs.
 */
export function JobsFact({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>(readSort);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  useInView(anchor, open);
  const { jobs, all, running, error } = useJobs(base, open ? q : "", sort);
  // A running job's time ticks while the list is open.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!open || !running) return;
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open, running]);
  if (!all) return null;
  const pickSort = (s: Sort) => { setSort(s); try { localStorage.setItem(SORT_KEY, s); } catch { /* not kept */ } };
  const toggle = (id: string) => setShown((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <span className="picker-anchor" ref={anchor}>
      <button type="button" className="link" title="Background jobs" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {running > 0 && <span className="dot info" aria-hidden="true" />}Jobs <span className="num">{all}</span>
        {running > 0 && <span className="sr-only">, {running} running</span>} <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="picker jobs-pop" role="dialog" aria-label="Background jobs">
          <div className="jobs-tools">
            <input type="search" aria-label="Search jobs" placeholder="Search jobs" title={SEARCH_TIP} value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="Sort" value={sort} onChange={(e) => pickSort(e.target.value as Sort)}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <ErrorText error={error} />
          {jobs && !jobs.length && <p className="muted">{q ? "No job matches." : "No jobs."}</p>}
          {jobs?.map((j) => {
            const st = stateOf(j);
            const isOpen = shown.has(j.id);
            return (
              <div key={j.id} className="job-card" data-state={j.state}>
                <button type="button" className="job-head" aria-expanded={isOpen} title={j.id} onClick={() => toggle(j.id)}>
                  <span className="job-line">
                    <span className="status-word"><span className={`dot ${st.dot}`} aria-hidden="true" />{st.word}</span>
                    <b className="job-name">{j.name ?? j.command}</b>
                  </span>
                  <span className="job-facts muted">{j.place} · <span className="num">{ranFor(j)}</span></span>
                  <code className="job-command" title={j.command}>{j.command}</code>
                </button>
                {isOpen && <OutputBox base={base} id={j.id} running={j.state === "running"} label="Output" />}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
