// A background command that ended, as its notice in the conversation (docs/ux.md, "A background command that ended";
// docs/workspace.md, "Background commands"). The notice is the text she was told (core's `jobNotice`); this reads it
// back into its parts, so the command and its output keep their lines in blocks of their own.
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { OutputBox } from "./CommandOutput.tsx";

export interface EndedJob {
  id: string;
  /** The name she gave it, when she gave one. */
  name?: string;
  /** "sandbox" or the machine's name. */
  place: string;
  state: "exited" | "failed" | "timed out" | "stopped";
  exitCode?: number;
  /** As the notice words it: "23 s", "12 min", "3 h 5 min". */
  took: string;
  reason?: string;
  command: string;
  /** Its last lines; empty when it printed nothing. */
  output: string;
}

const HEAD = /^Background command (j\d+)(?: \(([^()]*)\))? in (the sandbox|.+?), (exited|failed|timed out|stopped)(?: with code (-?\d+))? after (\d+ s|\d+ min|\d+ h \d+ min)(?: \((.*?)\))?: /;
const OUTPUT = "\nLast output:\n";
const NONE = "\nNo output.";

/** A background command's notice read back into its parts; undefined for any other text (an MCP server's or the browser's end). */
export function parseJobNotice(text: string): EndedJob | undefined {
  const m = HEAD.exec(text);
  if (!m) return undefined;
  const rest = text.slice(m[0].length);
  const at = rest.indexOf(OUTPUT);
  let command: string, output: string;
  if (at >= 0) [command, output] = [rest.slice(0, at), rest.slice(at + OUTPUT.length)];
  else if (rest.endsWith(NONE)) [command, output] = [rest.slice(0, -NONE.length), ""];
  else return undefined;
  return {
    id: m[1]!, ...(m[2] ? { name: m[2] } : {}), place: m[3] === "the sandbox" ? "sandbox" : m[3]!, state: m[4] as EndedJob["state"],
    ...(m[5] !== undefined ? { exitCode: Number(m[5]) } : {}), took: m[6]!, ...(m[7] ? { reason: m[7] } : {}), command, output,
  };
}

/** How it ended, as the head's word: "exit 0" with a green dot, a failure with a red one, a stop with none. */
function ending(j: EndedJob) {
  const word = j.state === "exited" ? <>exit <span className="mono">{j.exitCode ?? "?"}</span></> : j.state;
  const dot = j.state === "stopped" ? "" : j.state === "exited" && j.exitCode === 0 ? "up" : "down";
  return <span className="status-word"><span className={`dot ${dot}`} aria-hidden="true" />{word}</span>;
}

/**
 * The card: the head with how it ended, the job, where and how long; the command, clamped until Show more; and its
 * output, hidden until opened. Opened, it shows the job's whole kept output (`base` is the thread's API path), or the
 * notice's last lines when none was kept.
 */
export function JobNotice({ job, base }: { job: EndedJob; base: string }) {
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  // Show more shows only when the clamp cuts the command; a cut command fades at its foot, so it reads as clamped rather than broken off.
  useLayoutEffect(() => {
    if (more) return;
    const el = body.current?.querySelector<HTMLElement>(".job-command");
    if (!el) return;
    const measure = () => {
      const cut = el.scrollHeight > el.clientHeight + 1;
      el.toggleAttribute("data-cut", cut);
      setLong(cut);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [more, job.command]);
  return (
    <div className="subagent delivered job-notice" data-status="job">
      <div className="sub-head">
        <b className="as-is">{job.name ?? "Background command"}</b>
        {ending(job)}
        <span className="muted job-facts"><span className="mono">{job.id}</span> · {job.place} · <span className="mono">{job.took}</span>{job.reason && <> · {job.reason}</>}</span>
      </div>
      <div ref={body} className="job-body" data-clamped={more ? undefined : ""}>
        <pre className="job-command" aria-label="Command">{job.command}</pre>
        {job.output ? <>
          <button type="button" className="link job-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="right" className="chev-ic" />Output
          </button>
          {open && <OutputBox base={base} id={job.id} running={false} fallback={job.output} label="Output" />}
        </> : <span className="job-label">No output</span>}
      </div>
      {(long || more) && <button type="button" className="link show-more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "Show less" : "Show more"}</button>}
    </div>
  );
}
