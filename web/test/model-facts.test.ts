import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bucketed, buckets, bucketSize, factsQuery, ModelCallFacts, seriesOf, speedSpec, unwall, wall } from "../src/ModelCallFacts.tsx";
import type { ModelCallFacts as Facts } from "../src/api.ts";

// Synthetic facts only: no text of any real conversation.
type Model = Facts["models"][number];
const model = (over: Partial<Model> & { offeringId: string }): Model => ({ label: over.offeringId, endpointName: "fixture", kind: "local", calls: 1, speedSamples: 0, promptSamples: 0, outputTokens: 0, fallbacks: 0, ...over });
const facts = (models: Model[] = [], calls: Facts["calls"] = []): Facts => ({ from: "2026-10-23T12:30:00Z", since: "2026-10-23T12:30:00Z", until: "2026-10-24T12:30:00Z", pools: ["general"], models, calls });
const render = (value: Facts) => renderToStaticMarkup(createElement(ModelCallFacts, { facts: value }));

it("renders a row per model copy with its short name, endpoint, output, speeds and fallbacks, and the scope", () => {
  const html = render(facts([model({ offeringId: "one", label: "Host/models/Fixture-27B-Q4_K_M.gguf", endpointName: "Fixture endpoint", calls: 7, medianTokPerSec: 12.5, speedSamples: 4, medianPromptTokPerSec: 812, promptSamples: 4, outputTokens: 24_000, fallbacks: 2 })]));
  for (const text of ["Fixture-27B-Q4_K_M", "Fixture endpoint", ">7</span>", ">12.5 <span", ">812 <span", "4 measured.", ">24k</span>", "Retained history", "General", "kept <span class=\"num\">31</span> days", "last <span class=\"num\">24</span> hours", "Not errors, retries or failed requests.", "Calls per hour", "Speed per call", "Calls by task"]) expect(html).toContain(text);
  // The whole label stays in a tooltip.
  expect(html).toContain('title="Host/models/Fixture-27B-Q4_K_M.gguf · Fixture endpoint"');
  expect(html).not.toContain("Not measured");
});

it("shows an image model's seconds per image in its Speed cell, with steps, size and it/s in the tooltip, and no prompt speed", () => {
  const html = render(facts([
    model({ offeringId: "art", label: "Krea 2 Turbo", calls: 8, sampling: { secondsPer: 17.25, steps: 8, stepsPerSec: 0.46, pixels: 1_048_576, samples: 6, unit: "image" } }),
    model({ offeringId: "clip", label: "Clip", calls: 1, sampling: { secondsPer: 240.4, steps: 20, stepsPerSec: 0.083, samples: 1, unit: "clip" } }),
  ]));
  expect(html).toContain('>17.3 <span class="muted">s/image</span>');
  expect(html).toContain('>240 <span class="muted">s/clip</span>');
  expect(html).toContain("Median sampling time per image on its host");
  expect(html).toContain("8 steps · 1 MP · 0.5 it/s. 6 measured.");
  expect(html).toContain("20 steps · 0.1 it/s. 1 measured.");
  expect(html).toContain("An image model reads no prompt tokens.");
  expect(html).not.toContain("Not measured");
  expect(html).not.toContain("tok/s</span>");
});

it("shows what an image or video model made in its Output cell, in place of zero tokens", () => {
  const html = render(facts([
    model({ offeringId: "art", label: "Krea 2 Turbo", calls: 17, made: { count: 17, unit: "image" } }),
    model({ offeringId: "clip", label: "Clip", calls: 1, made: { count: 1, unit: "clip" } }),
  ]));
  expect(html).toContain('>17 <span class="muted">images</span>');
  expect(html).toContain('>1 <span class="muted">clip</span>');
  expect(html).toContain("Images (or clips) its calls made");
});

it("shows a speech model's seconds of audio in its Output cell, in place of zero tokens", () => {
  const html = render(facts([
    model({ offeringId: "hear", label: "Whisper", calls: 3, audioSeconds: 42.5 }),
    model({ offeringId: "speak", label: "Kokoro", calls: 9, audioSeconds: 192 }),
    model({ offeringId: "long", label: "Long", calls: 90, audioSeconds: 5040 }),
  ]));
  expect(html).toContain('>42.5 <span class="muted">s audio</span>');
  expect(html).toContain('>3.2 <span class="muted">min audio</span>');
  expect(html).toContain('>1.4 <span class="muted">h audio</span>');
  expect(html).toContain("Seconds of audio its calls heard (Dictation) or spoke (Read aloud)");
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
  const h = buckets(f);
  expect(h).toHaveLength(24);
  expect(new Date(h[23]!).toISOString()).toBe("2026-10-24T12:00:00.000Z");
  expect(bucketed(f, seriesOf(f.models, "light", "#888888"))).toEqual([
    { hour: h[23], model: "a", calls: 2, tokens: 35 },
    { hour: h[0], model: "a", calls: 1, tokens: 0 },
  ]);
});

it("starts the speed chart's time axis at the window's start, so a call before the first whole hour stays right of the axis", () => {
  const f = facts([model({ offeringId: "a" })], [{ at: "2026-10-23T12:10:00Z", offeringId: "a", task: "chat", tokPerSec: 40 }]);
  const x = (speedSpec(seriesOf(f.models, "light", "#888888"), f, "#ffffff").encoding.x.scale);
  expect(x.domain).toEqual(["2026-10-23T12:30:00.000Z", "2026-10-24T13:00:00.000Z"]);
  expect(x.padding).toBeGreaterThan(0);
});

it("draws a week in 28 six-hour bars and a month in 30 days, on the user's clock", () => {
  const until = "2026-10-24T12:30:00Z";
  const week = { from: "2026-10-17T12:30:00Z", until }, month = { from: "2026-09-24T12:30:00Z", until };
  expect(bucketSize(week)).toBe(6 * 3_600_000);
  expect(buckets(week).map((w) => new Date(w).toISOString()).slice(-2)).toEqual(["2026-10-24T06:00:00.000Z", "2026-10-24T12:00:00.000Z"]);
  expect(buckets(week)).toHaveLength(28);
  expect(bucketSize(month)).toBe(86_400_000);
  expect(buckets(month)).toHaveLength(30);
  expect(new Date(buckets(month)[29]!).toISOString()).toBe("2026-10-24T00:00:00.000Z");
  const f = facts([model({ offeringId: "a" })], [
    { at: "2026-10-24T01:00:00Z", offeringId: "a", task: "chat", outputTokens: 3 },
    { at: "2026-10-23T23:00:00Z", offeringId: "a", task: "chat", outputTokens: 4 },
  ]);
  const days = bucketed({ ...f, ...month }, seriesOf(f.models, "light", "#888888"));
  expect(days.map((r) => [new Date(r.hour).toISOString().slice(0, 10), r.calls, r.tokens])).toEqual([["2026-10-24", 1, 3], ["2026-10-23", 1, 4]]);
  // A narrowed span asks for itself; the last 24 hours asks for nothing, lyricad's default.
  expect(factsQuery({ days: 1 })).toBe("");
  expect(factsQuery({ days: 7 }, Date.parse(until))).toBe(`?from=${encodeURIComponent("2026-10-17T12:30:00.000Z")}`);
  expect(factsQuery({ days: 30, span: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-03T00:00:00.000Z" } })).toBe("?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-03T00%3A00%3A00.000Z");
  expect(unwall(wall(until))).toBe(Date.parse(until));
});

it("heads a narrowed span with its dates and offers the three windows", () => {
  const html = renderToStaticMarkup(createElement(ModelCallFacts, { facts: { ...facts([model({ offeringId: "a" })]), from: "2026-10-20T00:00:00Z", since: "2026-10-20T00:00:00Z", until: "2026-10-22T00:00:00Z" },
    window: { days: 30, span: { from: "2026-10-20T00:00:00Z", to: "2026-10-22T00:00:00Z" } }, onWindow: () => {} }));
  // Day first, as the axes and tips read it, with only the digits in mono.
  expect(html).toContain('Model calls · <span class="num">20</span> Oct <span class="num">00:00</span> – <span class="num">22</span> Oct <span class="num">00:00</span>');
  expect(html).toContain(">Clear</button>");
  for (const name of ["Last 24 hours", "Last 7 days", "Last 30 days"]) expect(html).toContain(`aria-label="${name}"`);
  expect(html).not.toContain('aria-pressed="true"');
  expect(html).toContain("Calls per 6 hours");
});
