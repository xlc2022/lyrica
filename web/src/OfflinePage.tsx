// A source read from the offline copy of Wikipedia, opened in the app (docs/ux.md §6, The pages she read for a reply):
// the article as lyricad reads it from kiwix-serve (`…/web/page`, daemon/src/api.ts OfflinePage), in a dialog the
// size of the file viewer, its pictures through lyricad as in her messages. Nothing is fetched online.
import { useEffect, useRef, useState } from "react";
import { get, HttpError, u, type OfflinePage as Page } from "./api.ts";
import { Icon } from "./icons.tsx";
import { useFileLinks } from "./paths.tsx";
import { ErrorText, Prose } from "./ui.tsx";
import type { Env } from "./Messages.tsx";

/** "the offline copy of Wikipedia (2026-08)" as the facts line shows it: "Offline Wikipedia" and the date, "2026-08". */
export function copyFacts(copy: string): { name: string; date?: string } {
  const m = /^the offline copy of (.+?)(?: \((\d{4}-\d{2})\))?$/.exec(copy);
  return m ? { name: `Offline ${m[1]}`, ...(m[2] ? { date: m[2] } : {}) } : { name: copy };
}

/** The facts line: the copy, then its date in mono. */
function Facts({ copy }: { copy: string }) {
  const { name, date } = copyFacts(copy);
  return <>{name}{date && <> · <span className="num">{date}</span></>}</>;
}

/** The article's Markdown without the URL line web_fetch puts under its title. */
export function articleText(text: string): string {
  const lines = text.split("\n");
  return lines[0]?.startsWith("# ") && /^https?:\/\//.test(lines[1] ?? "") ? [lines[0], ...lines.slice(2)].join("\n") : text;
}

export function OfflinePage({ url, title, online, env, onClose }: { url: string; title: string; /** Its host when the browser can open it, for a link to the page online. */ online?: string; env: Pick<Env, "userId" | "pool" | "threadId" | "large">; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const files = useFileLinks(env.userId, env.pool, env.threadId);
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState("");
  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); return () => el?.close(); }, []);
  useEffect(() => {
    let live = true;
    get<Page>(`${u(env.userId, "web", "page")}?url=${encodeURIComponent(url)}`).then(
      (p) => { if (live) setPage(p); },
      (e: Error) => { if (live) setError(e instanceof HttpError && e.status === 404 ? "The offline copy doesn't have this page any more." : e.message); },
    );
    return () => { live = false; };
  }, [env.userId, url]);
  return (
    <dialog ref={ref} className="viewer" aria-label={title} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <section className="viewer-file" aria-label={title}>
        <div className="viewer-head">
          <span className="fname" title={url}>{title}</span>
          <span className="viewer-facts muted">{page ? <Facts copy={page.copy} /> : "Offline copy"}</span>
          <span className="viewer-acts">
            {online && <a className="mono sm" href={url} target="_blank" rel="noopener noreferrer" title={`Online: ${url}`}>{online}</a>}
            <button type="button" className="icon sm" aria-label="Close" title="Close" onClick={onClose}><Icon name="close" /></button>
          </span>
        </div>
        <div className="viewer-body viewer-scroll">
          {!page && !error && <p className="empty">Loading…</p>}
          <ErrorText error={error} />
          {page && <div className="viewer-prose prose"><Prose text={articleText(page.text)} files={files} onLarge={(p) => env.large(p, files)} /></div>}
        </div>
      </section>
    </dialog>
  );
}
