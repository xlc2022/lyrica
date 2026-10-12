// A message's time in its header line, and the tooltip with the whole date (web/src/ui.tsx).
// The date follows the reader's locale ("11 Oct" or "Oct 11"), so the checks look at its shape.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fullTime, wakeTime } from "../src/ui.tsx";

// Local times, so the checks hold in any time zone.
const at = (month: number, day: number, hour: number, minute: number) => new Date(2026, month - 1, day, hour, minute);

describe("a message's time", () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 9, 12, 16, 0) }); });
  afterEach(() => { vi.useRealTimers(); });

  it("is HH:MM for today, with a leading zero", () => {
    expect(wakeTime(at(10, 12, 14, 32).toISOString())).toBe("14:32");
    expect(wakeTime(at(10, 12, 9, 5).toISOString())).toBe("09:05");
  });

  it("has the day and month before it on another day, even just past midnight", () => {
    const yesterday = wakeTime(at(10, 11, 14, 32).toISOString());
    expect(yesterday).toMatch(/ 14:32$/);
    expect(yesterday).toContain("11");
    const tomorrow = wakeTime(at(10, 13, 0, 1).toISOString());
    expect(tomorrow).toMatch(/ 00:01$/);
    expect(tomorrow).toContain("13");
  });

  it("has the weekday, the whole date and the 24-hour time as its tooltip, whatever the day", () => {
    for (const d of [at(10, 12, 14, 32), at(10, 11, 9, 5), at(1, 3, 23, 59)]) {
      const tip = fullTime(d.toISOString());
      expect(tip).toContain(d.toLocaleDateString([], { weekday: "long" }));
      expect(tip).toContain("2026");
      expect(tip).toContain(String(d.getDate()));
      expect(tip).toMatch(new RegExp(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}$`));
    }
  });
});
