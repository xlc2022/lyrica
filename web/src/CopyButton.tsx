// A Copy button: puts `text` on the clipboard and reads Copied for 2 s, or
// Copy failed where the browser refuses (docs/ux.md §1, §6 Code in a message).
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";

/** How long Copied (or Copy failed) stays before the label goes back. */
const RESULT_MS = 2000;

/** A Copy button shared by a message's code block and the Git webhook fields. */
export function CopyButton({ text, label, ariaLabel, className }: {
  text: string; /** What it reads before the copy. */ label: string; /** The idle accessible name when it differs from `label`. */ ariaLabel?: string;
  className?: string;
}) {
  const [state, copy] = useCopy(text);
  const shown = state === "idle" ? label : state === "copied" ? "Copied" : "Copy failed";
  const aria = state === "idle" ? (ariaLabel ?? label) : shown;
  return <button type="button" className={className ? `sm ${className}` : "sm"} aria-label={aria} onClick={() => void copy()}>{shown}</button>;
}

/** The copy and its result, which goes back to idle after `RESULT_MS`. */
function useCopy(text: string) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    // No clipboard where the page isn't secure, and a refusal where permission is denied: both read as Copy failed.
    let result: "copied" | "failed" = "copied";
    try { await navigator.clipboard.writeText(text); } catch { result = "failed"; }
    clearTimeout(timer.current);
    setState(result);
    timer.current = setTimeout(() => setState("idle"), RESULT_MS);
  };
  return [state, copy] as const;
}

/**
 * Copy as an icon button (docs/ux.md §2): the icon becomes a check and the name and tooltip Copied for 2 s, or Copy
 * failed where the browser refuses. A message's Copy (quiet, the default class) and the viewers' Copy path share it.
 */
export function CopyIconButton({ text, label = "Copy", className = "icon-btn quiet" }: { text: string; label?: string; className?: string }) {
  const [state, copy] = useCopy(text);
  const shown = state === "idle" ? label : state === "copied" ? "Copied" : "Copy failed";
  return (
    <button type="button" className={className} data-state={state} aria-label={shown} title={shown} onClick={() => void copy()}>
      <Icon name={state === "copied" ? "check" : state === "failed" ? "close" : "copy"} />
    </button>
  );
}
