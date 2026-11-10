import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RoutineInfo } from "../src/api.ts";
import { ScheduledMarker } from "../src/Messages.tsx";
import { nextRoutine, RoutineRows, RoutinesFact } from "../src/Routines.tsx";

const routine = (id: number, nextAt: string, paused = false): RoutineInfo => ({ id, nextAt, paused, pool: "general", threadId: "checks", threadTitle: "Checks", newThread: false, schedule: "Daily at 08:00" });
describe("routine facts", () => {
  it("shows a collapsed Routine ran marker with the schedule and no note", () => {
    const html = renderToStaticMarkup(createElement(ScheduledMarker, { text: "A synthetic private note.", schedule: "Weekdays at 08:00", n: 2, env: {} as never }));
    expect(html).toContain('data-type="routine"');
    expect(html).toContain('id="m-2"');
    expect(html).toContain('Routine ran');
    expect(html).toContain('Weekdays');
    expect(html).toContain('class="num">08:00');
    expect(html).not.toContain('synthetic private note');
    expect(html).not.toContain('Woke up');
  });
  it("shows the earliest active time, leaving paused routines out without changing the list", () => {
    const rows = [routine(1, "2026-01-01T08:00:00Z", true), routine(2, "2026-01-03T08:00:00Z"), routine(3, "2026-01-02T08:00:00Z")];
    expect(nextRoutine(rows)?.id).toBe(3);
    expect(rows.map(r => r.id)).toEqual([1, 2, 3]);
    const html = renderToStaticMarkup(createElement(RoutinesFact, { userId: "user", routines: rows, onChange: () => {} }));
    expect(html).toContain('class="num"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Paused");
  });
  it("keeps the popover control when every routine is paused", () => {
    const rows = [routine(1, "2026-01-01T08:00:00Z", true)];
    expect(nextRoutine(rows)).toBeUndefined();
    const html = renderToStaticMarkup(createElement(RoutinesFact, { userId: "user", routines: rows, onChange: () => {} }));
    expect(html).toContain('class="muted">Paused');
    expect(html).not.toContain('class="num"');
  });
  it("shows explicit titles and described purpose tooltips in both surfaces, with independent legacy fallbacks", () => {
    const base = routine(1, "2026-01-01T08:00:00Z");
    for (const linked of [false, true]) {
      const html = renderToStaticMarkup(createElement(RoutineRows, { userId: "user", routines: [
        { ...base, title: "Garden check", description: "Reviews the watering plan." },
        { ...base, id: 2, title: "Build digest", newThread: true },
        { ...base, id: 3, description: "An explicit purpose without a title." },
        { ...base, id: 4 },
      ], linked, onChange: () => {} }));
      expect(html).toContain("Garden check");
      expect(html).toContain('role="tooltip"');
      expect(html).toContain('aria-describedby=');
      expect(html).toContain('tabindex="0"');
      expect(html).toContain("Reviews the watering plan.");
      expect(html).toContain("Runs the saved instructions in a new thread.");
      expect(html).toContain("An explicit purpose without a title.");
      expect(html).toContain("Runs the saved instructions here.");
      expect(html).toContain('Routine <span class="num">4</span>');
      expect(html).not.toContain("Checks · Routine");
      expect(html).toContain('aria-label="Remove routine 4"');
      expect(html.includes("href=")).toBe(linked);
    }
  });
  it("shows Paused muted in the popover rows, linked or not", () => {
    const html = renderToStaticMarkup(createElement(RoutineRows, { userId: "user", routines: [routine(1, "2026-01-01T08:00:00Z", true), routine(2, "2026-01-02T08:00:00Z")], onChange: () => {} }));
    expect(html.match(/class="muted">Paused/g)).toHaveLength(1);
    expect(html.match(/class="num"/g)).toBeTruthy();
  });
});
