// The sidebar's status panel (docs/ux.md §6): the two most-used local endpoints side by side, and up to two cloud
// ones with when they were last checked. It reads the shell's GET …/models/page, which the shell polls so the panel
// shows on every page, and ranks by its endpointUses counts — not by the recent-calls preview, which is only a
// preview; with no endpoints there is nothing to say, so it isn't drawn at all.
import type { ModelsPage } from "./api.ts";
import { stateOf } from "./Models.tsx";
import { hostOf } from "./ModelsFrame.tsx";
import { useNow } from "./ui.tsx";

/** One endpoint in the panel: its name, a dot's class, and its state in a word when it isn't simply up. */
export interface StatusItem { id: string; name: string; dot: string; word?: string }

const LIMIT = 2;

/** The panel's endpoints from the page: up to the two most-used local ones and the two most-used cloud ones,
 * most used first, counted over its `endpointUses`. Endpoints it doesn't name count as unused and keep their order among themselves. */
export function selectStatus(page?: ModelsPage): { local: StatusItem[]; cloud: StatusItem[] } {
  if (!page) return { local: [], cloud: [] };
  const uses = new Map(page.endpointUses.map((u) => [u.endpointId, u.calls]));
  const pick = (kind: "local" | "cloud") => page.endpoints
    .map((e, at) => ({ e, at }))
    .filter(({ e }) => e.kind === kind)
    .sort((a, b) => (uses.get(b.e.id) ?? 0) - (uses.get(a.e.id) ?? 0) || a.at - b.at)
    .slice(0, LIMIT)
    .map(({ e }) => {
      const s = stateOf(e, hostOf(page, e.id));
      return { id: e.id, name: e.name, dot: s.dot, word: s.dot === "up" ? undefined : s.word };
    });
  return { local: pick("local"), cloud: pick("cloud") };
}

/** How long ago the page was fetched: seconds to a minute, minutes after that. */
export function checkedAgo(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
}

/** The panel. `checkedAt` is when the page last arrived; the times tick with the sidebar's clock. */
export function SideStatus({ page, checkedAt }: { page?: ModelsPage; checkedAt: number }) {
  const now = useNow();
  const { local, cloud } = selectStatus(page);
  if (!local.length && !cloud.length) return null;
  return (
    <div className="status-line">
      {!!local.length && <div className="status-row">{local.map((i) => <StatusItemView key={i.id} item={i} />)}</div>}
      {cloud.map((i) => <StatusItemView key={i.id} item={i} checked={now.getTime() - checkedAt} />)}
    </div>
  );
}

/** One endpoint: a dot, its name, and its state — cloud ones add when they were last checked. The tooltip holds the whole line, so a truncated one still reads in full. */
function StatusItemView({ item, checked }: { item: StatusItem; checked?: number }) {
  const ago = checked !== undefined ? `checked ${checkedAgo(checked)} ago` : undefined;
  return (
    <span className="status-item" title={[item.name, item.word, ago].filter(Boolean).join(" · ")}>
      <span className={`dot ${item.dot}`} aria-hidden="true" />
      <span className="status-name">{item.name}</span>
      {item.word ? <span className="status-state">· {item.word}</span> : item.dot === "up" && <span className="sr-only"> · up</span>}
      {checked !== undefined && <span className="status-state">· checked {(() => { const [n, unit] = checkedAgo(checked).split(" "); return <><span className="num">{n}</span> {unit} ago</>; })()}</span>}
    </span>
  );
}
