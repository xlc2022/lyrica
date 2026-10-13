// Principles 1 and 8: capabilities and tiers use the offering's existing hand JSON.
import { patch, u, type EndpointInfo, type OfferingInfo, type CapabilitiesChange } from "./api.ts";
import { canEdit, type MCtx } from "./ModelsFrame.tsx";
import { ErrorText, Switch, useAction } from "./ui.tsx";

export function CloudImageControls({ ctx, ep, m }: { ctx: MCtx; ep: EndpointInfo; m: OfferingInfo }) {
  const [run, busy, error] = useAction();
  const disabled = busy || !canEdit(ctx, ep);
  const change = (value: CapabilitiesChange) => void run(async () => {
    await patch(u(ctx.user.id, "offerings", m.id), value);
    ctx.models.reload();
  });
  return <div className="cloud-image-controls">
    <Switch label="Image generation" hint="Lets her create images with this model." checked={!!m.image} disabled={disabled} onChange={(image) => change({ image })} />
    <Switch label="Image editing" hint="Lets her edit images with this model." checked={!!m.edit} disabled={disabled} onChange={(edit) => change({ edit })} />
    {m.image && <div className="field"><span>Use for</span><div className="seg" role="group" aria-label={`Use ${m.modelId} on ${ep.name} for`}>
      {(["fast", "quality", "both"] as const).map((useFor) => <button key={useFor} type="button" disabled={disabled}
        aria-pressed={(m.useFor ?? "both") === useFor} onClick={() => change({ useFor })}>{useFor === "fast" ? "Fast" : useFor === "quality" ? "Quality" : "Both"}</button>)}
    </div></div>}
    <ErrorText error={error} />
  </div>;
}
