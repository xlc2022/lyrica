// The Models area's frame and what its tabs share (src/Models.tsx, src/TextModels.tsx, src/ImageModels.tsx,
// src/Downloads.tsx): the page with its tabs at the left, the area's context, the words for tasks, presets and uses,
// and a speaking model's Settings drawer.
import { useEffect, useRef, useState } from "react";
import { get, put, u, type CallInfo, type HostStatus, type ModelsPage, type ModelUse, type OfferingInfo, type OfferingSettings, type Task } from "./api.ts";
import { href, type ModelsTab } from "./route.ts";
import { PageHead, type ShellContext } from "./Shell.tsx";
import { findThread } from "./Thread.tsx";
import { ErrorText, useAction, useLoad } from "./ui.tsx";

export interface ModelsState {
  page?: ModelsPage;
  error: string;
  reload: () => void;
  set: (p: ModelsPage) => void;
}

/** The shell's context with the Models page's data, for everything inside the area. */
export type MCtx = ShellContext & { models: ModelsState };

export type Host = { status: HostStatus } | { error: string; unpaired?: true };

const TABS: { tab: ModelsTab; label: string }[] = [
  { tab: "overview", label: "Overview" },
  { tab: "tasks", label: "Tasks" },
  { tab: "text", label: "Text models" },
  { tab: "images", label: "Image models" },
  { tab: "hosts", label: "Hosts and endpoints" },
  { tab: "downloads", label: "Downloads" },
  { tab: "cleanup", label: "Clean up" },
  { tab: "calls", label: "Recent calls" },
];

export const TASK_WORD: Record<Task, string> = {
  chat: "Chat", "subagent.cheap": "Cheap subagents", "subagent.strong": "Strong subagents", compaction: "Compaction",
  title: "Titles", watching: "Watching threads", embedding: "Embeddings", "sleep.consolidate": "Sleep: consolidate", "sleep.dream": "Sleep: dream", "sleep.wake": "Sleep: wake",
  "image.create": "Images", "image.edit": "Image edits", "image.upscale": "Image upscaling", "speech.transcribe": "Dictation", "speech.speak": "Read aloud",
};

export const GB = 2 ** 30;
export const gb = (bytes: number) => (bytes / GB).toFixed(1);
export const plural = (n: number, one: string, many: string) => <><span className="num">{n}</span> {n === 1 ? one : many}</>;
export const canEdit = (ctx: ShellContext, ep: { shared: boolean }) => !ep.shared || ctx.user.admin;

export const Kind = ({ kind }: { kind: "local" | "cloud" }) => <span className={`kind ${kind}`}>{kind}</span>;

export const hostOf = (p: ModelsPage, endpointId: string): Host | undefined => p.hosts.find((h) => h.endpointId === endpointId);

/** The downloads running on the hosts, as their status last said. */
export const runningOnHosts = (p?: ModelsPage) => (p?.hosts ?? []).reduce((n, h) => n + ("status" in h ? h.status.downloads.active : 0), 0);

/**
 * The page: its header, the tabs at the left, and the tab's content. Downloads has a count while anything runs: the
 * hosts' own, or `running` from the Downloads tab, which watches them closer.
 */
export function Frame({ ctx, tab, title, facts, actions, running, children }: {
  ctx: MCtx; tab: ModelsTab; title: string; facts?: React.ReactNode; actions?: React.ReactNode; running?: number; children: React.ReactNode;
}) {
  const userId = ctx.user.id;
  const cleanup = ctx.cleanup.count;
  const downloads = running ?? runningOnHosts(ctx.models.page);
  return (
    <main className="main">
      <PageHead ctx={ctx} title={title} facts={facts}>{actions && <div className="head-actions models-actions">{actions}</div>}</PageHead>
      <div className="page-body">
        <nav className="subnav" aria-label="Models pages">
          {TABS.map((t) => (
            <a key={t.tab} href={href({ page: "models", userId, tab: t.tab })} aria-current={t.tab === tab ? "page" : undefined} data-tab={t.tab}>
              {t.label}{t.tab === "cleanup" && cleanup > 0 && <span className="count" aria-label={`${cleanup} to clean up`}>{cleanup}</span>}
              {t.tab === "downloads" && downloads > 0 && <span className="count" aria-label={`${downloads} running`}>{downloads}</span>}
            </a>
          ))}
        </nav>
        <div className="content models" data-tab={tab}>{children}</div>
      </div>
    </main>
  );
}

/** Where a model is used, in words: a preset, a column, a thread's title, a workflow or a group. */
export function useWords(ctx: MCtx) {
  const thread = (pool: CallInfo["pool"], id: string) => findThread(ctx.threads, pool, id);
  const use = (w: ModelUse): string => {
    if (w.where === "preset") return `the ${w.name} preset (${TASK_WORD[w.task]})`;
    if (w.where === "column") return `the ${w.column === "private" ? "Private" : "General"} column (${TASK_WORD[w.task]})`;
    if (w.where === "thread") return `${thread(w.pool, w.threadId)?.title || "a thread"} (${TASK_WORD[w.task]})`;
    if (w.where === "workflow") return `the workflow ${w.name}`;
    return `the group ${w.name}`;
  };
  return { thread, use };
}

/** Where a model is used, as the dialog that deletes it says: "Used in …. Those lists skip it from now on." */
export function UsedIn({ ctx, usedIn, more = "" }: { ctx: MCtx; usedIn: ModelUse[]; more?: string }) {
  const words = useWords(ctx);
  return usedIn.length ? <p>Used in {usedIn.map(words.use).join(", ")}. Those lists skip it from now on{more}.</p> : <p className="muted">Nothing of yours uses it.</p>;
}

/* ---- A speaking model's Settings drawer (from an endpoint's models in Hosts and endpoints, and from Text models) ---- */

const LANGUAGES: Record<string, string> = { en: "English", zh: "Mandarin" };
const MAX_SPEED = 4;
const MIN_SPEED = 0.25;

/** A speech model's Settings drawer: its voice per language and its speed, yours over the shared ones. */
export function VoiceDrawer({ userId, model, onClose }: { userId: string; model: OfferingInfo; onClose: () => void }) {
  const path = u(userId, "offerings", model.id, "settings");
  const settings = useLoad(() => get<OfferingSettings>(path), [path]);
  const [run, busy, error] = useAction();
  const [speed, setSpeed] = useState<string>();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const voices = model.speak?.voices ?? [];
  const languages = [...new Set(voices.map((v) => v.language))];
  const s = settings.data;
  const save = (values: { voices?: Record<string, string> | null; speed?: number | null }) => run(async () => settings.set(await put<OfferingSettings>(path, { values })));
  const source = (k: "voices" | "speed") => s?.sources[k] && <span className="muted meta source"> {s.sources[k]}</span>;
  // The field clamps to its range when it is left; empty goes back to the default.
  const commitSpeed = () => {
    if (speed === undefined) return;
    const n = Number(speed);
    setSpeed(undefined);
    if (speed.trim() === "") { if (s?.values.speed !== undefined) void save({ speed: null }); return; }
    if (!Number.isFinite(n)) return;
    void save({ speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, n)) });
  };
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" aria-label={`${model.modelId} settings`}>
      <div className="drawer-head">
        <h2>{model.modelId}</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <div className="drawer-body">
        <ErrorText error={settings.error || error} />
        <fieldset className="group" disabled={!s || busy}>
          <legend>Voice{source("voices")}</legend>
          {languages.map((lang) => (
            <label key={lang} className="field"><span>{LANGUAGES[lang] ?? lang}</span>
              <select value={s?.values.voices?.[lang] ?? ""} onChange={(e) => save({ voices: { ...s?.values.voices, [lang]: e.target.value } })}>
                {!s?.values.voices?.[lang] && <option value="">Default</option>}
                {voices.filter((v) => v.language === lang).map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}
              </select>
            </label>
          ))}
          {s?.sources.voices === "yours" && <button type="button" className="link sm" onClick={() => save({ voices: null })}>Reset</button>}
        </fieldset>
        <fieldset className="group" disabled={!s || busy}>
          <legend>Speed{source("speed")}</legend>
          <div className="field">
            <span className="unit-field">
              <input type="number" inputMode="decimal" min={MIN_SPEED} max={MAX_SPEED} step={0.05} placeholder="1" aria-label="Speed"
                value={speed ?? s?.values.speed ?? ""} onChange={(e) => setSpeed(e.target.value)} onBlur={commitSpeed}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitSpeed(); } }} />
              <span className="muted meta">of {MAX_SPEED}</span>
            </span>
          </div>
          {s?.sources.speed === "yours" && <button type="button" className="link sm" onClick={() => save({ speed: null })}>Reset</button>}
        </fieldset>
      </div>
    </aside>
  );
}
