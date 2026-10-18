// Principles 1 and 8: capabilities and tiers use the offering's existing hand JSON. Shown on Image models only.
import { patch, u, type EndpointInfo, type OfferingInfo, type CapabilitiesChange } from "./api.ts";
import { canEdit, type MCtx } from "./ModelsFrame.tsx";
import { ErrorText, useAction } from "./ui.tsx";
import { modelName } from "./ModelLabel.tsx";

export function CloudImageControls({ ctx, ep, m }: { ctx: MCtx; ep: EndpointInfo; m: OfferingInfo }) {
  const [run, busy, error] = useAction();
  const disabled = busy || !canEdit(ctx, ep);
  const change = (value: CapabilitiesChange) => void run(async () => {
    await patch(u(ctx.user.id, "offerings", m.id), value);
    ctx.models.reload();
  });
  return <div className="cloud-image-controls">
    <div className="checks" role="group" aria-label={`What ${modelName(m)} does`}>
      <label className="check"><input type="checkbox" checked={!!m.image} disabled={disabled} onChange={(e) => change({ image: e.target.checked })} /> Generate</label>
      <label className="check"><input type="checkbox" checked={!!m.edit} disabled={disabled} onChange={(e) => change({ edit: e.target.checked })} /> Edit</label>
    </div>
    {m.image && <div className="field"><span>Use for</span><div className="seg" role="group" aria-label={`Use ${modelName(m)} on ${ep.name} for`}>
      {(["fast", "quality", "both"] as const).map((useFor) => <button key={useFor} type="button" disabled={disabled}
        aria-pressed={(m.useFor ?? "both") === useFor} onClick={() => change({ useFor })}>{useFor === "fast" ? "Fast" : useFor === "quality" ? "Quality" : "Both"}</button>)}
    </div></div>}
    <ErrorText error={error} />
  </div>;
}
