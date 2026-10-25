import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelCallFacts } from "../src/ModelCallFacts.tsx";
import type { ModelCallFacts as Facts } from "../src/api.ts";

const facts = (models: Facts["models"] = []): Facts => ({ since: "2026-10-23T12:00:00Z", until: "2026-10-24T12:00:00Z", pools: ["general"], models });
const render = (value: Facts) => renderToStaticMarkup(createElement(ModelCallFacts, { facts: value }));

it("renders populated per-model facts with explicit retained scope and sample counts", () => {
  const html = render(facts([{ offeringId: "one", label: "Fixture model", endpointName: "Fixture endpoint", calls: 7, medianTokPerSec: 12.5, speedSamples: 4, fallbacks: 2 }]));
  for (const text of ["Fixture model", "Fixture endpoint", ">7</span> calls", ">12.5</span> tok/s", ">4</span> measured", ">2</span>", "Retained history", "General", "500", "records per user", "Not errors, retries or failed requests."]) expect(html).toContain(text);
  expect(html).not.toContain("Unavailable");
  expect(html).not.toContain("<button");
});

it("keeps missing speed unavailable, distinct from a measured zero or zero recorded fallbacks", () => {
  const html = render(facts([{ offeringId: "one", label: "Unmeasured", endpointName: "fixture", calls: 1, speedSamples: 0, fallbacks: 0 }, { offeringId: "two", label: "Measured", endpointName: "fixture", calls: 1, medianTokPerSec: 0, speedSamples: 1, fallbacks: 0 }]));
  expect(html.match(/Unavailable/g)).toHaveLength(1);
  expect(html).toContain(">0</span> tok/s");
  expect(html).toContain(">0</span> measured");
  expect(html.match(/Recorded fallbacks/g)).toHaveLength(2);
});

it("renders empty and no-pools states honestly without an invented zero-speed row", () => {
  const html = render({ ...facts(), pools: [] });
  expect(html).toContain("No pools shown");
  expect(html).toContain("No retained calls in the last");
  expect(html).not.toContain("tok/s");
  expect(html).not.toContain("<dd>");
});

it("renders every model copy and escapes recorded labels as text", () => {
  const html = render(facts(Array.from({ length: 60 }, (_, i) => ({ offeringId: `m-${i}`, label: `<model-${i}>`, endpointName: "fixture", calls: 1, speedSamples: 0, fallbacks: 0 }))));
  expect(html.match(/<dt /g)).toHaveLength(60);
  expect(html).toContain("&lt;model-59&gt;");
  expect(html).not.toContain("<model-59>");
});
