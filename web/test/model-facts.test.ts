import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hourly, hours, ModelCallFacts, seriesOf } from "../src/ModelCallFacts.tsx";
import type { ModelCallFacts as Facts } from "../src/api.ts";

// Synthetic facts only: no text of any real conversation.
type Model = Facts["models"][number];
const model = (over: Partial<Model> & { offeringId: string }): Model => ({ label: over.offeringId, endpointName: "fixture", kind: "local", calls: 1, speedSamples: 0, promptSamples: 0, outputTokens: 0, fallbacks: 0, ...over });
const facts = (models: Model[] = [], calls: Facts["calls"] = []): Facts => ({ since: "2026-10-23T12:00:00Z", until: "2026-10-24T12:30:00Z", pools: ["general"], models, calls });
const render = (value: Facts) => renderToStaticMarkup(createElement(ModelCallFacts, { facts: value }));

it("renders a row per model copy with its short name, endpoint, output, speeds and fallbacks, and the scope", () => {
  const html = render(facts([model({ offeringId: "one", label: "Host/models/Fixture-27B-Q4_K_M.gguf", endpointName: "Fixture endpoint", calls: 7, medianTokPerSec: 12.5, speedSamples: 4, medianPromptTokPerSec: 812, promptSamples: 4, outputTokens: 24_000, fallbacks: 2 })]));
  for (const text of ["Fixture-27B-Q4_K_M", "Fixture endpoint", ">7</span>", ">12.5 <span", ">812 <span", "4 measured.", ">24k</span>", "Retained history", "General", "500", "records per user", "Not errors, retries or failed requests.", "Calls per hour", "Speed per call", "Calls by task"]) expect(html).toContain(text);
  // The whole label stays in a tooltip.
  expect(html).toContain('title="Host/models/Fixture-27B-Q4_K_M.gguf · Fixture endpoint"');
  expect(html).not.toContain("Not measured");
});

it("says a speed nothing measured is not measured, distinct from a measured zero", () => {
  const html = render(facts([model({ offeringId: "one", label: "Unmeasured" }), model({ offeringId: "two", label: "Measured", medianTokPerSec: 0, speedSamples: 1 })]));
  expect(html.match(/Not measured: no call/g)).toHaveLength(2 + 1); // its speed and prompt, and the other's prompt
  expect(html).toContain(">0 <span class=\"muted\">tok/s");
});

it("renders empty and no-pools states honestly, with no charts", () => {
  const html = render({ ...facts(), pools: [] });
  expect(html).toContain("No pools shown");
  expect(html).toContain("No retained calls in the last");
  expect(html).not.toContain("tok/s");
  expect(html).not.toContain("Calls per hour");
});

it("escapes recorded labels as text", () => {
  const html = render(facts([model({ offeringId: "m", label: "<model-59>" })]));
  expect(html).toContain("&lt;model-59&gt;");
  expect(html).not.toContain("<model-59>");
});

it("keeps a copy's colour by label, names copies that share a name by endpoint, and folds the least used past eight into Other", () => {
  const two = seriesOf([model({ offeringId: "a", label: "x/Same", endpointName: "One" }), model({ offeringId: "b", label: "y/Same", endpointName: "Two" })], "light", "#888888");
  expect(two.map((s) => s.name)).toEqual(["Same · One", "Same · Two"]);
  const many = Array.from({ length: 10 }, (_, i) => model({ offeringId: `m${i}`, label: `m${i}`, calls: i }));
  const s = seriesOf(many, "light", "#888888");
  expect(s.filter((x) => x.name === "Other").map((x) => x.offeringId)).toEqual(["m0", "m1", "m2"]);
  expect(new Set(s.map((x) => x.color)).size).toBe(8);
});

it("buckets calls and output into the 24 hours on the user's clock, the oldest partial hour holding what came before it", () => {
  const f = facts([model({ offeringId: "a" })], [
    { at: "2026-10-24T12:10:00Z", offeringId: "a", task: "chat", outputTokens: 30 },
    { at: "2026-10-24T12:05:00Z", offeringId: "a", task: "title", outputTokens: 5 },
    { at: "2026-10-23T12:45:00Z", offeringId: "a", task: "chat" },
  ]);
  const h = hours(f.until);
  expect(h).toHaveLength(24);
  expect(new Date(h[23]!).toISOString()).toBe("2026-10-24T12:00:00.000Z");
  expect(hourly(f, seriesOf(f.models, "light", "#888888"))).toEqual([
    { hour: h[23], model: "a", calls: 2, tokens: 35 },
    { hour: h[0], model: "a", calls: 1, tokens: 0 },
  ]);
});
