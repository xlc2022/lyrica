// Principle 1: one confirmation for bringing existing work into a project.
import { useState } from "react";
import { patch, type ThreadSettings, type ThreadSummary } from "./api.ts";
import { Dialog, ErrorText, useAction } from "./ui.tsx";

export interface FoldRow { thread: ThreadSummary; settings: ThreadSettings; index: number }
const SWITCHES = ["Internet", "Services", "Cloud models"];
export const foldLosses = (s: ThreadSettings, p: ThreadSettings) => [
    ...s.grants.filter(g => !p.grants.some(x => (x.path === g.path || g.path.startsWith(`${x.path.replace(/\/$/, "")}/`)) && (!g.writable || x.writable))).map(g => g.path),
    ...s.machines.filter(x => !p.machines.includes(x)),
    ...s.repositories.filter(r => !p.repositories.some(x => x.name === r.name && x.account === r.account)).map(r => r.name),
    ...s.network.hosts.filter(x => !p.network.hosts.includes(x)),
    ...(!s.localOnly && p.localOnly ? ["Cloud models"] : []),
    ...(s.network.internet && !p.network.internet ? ["Internet"] : []), ...(s.network.services && !p.network.services ? ["Services"] : []),
  ];
/** The loss names in the Loses line's format: switches plain, the rest in mono, at most three then +n. */
export const foldLossNames = (lost: string[]) => <>{lost.slice(0, 3).map((name, n) => <span key={name}>{n > 0 && ", "}{SWITCHES.includes(name) ? name : <span className="mono">{name}</span>}</span>)}{lost.length > 3 ? ` +${lost.length - 3}` : ""}</>;

export function FoldConfirm({ chosen, tree, settings, base, projectName, move, onFold, onDone, onCancel }: {
  /** From the thread menu the action reads Move; from the card, Fold in. */ move?: boolean;
  chosen: FoldRow[]; tree: ThreadSummary[]; settings: ThreadSettings; base: string; projectName: string;
  onFold: (row: FoldRow) => Promise<unknown>; onDone: () => void; onCancel: () => void;
}) {
  const [give, setGive] = useState(false);
  const [run, busy, error] = useAction();
  const allLost = [...new Set(chosen.flatMap(r => foldLosses(r.settings, settings)))];
  const accessLost = allLost.filter(name => name !== "Cloud models");
  const fold = () => run(async () => {
    const p = settings;
    if (give && accessLost.length) {
      const grants = [...p.grants]; const repositories = [...p.repositories];
      for (const { settings: c } of chosen) {
        for (const g of c.grants) { const i = grants.findIndex(x => x.path === g.path); if (i < 0) grants.push(g); else if (g.writable) grants[i] = g; }
        for (const r of c.repositories) if (!repositories.some(x => x.name === r.name && x.account === r.account)) repositories.push(r);
      }
      await patch<ThreadSettings>(`${base}/settings`, {
        grants, repositories, machines: [...new Set([...p.machines, ...chosen.flatMap(c => c.settings.machines)])], hosts: [...new Set([...p.network.hosts, ...chosen.flatMap(c => c.settings.network.hosts)])],
        internet: p.network.internet || chosen.some(c => c.settings.network.internet), services: p.network.services || chosen.some(c => c.settings.network.services),
      });
    }
    for (const r of chosen) await onFold(r);
    onDone();
  });
  return <Dialog labelledBy="fold-title" onCancel={onCancel} onSubmit={() => void fold()}>
      <h2 id="fold-title">{`${move ? "Move" : "Fold"} ${chosen.length === 1 ? chosen[0]!.thread.title || "New thread" : `${chosen.length} threads`} ${move ? "to" : "into"} ${projectName}?`}</h2>
      <ul className="fold-list">{chosen.map(r => {
        const kids = tree.find(t => t.id === r.thread.id)?.children ?? [];
        return <li key={r.thread.id}>{r.thread.title || "New thread"}{!!kids.length && <span className="muted"> and its child {kids.length === 1 ? "thread" : "threads"}: {kids.map(k => k.title || "New thread").join(", ")}</span>}</li>;
      })}</ul>
      {!!allLost.length && <>
        <p className="muted small fold-loss" title={allLost.join(", ")}>Loses {foldLossNames(allLost)}</p>
        {accessLost.length > 0 && <label className="check"><input type="checkbox" checked={give} onChange={e => setGive(e.target.checked)} /> Give {projectName} access to these</label>}
      </>}
      <p>A thread can't be taken out of a project once it's in.</p>
      <ErrorText error={error} />
      <div className="dlg-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="submit" className="primary" autoFocus disabled={busy}>{move ? "Move" : "Fold in"}</button></div>
  </Dialog>;
}
