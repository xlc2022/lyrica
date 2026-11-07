// Custom ComfyUI workflows (docs/ux.md §6, "Image models, recipes and parts"; host/API.md, "Custom workflows"):
// Download image model's Workflow source imports a ComfyUI Export (API) file, and Edit workflow shows the draft or a
// saved workflow as a form, as a graph (WorkflowGraph.tsx), as JSON, and by its revisions. Every call goes through the host's manage route, which on
// a shared host is for administrators; the host checks each save.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { post, u } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Frame, type MCtx } from "./ModelsFrame.tsx";
import { her } from "./name.ts";
import { go, href } from "./route.ts";
import { clock, dateText, dayNumber, Dialog, ErrorText, useAction, useLoad } from "./ui.tsx";

export type WorkflowDoes = "create" | "edit" | "video" | "animate";
const DOES: [WorkflowDoes, string][] = [["create", "Create"], ["edit", "Edit"], ["video", "Video"], ["animate", "Animate"]];
const DOES_WORD: Record<string, string> = { create: "generate", edit: "edit", video: "video", animate: "animate", upscale: "upscale", motion: "motion", extend: "extend" };

const SIZE = ["width", "height"];
const SAMPLING = ["seed", "steps", "cfg", "sampler", "scheduler", "shift", "guidance"];
const REFERENCES = ["reference1", "reference2", "reference3", "reference4"];
/** The blanks a job fills for each action, as the host has them (host/src/workflows.ts). */
const BLANKS: Record<string, string[]> = {
  create: ["prompt", "negativePrompt", ...SIZE, "count", ...SAMPLING],
  edit: ["prompt", "negativePrompt", ...SIZE, "count", ...SAMPLING, "image", ...REFERENCES],
  video: ["prompt", "negativePrompt", ...SIZE, ...SAMPLING, "frames", "fps"],
  animate: ["prompt", "negativePrompt", ...SIZE, ...SAMPLING, "frames", "fps", "image"],
};
export const BLANK_WORD: Record<string, string> = {
  prompt: "Prompt", negativePrompt: "Negative prompt", width: "Width", height: "Height", count: "Count", seed: "Seed", steps: "Steps", cfg: "CFG",
  sampler: "Sampler", scheduler: "Scheduler", shift: "Shift", guidance: "Guidance", image: "Image", frames: "Frames", fps: "Frame rate",
  reference1: "Reference 1", reference2: "Reference 2", reference3: "Reference 3", reference4: "Reference 4", model: "Model", clip: "Text encoder", vae: "VAE",
};
const TEXT_BLANKS = new Set(["prompt", "negativePrompt", "sampler", "scheduler", "image", ...REFERENCES]);

export type Value = string | number | boolean | null | unknown[] | { $pick: unknown[] };
export interface WNode { class_type: string; inputs: Record<string, Value>; _if?: string | string[]; _unless?: string }
export type Graph = Record<string, WNode>;
/** This host's ComfyUI node types, as it last reported them (host/API.md, "Custom workflows"). */
export type NodeTypes = Record<string, {
  inputs: Record<string, unknown>; output: boolean; outputs?: string[]; outputNames?: string[]; category?: string; defaults?: Record<string, string | number | boolean>;
}>;
type Layout = Record<string, [number, number]>;
const WorkflowGraph = lazy(() => import("./WorkflowGraph.tsx"));
const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches;
interface VideoSpec { fps: number; frameStep: number; frameOffset: number; sizeStep: number; maxSeconds: number; audio: boolean }
interface Draft {
  label: string; does: WorkflowDoes; arch: string; workflow: Graph; loaders: "template" | null; clipType: string | null; video: VideoSpec | null;
  parts: unknown[]; loras: unknown[]; defaults: Record<string, string | number>; unmatched: string[]; dropped: string[];
}
interface Info {
  name: string; label: string; from: "import" | "copy"; base: string | null; revision: number; saved: string; by: "app" | "lyrica"; does: string[];
  video: VideoSpec | null; recipes: { id: string; name: string }[]; nodesChecked: boolean; workflow: Graph; problems: string[]; missingNodes: string[] | null;
  nodes: Record<string, Record<string, unknown>> | null; layout: Layout | null;
}
interface Revision { revision: number; saved: string | null; by: "app" | "lyrica"; name: string }

/** An import's draft, until it is saved or left: only in this page's memory, never stored. */
let pending: { hostId: string; draft: Draft; problems: string[]; missingNodes: string[] | null } | null = null;

const manage = <T,>(userId: string, hostId: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown) =>
  post<T>(u(userId, "hosts", hostId, "manage"), { method, path, ...(body !== undefined ? { body } : {}) });

export const isLink = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
export const blankOf = (v: unknown) => (typeof v === "string" && v.startsWith("$") ? v.slice(1) : null);

/** Where nodes go when the workflow has no layout yet: in columns by how far each is from the graph's start. */
export function autoLayoutOf(graph: Graph): Layout {
  const depth: Record<string, number> = {};
  const seen = new Set<string>();
  const of = (id: string): number => {
    if (id in depth) return depth[id]!;
    if (seen.has(id) || !graph[id]) return 0;
    seen.add(id);
    const from = Object.values(graph[id]!.inputs).filter(isLink).map((v) => of(v[0]) + 1);
    return (depth[id] = Math.max(0, ...from));
  };
  const columns: string[][] = [];
  for (const id of Object.keys(graph).sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b))) (columns[of(id)] ??= []).push(id);
  const out: Layout = {};
  columns.forEach((ids, x) => {
    let y = 0;
    for (const id of ids) {
      out[id] = [x * 320, y];
      // A node's height: its title, then a row per output and per input.
      const outs = Object.values(graph).some((m) => Object.values(m.inputs).some((v) => isLink(v) && v[0] === id)) ? 1 : 0;
      y += 80 + 24 * (Object.keys(graph[id]!.inputs).length + outs);
    }
  });
  return out;
}

/** The text Copy request puts on the clipboard: what to give Lyrica, or a pull request, to add the nodes. */
export const nodeRequest = (label: string, nodes: string[]) =>
  `Please add these ComfyUI custom nodes to the model host's ComfyUI image (host/comfyui/Dockerfile), each pinned to a reviewed commit: ${nodes.join(", ")}. The custom workflow "${label}" needs them.`;

/** Download image model's Workflow source: a name, what it does, and the export, pasted or chosen. */
export function WorkflowImport({ ctx, hostId, onCancel }: { ctx: MCtx; hostId: string; onCancel: () => void }) {
  const userId = ctx.user.id;
  const [name, setName] = useState("");
  const [does, setDoes] = useState<WorkflowDoes>("create");
  const [text, setText] = useState("");
  const [problem, setProblem] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const [run, busy, error] = useAction();
  const choose = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { setProblem("That file is larger than 2 MB."); return; }
    setText(await f.text());
    if (!name.trim()) setName(f.name.replace(/\.json$/i, "").replace(/[_-]+/g, " "));
    setProblem("");
  };
  const submit = () => {
    let workflow: unknown;
    try { workflow = JSON.parse(text); } catch { setProblem(text.trim() ? "That isn't JSON. In ComfyUI, use Export (API)." : "Paste the workflow or choose its file."); return; }
    if (!name.trim()) { setProblem("Give it a name."); return; }
    setProblem("");
    void run(async () => {
      const r = await manage<{ draft: Draft; problems: string[]; missingNodes: string[] | null }>(userId, hostId, "POST", "/host/v1/workflows/import", { workflow, name: name.trim(), does });
      pending = { hostId, ...r };
      go({ page: "models", userId, tab: "images", add: "workflow", host: hostId });
    });
  };
  return <>
    <label className="field"><span>Name</span><input value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setProblem(""); }} /></label>
    <div className="field">
      <span id="wf-does">Does</span>
      <div className="seg" role="group" aria-labelledby="wf-does">
        {DOES.map(([d, word]) => <button key={d} type="button" aria-pressed={does === d} onClick={() => setDoes(d)}>{word}</button>)}
      </div>
    </div>
    <label className="field">
      <span>Workflow</span>
      <textarea className="mono wf-json" aria-label="Workflow" rows={8} value={text} spellCheck={false} autoComplete="off" placeholder="ComfyUI's Export (API) file"
        onChange={(e) => { setText(e.target.value); setProblem(""); }} />
    </label>
    <div className="row wf-choose">
      <button type="button" className="sm" onClick={() => picker.current?.click()}>Choose file…</button>
    </div>
    <input ref={picker} type="file" hidden aria-label="Workflow file" accept=".json,application/json" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
    <ErrorText error={problem || error} />
    <div className="row">
      <button type="button" className="primary" disabled={busy} onClick={submit}>Import</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </>;
}

/** A number field: typed, its most shown, clamped when left. */
function Num({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="field wf-num">
      <span>{label}</span>
      <span className="steps-in">
        <input type="number" inputMode="numeric" min={min} max={max} value={text} onChange={(e) => setText(e.target.value)}
          onBlur={() => { const n = Math.round(Number(text)); const c = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value; setText(String(c)); onChange(c); }} />
        <span className="muted">of <span className="num">{max}</span></span>
      </span>
    </label>
  );
}

/** One scalar input: Fixed with its value, or a blank the job fills. */
export function InputRow({ id, k, v, blanks, options, onChange }: { id: string; k: string; v: Value; blanks: string[]; options?: unknown; onChange: (v: Value) => void }) {
  const blank = blankOf(v);
  const choices = blank && !blanks.includes(blank) ? [blank, ...blanks] : blanks;
  const name = `${k} of node ${id}`;
  const fixed = () => {
    if (typeof v === "boolean") return <input type="checkbox" aria-label={name} checked={v} onChange={(e) => onChange(e.target.checked)} />;
    if (typeof v === "number") return <input type="number" step="any" aria-label={name} className="mono" value={v} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />;
    const list = Array.isArray(options) ? (options as string[]) : null;
    if (list && list.length) {
      const all = list.includes(String(v ?? "")) ? list : [String(v ?? ""), ...list];
      return <select aria-label={name} value={String(v ?? "")} onChange={(e) => onChange(e.target.value)}>{all.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
    }
    const s = String(v ?? "");
    return s.length > 60 || s.includes("\n")
      ? <textarea aria-label={name} rows={3} value={s} onChange={(e) => onChange(e.target.value)} />
      : <input aria-label={name} className={/\.(safetensors|gguf|ckpt|pt|pth|bin|sft|onnx)$/i.test(s) ? "mono" : undefined} value={s} onChange={(e) => onChange(e.target.value)} />;
  };
  return (
    <div className="wf-input">
      <span className="mono wf-key">{k}</span>
      <select aria-label={`How ${name} is set`} value={blank ?? ""} onChange={(e) => {
        const b = e.target.value;
        onChange(b ? `$${b}` : TEXT_BLANKS.has(blank ?? "") ? "" : 0);
      }}>
        <option value="">Fixed</option>
        {choices.map((b) => <option key={b} value={b}>{BLANK_WORD[b] ?? b}</option>)}
      </select>
      {!blank && fixed()}
    </div>
  );
}

/** Every node, its links read as where they come from and its settings as InputRows. */
function NodeForm({ graph, blanks, nodes, onChange }: { graph: Graph; blanks: string[]; nodes: Info["nodes"]; onChange: (g: Graph) => void }) {
  const ids = Object.keys(graph).sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  return (
    <div className="wf-nodes">
      {ids.map((id) => {
        const n = graph[id]!;
        return (
          <section key={id} className="wf-node" aria-label={`Node ${id}, ${n.class_type}`}>
            <div className="wf-node-head"><b className="mono">{n.class_type}</b> <span className="muted num">{id}</span></div>
            {Object.entries(n.inputs).map(([k, v]) => isLink(v) || (v && typeof v === "object" && !Array.isArray(v)) || Array.isArray(v) ? (
              <div key={k} className="wf-input">
                <span className="mono wf-key">{k}</span>
                <span className="muted">{isLink(v) ? <>from node <span className="num">{v[0]}</span></> : Array.isArray(v) ? "a list" : "picked by the host"}</span>
              </div>
            ) : (
              <InputRow key={k} id={id} k={k} v={v} blanks={blanks} options={nodes?.[n.class_type]?.[k]}
                onChange={(next) => onChange({ ...graph, [id]: { ...n, inputs: { ...n.inputs, [k]: next } } })} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** Edit workflow: the draft an import made, or a saved custom workflow, as a form, JSON and its revisions. */
export function EditWorkflow({ ctx, hostId, name }: { ctx: MCtx; hostId?: string; name?: string }) {
  const userId = ctx.user.id;
  const host = ctx.models.page?.endpoints.find((ep) => ep.id === hostId);
  const draft = !name && pending && pending.hostId === hostId ? pending : null;
  const saved = useLoad(() => (name && hostId ? manage<Info>(userId, hostId, "GET", `/host/v1/workflows/${name}`) : Promise.resolve(undefined)), [userId, hostId, name]);
  const info = saved.data;
  const [graph, setGraph] = useState<Graph>();
  const [label, setLabel] = useState("");
  const [video, setVideo] = useState<VideoSpec | null>(null);
  const [view, setView] = useState<"form" | "graph" | "json" | "revisions">("form");
  const [layout, setLayout] = useState<Layout | null>(null);
  const types = useLoad(() => (hostId && view === "graph" ? manage<{ nodes: NodeTypes | null }>(userId, hostId, "GET", "/host/v1/workflows/nodes") : Promise.resolve(undefined)), [userId, hostId, view === "graph"]);
  const [json, setJson] = useState("");
  const [jsonProblem, setJsonProblem] = useState("");
  const [restoring, setRestoring] = useState<Revision>();
  const [run, busy, error] = useAction();
  useEffect(() => {
    const from = draft ? draft.draft : info;
    if (!from) return;
    setGraph(structuredClone(from.workflow));
    setLabel(draft ? draft.draft.label : info!.label);
    setVideo(from.video);
    setLayout(draft ? null : info!.layout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, draft?.draft]);
  const revisions = useLoad(() => (name && hostId && view === "revisions" ? manage<{ current: number; revisions: Revision[] }>(userId, hostId, "GET", `/host/v1/workflows/${name}/revisions`) : Promise.resolve(undefined)), [userId, hostId, name, view, info?.revision]);
  const does = (draft ? [draft.draft.does] : info?.does ?? []) as string[];
  const blanks = useMemo(() => [...new Set(does.flatMap((d) => BLANKS[d] ?? []))], [does.join()]);
  const back = href({ page: "models", userId, tab: "images" });

  if (!hostId || (!name && !draft)) {
    return (
      <Frame ctx={ctx} tab="images" title="Edit workflow">
        <p className="empty">Nothing to edit. <a href={href({ page: "models", userId, tab: "images", add: "image" })}>Download image model</a> imports a workflow.</p>
      </Frame>
    );
  }
  const problems = draft ? draft.problems : info?.problems ?? [];
  const missing = draft ? draft.missingNodes : info?.missingNodes ?? null;
  const checked = draft ? draft.missingNodes !== null : !!info?.nodesChecked;
  const toJson = (g?: Graph) => JSON.stringify(g ?? {}, null, 2);
  const current = (): Graph | null => {
    if (view !== "json") return graph ?? null;
    try { return JSON.parse(json) as Graph; } catch { setJsonProblem("That isn't JSON."); return null; }
  };
  const save = () => {
    const g = current();
    if (!g) return;
    if (!label.trim()) { setJsonProblem("Give it a name."); return; }
    setJsonProblem("");
    void run(async () => {
      if (draft) {
        const d = draft.draft;
        const r = await manage<{ workflow: Info }>(userId, hostId, "POST", "/host/v1/workflows", {
          name: label.trim(), does: d.does, arch: d.arch, workflow: g, loaders: d.loaders, clipType: d.clipType, video, parts: d.parts, loras: d.loras, defaults: d.defaults,
          ...(layout ? { layout } : {}),
        });
        pending = null;
        ctx.models.reload();
        location.replace(href({ page: "models", userId, tab: "images", add: "workflow", host: hostId, workflow: r.workflow.name }));
      } else {
        const r = await manage<Info>(userId, hostId, "PUT", `/host/v1/workflows/${name}`, { workflow: g, name: label.trim(), ...(video ? { video } : {}), ...(layout ? { layout } : {}) });
        saved.set(r);
        ctx.models.reload();
      }
    });
  };
  const restore = (rev: Revision) => void run(async () => {
    setRestoring(undefined);
    const r = await manage<Info>(userId, hostId, "POST", `/host/v1/workflows/${name}/revisions/${rev.revision}/restore`, {});
    saved.set(r);
    ctx.models.reload();
  });
  const facts = [
    does.map((d) => DOES_WORD[d] ?? d).join(" and "), host?.name,
    draft ? "not saved yet" : info ? `revision ${info.revision}` : "", info?.from === "copy" && info.base ? `copied from ${info.base}` : "",
  ].filter(Boolean).join(" · ");
  const setVid = (k: keyof VideoSpec, v: number | boolean) => setVideo((x) => (x ? { ...x, [k]: v } : x));

  return (
    <Frame ctx={ctx} tab="images" title={label.trim() || "Edit workflow"} facts={facts}>
      <ErrorText error={saved.error} />
      {(draft || info) && graph && (
        <div className="card wf-form">
          {problems.map((p) => <p key={p} className="warn-text">{p}</p>)}
          {draft?.draft.unmatched.map((f) => <p key={f} className="warn-text">Not on {host?.name ?? "this host"}: <code className="raw">{f}</code></p>)}
          {!!missing?.length && (
            <div className="wf-missing">
              <p className="warn-text">{host?.name ?? "This host"}'s ComfyUI doesn't have {missing.length === 1 ? "this node" : "these nodes"}: <span className="mono">{missing.join(", ")}</span></p>
              <CopyButton label="Copy request" text={nodeRequest(label, missing)} />
            </div>
          )}
          {!checked && <p className="meta" title="ComfyUI reports its nodes each time it starts.">Nodes not checked yet</p>}
          {!!draft?.draft.dropped.length && <p className="meta">Left out: {draft.draft.dropped.join(", ")}</p>}
          {info && !!info.recipes.length && <p className="meta">Used by {info.recipes.map((r) => r.name).join(", ")}</p>}
          <label className="field"><span>Name</span><input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} /></label>
          <div className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "form"} onClick={() => { const g = view === "json" ? current() : graph; if (g) { setGraph(g); setView("form"); } }}>Form</button>
            <button type="button" aria-pressed={view === "graph"} onClick={() => { const g = view === "json" ? current() : graph; if (g) { setGraph(g); setView("graph"); } }}>Graph</button>
            <button type="button" aria-pressed={view === "json"} onClick={() => { setJson(toJson(graph)); setJsonProblem(""); setView("json"); }}>JSON</button>
            {!draft && <button type="button" aria-pressed={view === "revisions"} onClick={() => { const g = view === "json" ? current() : graph; if (g) { setGraph(g); setView("revisions"); } }}>Revisions</button>}
          </div>
          {view === "form" && <>
            {video && (
              <div className="wf-video" role="group" aria-label="Clip">
                <Num label="Frame rate" value={video.fps} min={1} max={120} onChange={(n) => setVid("fps", n)} />
                <Num label="Frame step" value={video.frameStep} min={1} max={64} onChange={(n) => setVid("frameStep", n)} />
                <Num label="Frame offset" value={video.frameOffset} min={0} max={64} onChange={(n) => setVid("frameOffset", n)} />
                <Num label="Size step" value={video.sizeStep} min={1} max={128} onChange={(n) => setVid("sizeStep", n)} />
                <Num label="Longest clip" value={video.maxSeconds} min={1} max={15} onChange={(n) => setVid("maxSeconds", n)} />
                <label className="check"><input type="checkbox" checked={video.audio} onChange={(e) => setVid("audio", e.target.checked)} /> Sound</label>
              </div>
            )}
            <NodeForm graph={graph} blanks={blanks} nodes={info?.nodes ?? null} onChange={setGraph} />
          </>}
          {view === "graph" && (
            <Suspense fallback={<div className="wf-graph" />}>
              <ErrorText error={types.error} />
              <WorkflowGraph graph={graph} blanks={blanks} types={types.data?.nodes ?? null} editable={!narrow()} guessed={!layout}
                layout={layout && Object.keys(graph).every((id) => layout[id]) ? layout : { ...autoLayoutOf(graph), ...layout }}
                onChange={setGraph} onLayout={setLayout} />
            </Suspense>
          )}
          {view === "json" && (
            <textarea className="mono wf-json" aria-label="Workflow JSON" rows={24} spellCheck={false} autoComplete="off" value={json} onChange={(e) => { setJson(e.target.value); setJsonProblem(""); }} />
          )}
          {view === "revisions" && (
            <ul className="list wf-revisions" aria-label="Revisions">
              <ErrorText error={revisions.error} />
              {revisions.data?.revisions.map((r) => (
                <li key={r.revision} className="row">
                  <span>Revision <span className="num">{r.revision}</span></span>
                  <span className="muted wf-rev-meta">
                    {r.saved && <>{dateText(r.saved, { day: "numeric", month: "long" })}
                      {revisions.data!.revisions.some((o) => o !== r && o.saved && dayNumber(o.saved) === dayNumber(r.saved!)) && <> at <span className="num">{clock(r.saved)}</span></>}
                      {" · "}</>}
                    {r.by === "lyrica" ? `by ${her()}` : "in the app"}
                  </span>
                  {r.revision === revisions.data!.current
                    ? <span className="pill">current</span>
                    : <button type="button" className="sm" disabled={busy} onClick={() => setRestoring(r)}>Restore…</button>}
                </li>
              ))}
            </ul>
          )}
          <ErrorText error={jsonProblem || error} />
          {view !== "revisions" && (
            <div className="row">
              <button type="button" className="primary" disabled={busy} onClick={save}>Save</button>
              <button type="button" onClick={() => { if (draft) pending = null; location.hash = back; }}>{draft ? "Cancel" : "Back"}</button>
            </div>
          )}
        </div>
      )}
      {restoring && (
        <Dialog labelledBy="wf-restore-title" onCancel={() => setRestoring(undefined)} onSubmit={() => restore(restoring)}>
          <h2 id="wf-restore-title">Restore revision {restoring.revision}?</h2>
          <p>{label} goes back to revision {restoring.revision}, saved as a new revision. Nothing is lost.</p>
          <div className="dlg-actions">
            <button type="button" onClick={() => setRestoring(undefined)}>Cancel</button>
            <button type="submit" className="primary" disabled={busy} autoFocus>Restore</button>
          </div>
        </Dialog>
      )}
    </Frame>
  );
}

/** Copy workflow to edit: a custom copy of a built-in recipe's workflow, then its editor. */
export async function copyWorkflow(ctx: MCtx, hostId: string, recipe: { id: string; name: string }): Promise<void> {
  const r = await manage<{ workflow: Info }>(ctx.user.id, hostId, "POST", "/host/v1/workflows/copy", { recipe: recipe.id, name: `${recipe.name} copy` });
  ctx.models.reload();
  go({ page: "models", userId: ctx.user.id, tab: "images", add: "workflow", host: hostId, workflow: r.workflow.name });
}
