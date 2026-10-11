// Writing a message: Enter sends (Shift+Enter for a new line, except on touch
// keyboards), files attach from the "+" menu, by drag or paste. The box holds
// the text and Send (Stop while she works and the box is empty); under it, a
// quiet row with "+", the mic (dictation goes in at the caret) and the
// thread's mode (Shift+Tab cycles).
import { useCallback, useEffect, useRef, useState } from "react";
import { upload, type ThreadSettings, type ThreadSettingsChange } from "./api.ts";
import { Icon } from "./icons.tsx";
import { ModePicker, nextMode, ToolsMenu } from "./Modes.tsx";
import { MicButton, stopReading, useDictation } from "./Voice.tsx";

interface Upload { id: number; name: string; progress: number; error?: string }

export function Composer({ base, busy, restored, onSend, onStop, settings, onSettings, onError }: {
  base: string; busy: boolean; onSend: (text: string) => Promise<boolean>; onStop: () => void;
  /** Text handed back, such as follow-ups that Stop dropped. */
  restored: string;
  settings?: ThreadSettings;
  onSettings: (change: ThreadSettingsChange) => void;
  /** Dictation's problems, for the conversation's error line. */
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);

  useEffect(() => { if (restored) setDraft((d) => (d ? `${restored}\n\n${d}` : restored)); }, [restored]);

  // Dictated text goes in at the caret, with a space on each side where it meets other text.
  const insert = useCallback((text: string) => {
    const el = area.current;
    const at = el ? el.selectionStart : draft.length;
    const end = el ? el.selectionEnd : at;
    setDraft((d) => {
      const before = d.slice(0, at);
      const after = d.slice(end);
      const piece = (before && !/\s$/.test(before) ? " " : "") + text + (after && !/^\s/.test(after) ? " " : "");
      const caret = before.length + piece.length;
      requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(caret, caret); });
      return before + piece + after;
    });
  }, [draft.length]);
  const mic = useDictation({ base, onText: insert, onError });

  // Grow with the text, up to the CSS max-height.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft]);

  const attach = (files: Iterable<File>) => {
    for (const file of files) {
      const id = nextId.current++;
      setUploads((u) => [...u, { id, name: file.name, progress: 0 }]);
      const update = (patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      upload(`${base}/uploads?name=${encodeURIComponent(file.name)}`, file, (progress) => update({ progress }))
        .then(({ path }) => {
          setDraft((d) => (d && !d.endsWith("\n") ? `${d}\n` : d) + path + "\n");
          setUploads((u) => u.filter((x) => x.id !== id));
          area.current?.focus();
        }, (e: Error) => update({ error: e.message }));
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || uploads.some((x) => !x.error)) return;
    stopReading();
    setDraft("");
    if (!(await onSend(text))) setDraft(text);
  };

  return (
    <form
      className="composer"
      data-dragging={dragging}
      data-has-text={!!draft.trim()}
      data-mic={mic.state}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); attach(e.dataTransfer.files); }}
    >
      <div className="composer-wrap">
        {uploads.length > 0 && (
          <ul className="uploads" aria-label="Uploads">
            {uploads.map((x) => (
              <li key={x.id}>
                <span className="name">{x.name}</span>
                {x.error
                  ? <><span className="error">{x.error}</span><button type="button" className="icon sm" aria-label={`Dismiss ${x.name}`} onClick={() => setUploads((u) => u.filter((y) => y.id !== x.id))}><Icon name="close" /></button></>
                  : <progress max={1} value={x.progress} aria-label={`Uploading ${x.name}`} />}
              </li>
            ))}
          </ul>
        )}
        <div className="composer-box">
          <textarea
            ref={area}
            rows={1}
            aria-label="Message"
            placeholder={mic.state === "recording" ? "Listening…" : busy ? "Add a follow-up" : "Message Lyrica"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); attach(e.clipboardData.files); } }}
            onKeyDown={(e) => {
              if (e.key === "Tab" && e.shiftKey && settings) { e.preventDefault(); onSettings({ mode: nextMode(settings.mode) }); return; }
              // While listening: Enter stops and transcribes, Escape throws the clip away.
              if (mic.state === "recording" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void mic.stop(); return; }
              if (mic.state !== "idle" && e.key === "Escape") { e.preventDefault(); mic.discard(); return; }
              const touch = matchMedia("(pointer: coarse)").matches;
              if (e.key === "Enter" && !e.shiftKey && !touch && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
            }}
          />
          {busy && !draft.trim()
            ? <button type="button" className="icon send" aria-label="Stop" title="Stop" onClick={onStop}><Icon name="stop" /></button>
            : <button type="submit" className="icon send" aria-label="Send" title={busy ? "Send when she finishes" : "Send"} disabled={!draft.trim()}><Icon name="up" /></button>}
        </div>
        <div className="composer-row">
          <ToolsMenu settings={settings} onAttach={() => picker.current?.click()} onChange={onSettings} />
          <input ref={picker} type="file" multiple hidden onChange={(e) => { attach(e.target.files ?? []); e.target.value = ""; }} />
          <MicButton state={mic.state} seconds={mic.seconds} speech={settings?.speech} onStart={() => void mic.start()} onStop={() => void mic.stop()} />
          <span className="spacer" />
          {settings && <ModePicker mode={settings.mode} onChange={(mode) => onSettings({ mode })} />}
        </div>
      </div>
    </form>
  );
}
