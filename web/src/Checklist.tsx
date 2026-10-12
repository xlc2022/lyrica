// Her checklist for a thread (`threads steps`, docs/ux.md §6): "Checklist 2 of 5 ▾" in the thread header's facts
// line, "2 of 5" and the current step on a thread's card, and the one popover both open.
import { useCallback, useRef, useState } from "react";
import type { ThreadStep } from "./api.ts";
import { useDismiss } from "./ui.tsx";

/** How far a checklist is: the steps done, how many there are, and the current step (the doing one, else the first to do; none once all are done). */
export function checklistOf(steps: readonly ThreadStep[]): { done: number; total: number; current?: ThreadStep } {
  const current = steps.find((s) => s.state === "doing") ?? steps.find((s) => s.state === "todo");
  return { done: steps.filter((s) => s.state === "done").length, total: steps.length, ...(current ? { current } : {}) };
}

const MARKS: Record<ThreadStep["state"], string> = { done: "✓", doing: "✱", todo: "○" };
const WORDS: Record<ThreadStep["state"], string> = { done: "Done", doing: "Doing", todo: "To do" };

/** A step's mark in mono; screen readers read its word (WORDS) instead. */
function Mark({ state }: { state: ThreadStep["state"] }) {
  return <span className="step-mark" aria-hidden="true">{MARKS[state]}</span>;
}

/**
 * The count that opens the checklist: "Checklist 2 of 5 ▾" in the facts line, or "2 of 5" after a card's state
 * word. Shown only while the thread has steps.
 */
export function ChecklistButton({ steps, card }: { steps: readonly ThreadStep[]; card?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  const { done, total } = checklistOf(steps);
  const count = <><span className="num">{done}</span> of <span className="num">{total}</span></>;
  return (
    <span className={card ? "picker-anchor tcard-count" : "picker-anchor"} ref={anchor}>
      {card ? (
        <button type="button" className="link" aria-label={`Checklist, ${done} of ${total} steps done`} title="Checklist" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
          {count}
        </button>
      ) : (
        <button type="button" className="link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
          Checklist {count} <span className="caret" aria-hidden="true">▾</span>
        </button>
      )}
      {open && (
        <div className="picker checklist-pop" role="dialog" aria-label="Checklist">
          <ol className="checklist">
            {steps.map((s, i) => (
              <li key={i} data-state={s.state}>
                <Mark state={s.state} />
                <span><span className="sr-only">{WORDS[s.state]} </span>{s.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </span>
  );
}

/** A card's first line: the step under way, or the first to do. None once all are done; the caller leaves it off a resolved thread. */
export function StepLine({ steps }: { steps: readonly ThreadStep[] }) {
  const { current } = checklistOf(steps);
  if (!current) return null;
  return <p className="tcard-step"><Mark state={current.state} /><span className="sr-only">{WORDS[current.state]} </span>{current.text}</p>;
}
