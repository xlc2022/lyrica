// Writing a message: Enter sends (Shift+Enter for a new line, except on touch
// keyboards), files attach by button, drag or paste.
import { useEffect, useRef, useState } from "react";
import { upload } from "./api.ts";

interface Upload { id: number; name: string; progress: number; error?: string }

export function Composer({ base, busy, placeholder, restored, onSend, onStop }: {
  base: string; busy: boolean; onSend: (text: string) => Promise<boolean>; onStop: () => void;
  /** What the empty composer says when no turn runs. */
  placeholder: string;
  /** Text handed back, such as follow-ups that Stop dropped. */
  restored: string;
}) {
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);

  useEffect(() => { if (restored) setDraft((d) => (d ? `${restored}\n\n${d}` : restored)); }, [restored]);

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
    setDraft("");
    if (!(await onSend(text))) setDraft(text);
  };

  return (
    <form
      className="composer"
      data-dragging={dragging}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); attach(e.dataTransfer.files); }}
    >
      {uploads.length > 0 && (
        <ul className="uploads" aria-label="Uploads">
          {uploads.map((x) => (
            <li key={x.id}>
              <span className="name">{x.name}</span>
              {x.error
                ? <><span className="error">{x.error}</span><button type="button" className="quiet" aria-label={`Dismiss ${x.name}`} onClick={() => setUploads((u) => u.filter((y) => y.id !== x.id))}>✕</button></>
                : <progress max={1} value={x.progress} aria-label={`Uploading ${x.name}`} />}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="attach" aria-label="Attach a file" onClick={() => picker.current?.click()}>+</button>
      <input ref={picker} type="file" multiple hidden onChange={(e) => { attach(e.target.files ?? []); e.target.value = ""; }} />
      <textarea
        ref={area}
        rows={1}
        aria-label="Message"
        placeholder={busy ? "Add a follow-up" : placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); attach(e.clipboardData.files); } }}
        onKeyDown={(e) => {
          const touch = matchMedia("(pointer: coarse)").matches;
          if (e.key === "Enter" && !e.shiftKey && !touch && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
        }}
      />
      {busy && <button type="button" className="stop" onClick={onStop}>Stop</button>}
      <button type="submit" className="primary send" disabled={!draft.trim()}>{busy ? "Queue" : "Send"}</button>
    </form>
  );
}
