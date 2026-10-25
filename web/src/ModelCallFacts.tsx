import { Fragment } from "react";
import type { ModelCallFacts as Facts } from "./api.ts";

/** Plain Status facts; no controls or independent refresh. */
export function ModelCallFacts({ facts }: { facts: Facts }) {
  return <section aria-label="Model calls">
    <h3 style={{ fontSize: 15 }} title="Your own retained call records in displayed pools, across all recorded tasks. A turn's retries replace its record; tool requests update its pace. Claude Code relay totals are not call records. Deleted and pruned records are excluded.">Model calls · last <span className="num">24</span> hours</h3>
    <p className="muted" title="Nightly pruning keeps the latest 500 records across both pools. Earlier calls within these 24 hours may be missing; counts are not complete daily activity.">Retained history · {facts.pools.map((p) => p === "general" ? "General" : "Private").join(" and ") || "No pools shown"} · pruned to latest <span className="num">500</span> records per user</p>
    {facts.models.length ? <dl className="facts" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      {facts.models.map((m) => <Fragment key={m.offeringId}>
        <dt style={{ overflowWrap: "anywhere" }}>{m.label} <span className="muted">· {m.endpointName}</span></dt>
        <dd>
          <span className="num">{m.calls}</span> {m.calls === 1 ? "call" : "calls"}
          {" · "}<span title="Median recorded output tokens per second of generation, with positive output and at least 50 ms. Missing measurements are excluded.">Median speed</span>{" "}
          {m.medianTokPerSec === undefined ? "Unavailable" : <><span className="num">{m.medianTokPerSec.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> tok/s</>}
          {" · "}<span className="num">{m.speedSamples}</span> measured
          {" · "}<span title="Records with a fallback marker: a resolution candidate was skipped. Not errors, retries or failed requests. No marker means no recorded fallback.">Recorded fallbacks</span>{" "}<span className="num">{m.fallbacks}</span>
        </dd>
      </Fragment>)}
    </dl> : <p className="muted">No retained calls in the last <span className="num">24</span> hours.</p>}
  </section>;
}
