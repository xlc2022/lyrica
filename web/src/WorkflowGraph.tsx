// Edit workflow's Graph view (docs/ux.md §6, "Image models, recipes and parts"): a custom workflow's nodes and links
// drawn as ComfyUI draws them. On a wide screen nodes move, their settings are edited on them, links are drawn from an
// output to an input, nodes are
// added from the host's node list and deleted; on a phone it only shows the graph. Every save is still checked by the
// host, so nothing drawn here can add a node that writes files. Loaded only when the Graph view opens.
import "@xyflow/react/dist/style.css";
import {
  Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { blankOf, BLANK_WORD, InputRow, isLink, type Graph, type NodeTypes, type Value, type WNode } from "./Workflows.tsx";

export type Layout = Record<string, [number, number]>;
type NodeData = {
  id: string; node: WNode; types: NodeTypes | null; inputs: string[]; outputs: { type: string; name: string }[];
  /** On a wide screen: settings are edited on the node itself, as the Form's rows. */
  edit?: { blanks: string[]; set: (k: string, v: Value) => void };
};

/** A setting's kind as ComfyUI reports it: anything that isn't one is a type a link carries, such as MODEL. */
const SETTING = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "unknown"]);
const linkInput = (kind: unknown) => typeof kind === "string" && !SETTING.has(kind);

const byId = (a: string, b: string) => (Number(a) - Number(b)) || a.localeCompare(b);

/** The inputs a node shows as ports: those ComfyUI says take a link, and any the workflow links now. */
function portsOf(n: WNode, types: NodeTypes | null): string[] {
  const kinds = types?.[n.class_type]?.inputs ?? {};
  const keys = [...Object.keys(kinds).filter((k) => linkInput(kinds[k])), ...Object.keys(n.inputs).filter((k) => isLink(n.inputs[k]))];
  return [...new Set(keys)].filter((k) => !(k in n.inputs) || isLink(n.inputs[k]));
}

/** Its outputs: as ComfyUI reports them, or as many as the workflow uses when it hasn't. */
function outputsOf(id: string, n: WNode, graph: Graph, types: NodeTypes | null): { type: string; name: string }[] {
  const t = types?.[n.class_type];
  if (t?.outputs?.length) return t.outputs.map((type, i) => ({ type, name: t.outputNames?.[i] ?? type }));
  let most = -1;
  for (const m of Object.values(graph)) for (const v of Object.values(m.inputs)) if (isLink(v) && v[0] === id) most = Math.max(most, v[1]);
  return Array.from({ length: most + 1 }, (_, i) => ({ type: "*", name: `output ${i}` }));
}

function ComfyNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const { id, node, inputs, outputs, types, edit } = data;
  const settings = Object.entries(node.inputs).filter(([, v]) => !isLink(v));
  return (
    <div className={`wf-gnode${selected ? " selected" : ""}`} aria-label={`Node ${id}, ${node.class_type}`}>
      <div className="wf-gnode-head"><b className="mono">{node.class_type}</b> <span className="muted num">{id}</span></div>
      {outputs.map((o, i) => (
        <div key={`o${i}`} className="wf-gport out">
          <span className="mono">{o.name}</span>
          <Handle type="source" position={Position.Right} id={`o${i}`} />
        </div>
      ))}
      {inputs.map((k) => (
        <div key={`i${k}`} className="wf-gport in">
          <Handle type="target" position={Position.Left} id={`i:${k}`} />
          <span className="mono">{k}</span>
        </div>
      ))}
      {settings.map(([k, v]) => {
        if (edit && !(v && typeof v === "object")) {
          // nodrag and nowheel: typing, selecting and scrolling a list here mustn't move the node or zoom the canvas.
          return (
            <div key={`s${k}`} className="wf-gedit nodrag nowheel">
              <InputRow id={id} k={k} v={v} blanks={edit.blanks} options={types?.[node.class_type]?.inputs?.[k]} onChange={(next) => edit.set(k, next)} />
            </div>
          );
        }
        const blank = blankOf(v);
        const shown = blank ? BLANK_WORD[blank] ?? blank : typeof v === "object" && v !== null ? (Array.isArray(v) ? "a list" : "picked by the host") : String(v);
        return (
          <div key={`s${k}`} className="wf-gset">
            <span className="mono">{k}</span>
            <span className={blank ? "pill" : "muted wf-gval"}>{shown}</span>
          </div>
        );
      })}
    </div>
  );
}
const NODE_TYPES = { comfy: ComfyNode };

interface Props {
  graph: Graph; layout: Layout; blanks: string[]; types: NodeTypes | null; editable: boolean;
  /** The layout was guessed (autoLayoutOf): once the nodes are drawn, their columns close up to the drawn sizes. */
  guessed: boolean;
  onChange: (g: Graph) => void; onLayout: (l: Layout) => void;
}

/** The least zoom a fitted graph gets: node text is 13 px, so it stays 11 px or more. A bigger graph pans instead. */
const MIN_FIT = 0.85;
/** The margin a fitted graph keeps inside the canvas, in px; at the top it also clears the zoom controls' row. */
const INSET = 16;
const TOP = 60;
const GAP = 32;

function Canvas({ graph, layout, blanks, types, editable, guessed, onChange, onLayout }: Props) {
  const flow = useReactFlow();
  // Each node's drawn size, as React Flow measures it.
  const sizes = useRef(new Map<string, { w: number; h: number }>());
  const [drawn, setDrawn] = useState(false);
  const settled = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(false);
  const latest = useRef(layout);
  latest.current = layout;
  // Fitted once the nodes have their sizes, measured again after the fonts load (the monospace font is wider than its
  // fallback); a guessed layout first closes up its columns to those sizes.
  useEffect(() => {
    if (!drawn || settled.current) return;
    let alive = true;
    let frame = 0;
    void document.fonts.ready.then(() => { if (alive) frame = requestAnimationFrame(settle); });
    return () => { alive = false; cancelAnimationFrame(frame); };
  }, [drawn]);
  const settle = () => {
    if (settled.current) return;
    settled.current = true;
    if (guessed) {
      const columns = new Map<number, { id: string; y: number; w: number; h: number }[]>();
      for (const [id, [x, y]] of Object.entries(latest.current)) {
        const col = Math.round(x / 320);
        const size = sizes.current.get(id) ?? { w: 200, h: 100 };
        columns.set(col, [...(columns.get(col) ?? []), { id, y, ...size }]);
      }
      const next: Layout = {};
      let x = 0;
      for (const col of [...columns.keys()].sort((a, b) => a - b)) {
        const ns = columns.get(col)!.sort((a, b) => a.y - b.y);
        let y = 0;
        for (const n of ns) { next[n.id] = [x, y]; y += n.h + GAP / 2; }
        x += Math.max(...ns.map((n) => n.w)) + GAP;
      }
      onLayout(next);
    }
    setFit(true);
  };
  useEffect(() => {
    if (!fit) return;
    const frame = requestAnimationFrame(() => {
      // At zoom 1 when it fits inside the margin, down to MIN_FIT before clipping; centred when it fits, else from its
      // top left, the graph's start, to pan from.
      // Measured from the layout and the drawn sizes, since React Flow's own copy of the positions may lag a frame.
      const canvas = canvasRef.current?.getBoundingClientRect();
      const ids = Object.keys(graph).filter((id) => layout[id]);
      if (canvas && ids.length) {
        const x0 = Math.min(...ids.map((id) => layout[id]![0]));
        const y0 = Math.min(...ids.map((id) => layout[id]![1]));
        const x1 = Math.max(...ids.map((id) => layout[id]![0] + (sizes.current.get(id)?.w ?? 200)));
        const y1 = Math.max(...ids.map((id) => layout[id]![1] + (sizes.current.get(id)?.h ?? 100)));
        const room = { w: canvas.width - 2 * INSET, h: canvas.height - TOP - INSET };
        const zoom = Math.min(1, Math.max(MIN_FIT, Math.min(room.w / (x1 - x0), room.h / (y1 - y0))));
        const along = (space: number, size: number, from: number) => (size * zoom <= space ? (space - size * zoom) / 2 : 0) - from * zoom;
        void flow.setViewport({ x: INSET + along(room.w, x1 - x0, x0), y: TOP + along(room.h, y1 - y0, y0), zoom });
      }
      setFit(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [fit, layout]);
  const [selected, setSelected] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const nodes: Node<NodeData>[] = useMemo(() => Object.keys(graph).sort(byId).map((id) => {
    const n = graph[id]!;
    const [x, y] = layout[id] ?? [0, 0];
    return {
      id, type: "comfy", position: { x, y }, selected: id === selected, deletable: editable,
      data: {
        id, node: n, types, inputs: portsOf(n, types), outputs: outputsOf(id, n, graph, types),
        edit: editable ? { blanks, set: (k, v) => onChange({ ...graph, [id]: { ...n, inputs: { ...n.inputs, [k]: v } } }) } : undefined,
      },
    };
  }), [graph, layout, types, selected, editable, blanks, onChange]);
  const edges: Edge[] = useMemo(() => Object.entries(graph).flatMap(([id, n]) => Object.entries(n.inputs).filter((e): e is [string, [string, number]] => isLink(e[1]))
    .map(([k, [from, i]]) => {
      const key = `${from}:${i}>${id}:${k}`;
      return { id: key, source: from, sourceHandle: `o${i}`, target: id, targetHandle: `i:${k}`, deletable: editable, selected: key === link };
    })), [graph, editable, link]);

  const remove = (ids: string[]) => {
    const gone = new Set(ids);
    const next: Graph = {};
    for (const [id, n] of Object.entries(graph)) {
      if (gone.has(id)) continue;
      next[id] = { ...n, inputs: Object.fromEntries(Object.entries(n.inputs).filter(([, v]) => !(isLink(v) && gone.has(v[0])))) };
    }
    onChange(next);
    if (selected && gone.has(selected)) setSelected(null);
  };
  const onNodesChange = (changes: NodeChange<Node<NodeData>>[]) => {
    let moved: Layout | null = null;
    for (const c of changes) {
      if (c.type === "position" && c.position) (moved ??= { ...layout })[c.id] = [Math.round(c.position.x), Math.round(c.position.y)];
      if (c.type === "select") setSelected((s) => (c.selected ? c.id : s === c.id ? null : s));
      if (c.type === "dimensions" && c.dimensions) sizes.current.set(c.id, { w: c.dimensions.width, h: c.dimensions.height });
    }
    if (moved) onLayout(moved);
    if (!drawn && Object.keys(graph).every((id) => sizes.current.has(id))) setDrawn(true);
    const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
    if (removed.length) remove(removed);
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const c of changes) if (c.type === "select") setLink((s) => (c.selected ? c.id : s === c.id ? null : s));
    const removed = changes.filter((c) => c.type === "remove").map((c) => edges.find((e) => e.id === c.id)).filter((e): e is Edge => !!e);
    if (!removed.length) return;
    const next = structuredClone(graph);
    for (const e of removed) delete next[e.target]!.inputs[e.targetHandle!.slice(2)];
    onChange(next);
  };
  const typeOf = (c: Connection | Edge) => {
    const from = graph[c.source];
    const to = graph[c.target];
    if (!from || !to || !c.sourceHandle || !c.targetHandle) return null;
    const out = outputsOf(c.source, from, graph, types)[Number(c.sourceHandle.slice(1))]?.type ?? "*";
    const kind = types?.[to.class_type]?.inputs?.[c.targetHandle.slice(2)];
    return { out, into: typeof kind === "string" ? kind : "*" };
  };
  const fits = (c: Connection | Edge) => {
    if (c.source === c.target) return false;
    const t = typeOf(c);
    return !!t && (t.out === "*" || t.into === "*" || t.out === t.into || t.into.split(",").includes(t.out));
  };
  const onConnect = (c: Connection) => {
    if (!fits(c)) return;
    const to = graph[c.target]!;
    onChange({ ...graph, [c.target]: { ...to, inputs: { ...to.inputs, [c.targetHandle!.slice(2)]: [c.source, Number(c.sourceHandle!.slice(1))] } } });
  };

  const add = (cls: string) => {
    const t = types?.[cls];
    if (!t) return;
    const id = String(Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1);
    const inputs: Record<string, Value> = {};
    for (const [k, kind] of Object.entries(t.inputs)) {
      if (linkInput(kind)) continue;
      const d = t.defaults?.[k];
      inputs[k] = d !== undefined ? d : Array.isArray(kind) ? (kind[0] as string) ?? "" : kind === "STRING" ? "" : kind === "BOOLEAN" ? false : 0;
    }
    // Where nothing is: under the lowest node of the last column; then panned to if that's out of view.
    const placed = Object.keys(graph).filter((n) => layout[n]);
    const right = Math.max(...placed.map((n) => layout[n]![0]));
    const last = placed.filter((n) => layout[n]![0] >= right - 40);
    const bottom = Math.max(...last.map((n) => layout[n]![1] + (sizes.current.get(n)?.h ?? 100)));
    const at = placed.length ? { x: Math.min(...last.map((n) => layout[n]![0])), y: bottom + GAP / 2 } : { x: 0, y: 0 };
    onChange({ ...graph, [id]: { class_type: cls, inputs } });
    onLayout({ ...layout, [id]: [Math.round(at.x), Math.round(at.y)] });
    requestAnimationFrame(() => {
      const el = canvasRef.current;
      if (!el) return;
      // In the canvas's own pixels, so the page scrolling under it doesn't count.
      const { x, y, zoom } = flow.getViewport();
      const left = at.x * zoom + x, top = at.y * zoom + y;
      if (left < 0 || top < 0 || left + 160 * zoom > el.clientWidth || top + 120 * zoom > el.clientHeight) {
        void flow.setCenter(at.x + 80, at.y + 60, { zoom });
      }
    });
    setSelected(id);
    setQuery("");
  };
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !types) return [];
    return Object.entries(types).filter(([cls, t]) => cls.toLowerCase().includes(q) || (t.category ?? "").toLowerCase().includes(q)).slice(0, 30);
  }, [query, types]);

  const node = selected ? graph[selected] : undefined;
  return (
    <>
      {editable && (
        <div className="wf-gadd">
          <label className="field"><span>Add node</span>
            <input type="search" value={query} placeholder={types ? "Search this host's nodes" : "Nodes not checked yet"} disabled={!types} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {!!matches.length && (
            <ul className="list wf-gmatches" aria-label="Nodes">
              {matches.map(([cls, t]) => (
                <li key={cls}><button type="button" onClick={() => add(cls)}><span className="mono">{cls}</span>{t.category && <span className="muted"> · {t.category}</span>}</button></li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="wf-graph" role="group" aria-label="Graph" ref={canvasRef}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          isValidConnection={fits} nodesDraggable={editable} nodesConnectable={editable} elementsSelectable deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
          minZoom={0.1} proOptions={{ hideAttribution: true }}>
          <Background gap={20} size={1} />
          <Controls showInteractive={false} position="top-right" orientation="horizontal" />
        </ReactFlow>
      </div>
      {node && selected && (
        <section className="wf-node" aria-label={`Node ${selected}, ${node.class_type}`}>
          <div className="wf-node-head row between">
            <span><b className="mono">{node.class_type}</b> <span className="muted num">{selected}</span></span>
            {editable && <button type="button" className="sm danger" onClick={() => remove([selected])}>Delete node</button>}
          </div>
          {!editable && Object.entries(node.inputs).filter(([, v]) => !isLink(v) && !(v && typeof v === "object")).map(([k, v]) => (
            <InputRow key={k} id={selected} k={k} v={v} blanks={blanks} options={types?.[node.class_type]?.inputs?.[k]}
              onChange={(next) => onChange({ ...graph, [selected]: { ...node, inputs: { ...node.inputs, [k]: next } } })} />
          ))}
        </section>
      )}
    </>
  );
}

export default function WorkflowGraph(props: Props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
