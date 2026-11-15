// A background command that ended, as its notice in the conversation (docs/ux.md, "A background command that ended";
// docs/workspace.md, "Background commands"). The notice is the text she was told (core's `jobNotice`); this reads it
// back into its parts, so the command and its output keep their lines in blocks of their own.
import { useLayoutEffect, useRef, useState } from "react";

export interface EndedJob {
  id: string;
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

const HEAD = /^Background command (j\d+) in (the sandbox|.+?), (exited|failed|timed out|stopped)(?: with code (-?\d+))? after (\d+ s|\d+ min|\d+ h \d+ min)(?: \((.*?)\))?: /;
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
    id: m[1]!, place: m[2] === "the sandbox" ? "sandbox" : m[2]!, state: m[3] as EndedJob["state"],
    ...(m[4] !== undefined ? { exitCode: Number(m[4]) } : {}), took: m[5]!, ...(m[6] ? { reason: m[6] } : {}), command, output,
  };
}

/** How it ended, as the head's word: "exit 0" with a green dot, a failure with a red one, a stop with none. */
function ending(j: EndedJob) {
  const word = j.state === "exited" ? `exit ${j.exitCode ?? "?"}` : j.state;
  const dot = j.state === "stopped" ? "" : j.state === "exited" && j.exitCode === 0 ? "up" : "down";
  return <span className="status-word"><span className={`dot ${dot}`} aria-hidden="true" />{word}</span>;
}

/** The card: the head with how it ended, the job, where and how long; the command and its last output in blocks that keep their lines, clamped until Show more. */
export function JobNotice({ job }: { job: EndedJob }) {
  const [more, setMore] = useState(false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  // Show more shows only when a clamp hides something.
  useLayoutEffect(() => {
    if (more) return;
    // A cut block fades at its foot, so it reads as clamped rather than broken off mid-line.
    const pres = [...(body.current?.querySelectorAll("pre") ?? [])];
    for (const el of pres) el.toggleAttribute("data-cut", el.scrollHeight > el.clientHeight + 1);
    setLong(pres.some((el) => el.hasAttribute("data-cut")));
  }, [more, job.command, job.output]);
  return (
    <div className="subagent delivered job-notice" data-status="job">
      <div className="sub-head">
        <b className="as-is">Background command</b>
        {ending(job)}
        <span className="muted job-facts"><span className="mono">{job.id}</span> · {job.place} · {job.took}{job.reason && <> · {job.reason}</>}</span>
      </div>
      <div ref={body} className="job-body" data-clamped={more ? undefined : ""}>
        <pre className="job-command" aria-label="Command">{job.command}</pre>
        {job.output ? <>
          <span className="job-label">Last output</span>
          <pre className="job-output" aria-label="Last output">{job.output}</pre>
        </> : <span className="job-label">No output</span>}
      </div>
      {(long || more) && <button type="button" className="link show-more" onClick={() => setMore(!more)}>{more ? "Show less" : "Show more"}</button>}
    </div>
  );
}
