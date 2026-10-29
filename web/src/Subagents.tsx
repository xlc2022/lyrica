// A thread's subagents in one drawer (docs/ux.md §6, "A thread's subagents"), so a run whose card scrolled away is still a press away.
import { useEffect, useRef } from "react";
import type { Pool, SubagentRun, Subagents } from "./api.ts";
import { href } from "./route.ts";
import { shortModel } from "./ModelLabel.tsx";
import { tokenCount } from "./Project.tsx";
import { ErrorText, fullTime, wakeTime } from "./ui.tsx";

/** A run's state as a dot and a word (docs/ux.md §5), in the colours the thread rows use. */
const STATES: Record<SubagentRun["status"], [state: string, word: string]> = {
  running: ["working", "Working"],
  question: ["waiting", "Asking"],
  finished: ["resolved", "Done"],
  failed: ["failed", "Failed"],
  stopped: ["idle", "Stopped"],
  interrupted: ["idle", "Interrupted"],
};

export const liveRun = (r: SubagentRun) => r.status === "running" || r.status === "question";

export function SubagentsDrawer({ id, userId, pool, data, error, tasks, onClose }: {
  id: string; userId: string; pool: Pool; data?: Subagents; error: string;
  /** Each subagent thread's task, where its `delegate` card is loaded. */
  tasks: Map<string, string>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Focus moves in once, when it opens, as the settings drawer's does.
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  const runs = data?.runs ?? [];
  // Those still working or asking first, then the rest; newest first within each, as the daemon lists them.
  const ordered = [...runs.filter(liveRun), ...runs.filter((r) => !liveRun(r))];
  const working = runs.filter(liveRun).length;
  const tokens = data ? data.usage.inputTokens + data.usage.outputTokens : 0;
  return (
    <aside id={id} ref={ref} tabIndex={-1} className="drawer subagents-drawer" aria-label="Subagents">
      <div className="drawer-head">
        <h2>Subagents</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <div className="drawer-body">
        <ErrorText error={error} />
        {data && (
          <p className="sub-facts">
            <span className="num">{runs.length}</span> {runs.length === 1 ? "subagent" : "subagents"} · <span className="num">{working}</span> working · <span className="num">{tokenCount(tokens)}</span> tokens
          </p>
        )}
        {data && !runs.length && <p className="muted">No subagents yet.</p>}
        {!!ordered.length && (
          <ul className="sub-list">
            {ordered.map((r) => {
              const [state, word] = STATES[r.status];
              // Without a title of its own, a subagent's title is its task's first line: the task line would only repeat it.
              const task = tasks.get(r.thread);
              const taskLine = task && !(r.title && task.startsWith(r.title)) ? task : undefined;
              // The subagent opens beside the conversation from 1180 px up (the shell's links do that), so the drawer steps aside.
              return (
                <li key={r.thread}>
                  <a className="sub-row" href={href({ page: "thread", userId, pool, threadId: r.thread })} onClick={onClose}>
                    <span className="status" data-state={state} aria-hidden="true" />
                    <span className="sub-name" title={r.title || undefined}><b className="role">{r.role}</b>{r.title && <> – {r.title}</>}</span>
                    <span className="tstate" data-state={state}>{word}</span>
                    {taskLine && <span className="task" title={taskLine}>{taskLine}</span>}
                    <span className="sub-facts">
                      <span className="num" title={r.model}>{shortModel(r.model)}</span> · <span className="num" title={fullTime(r.startedAt)}>{wakeTime(r.startedAt)}</span> · <span className="num">{tokenCount(r.inputTokens + r.outputTokens)}</span> tokens
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
