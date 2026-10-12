// Writing a message: Enter sends (Shift+Enter for a new line, except on touch
// keyboards), files attach from the "+" menu, by drag or paste. The box holds
// the text and Send (Stop while she works and the box is empty); under it, a
// quiet row with "+", the mic (dictation goes in at the caret) and the
// thread's mode (Shift+Tab cycles). The unsent text is kept on lyricad, one
// draft per thread, never in the browser.
import { useCallback, useEffect, useRef, useState } from "react";
import { draft as loadDraft, saveDraft, upload, type ThreadSettings, type ThreadSettingsChange } from "./api.ts";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { ATTACH_EVENT, ATTACH_KEY, EDIT_IMAGE_EVENT, take, type AttachRequest, type EditImageRequest } from "./links.ts";
import { ModePicker, nextMode, ToolsMenu, type GrantedMachine } from "./Modes.tsx";
import { MicButton, stopReading, useDictation } from "./Voice.tsx";

interface Upload { id: number; name: string; progress: number; error?: string }

export function Composer({ base, busy, restored, onSend, onStop, settings, machines, onSettings, onError }: {
  base: string; busy: boolean; onSend: (text: string) => Promise<boolean>; onStop: () => void;
  /** Text handed back, such as follow-ups that Stop dropped. */
  restored: string;
  settings?: ThreadSettings;
  /** The thread's granted machines with their limits, for the mode menu. */
  machines?: GrantedMachine[];
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

  // The draft on lyricad: loaded once per thread, filling the box only if nothing is in it yet; saved a
  // second after typing stops, on blur and on leaving. `known` is the text lyricad holds for `base` (unknown
  // until loaded), so the same text is never saved twice; a pending save carries its own base, so one
  // thread's text never lands in another.
  const known = useRef<{ base: string; text?: string }>({ base });
  const pending = useRef<{ base: string; text: string; timer: number } | undefined>(undefined);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const typed = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const report = useRef(onError);
  report.current = onError;

  const write = useCallback((b: string, text: string, keepalive = false) => {
    const k = known.current;
    const ours = k.base === b;
    if (ours && k.text === text) return;
    const before = ours ? k.text : undefined;
    if (ours) k.text = text;
    const failed = (e: Error) => {
      if (known.current.base === b && known.current.text === text) known.current.text = before;
      report.current(e.message);
    };
    // Leaving the page can't wait for an earlier save; otherwise saves go in order. Browsers cap a keepalive
    // body at 64 KB, so a draft near the limit may not save on leaving; the blur and timed saves still have it.
    if (keepalive) void saveDraft(b, text, true).catch(failed);
    else saving.current = saving.current.then(() => saveDraft(b, text)).catch(failed);
  }, []);
  const cancel = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = undefined;
  };
  const flush = useCallback((keepalive = false) => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = undefined;
    write(p.base, p.text, keepalive);
  }, [write]);

  useEffect(() => {
    let live = true;
    known.current = { base };
    typed.current = false;
    setLoaded(false);
    loadDraft(base).then((d) => {
      if (!live) return;
      known.current = { base, text: d.text };
      if (d.text) setDraft((cur) => (typed.current || cur ? cur : d.text));
      setLoaded(true);
    }, () => { if (live) setLoaded(true); });
    const leave = () => flush(true);
    addEventListener("pagehide", leave);
    return () => { live = false; removeEventListener("pagehide", leave); flush(); };
  }, [base, flush]);

  useEffect(() => {
    if (!loaded) return;
    const k = known.current.text;
    if (k === undefined ? !draft : draft === k) { cancel(); return; }
    cancel();
    pending.current = { base, text: draft, timer: window.setTimeout(() => flush(), 1000) };
  }, [draft, loaded, base, flush]);

  // Attach from the Files panel: its paths go in on their own lines, as an upload's does. Chosen on the
  // Files page on a phone, they wait in session storage for this thread's box.
  const addPaths = useCallback((paths: string[]) => {
    setDraft((d) => (d && !d.endsWith("\n") ? `${d}\n` : d) + paths.map((p) => `${p}\n`).join(""));
    area.current?.focus();
  }, []);
  useEffect(() => {
    const on = (e: Event) => {
      const { detail } = e as CustomEvent<AttachRequest>;
      if (detail.base !== base) return;
      detail.handled = true;
      addPaths(detail.paths);
    };
    addEventListener(ATTACH_EVENT, on);
    const kept = take<AttachRequest>(ATTACH_KEY, base);
    if (kept) addPaths(kept.paths);
    return () => removeEventListener(ATTACH_EVENT, on);
  }, [base, addPaths]);

  useEffect(() => {
    const on = (e: Event) => {
      const { detail } = e as CustomEvent<EditImageRequest>;
      if (detail.base !== base) return;
      detail.handled = true;
      typed.current = true;
      setDraft((d) => d.trim() ? `${d.replace(/\s+$/, "")}\nEdit ${detail.path}: ` : `Edit ${detail.path}: `);
      onSettings({ images: true });
      area.current?.focus();
    };
    addEventListener(EDIT_IMAGE_EVENT, on);
    return () => removeEventListener(EDIT_IMAGE_EVENT, on);
  }, [base, onSettings]);

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
    // A send clears lyricad's draft, so nothing pending goes; a refused one keeps it, and the text comes back.
    cancel();
    const k = known.current;
    const before = k.text;
    k.text = "";
    setDraft("");
    await saving.current; // an earlier save lands before the send clears it
    if (!(await onSend(text))) {
      if (k.text === "") k.text = before;
      setDraft(text);
    }
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
            placeholder={mic.state === "recording" ? "Listening…" : busy ? "Add a follow-up" : `Message ${her()}`}
            value={draft}
            onChange={(e) => { typed.current = true; setDraft(e.target.value); }}
            onBlur={() => flush()}
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
          {settings && <ModePicker mode={settings.mode} machines={machines} onChange={(mode) => onSettings({ mode })} />}
        </div>
      </div>
    </form>
  );
}
