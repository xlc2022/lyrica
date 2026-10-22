import { afterAll, describe, expect, it } from "vitest";
import { describe as describeSchedule, nextRun, parseSchedule } from "../src/routines.ts";

// Set before any Date is built: the maths runs in the process's local zone.
const originalTZ = process.env.TZ;
process.env.TZ = "America/New_York";
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const schedule = parseSchedule;

describe("parseSchedule", () => {
  it("takes each kind as it stands", () => {
    expect(schedule({ kind: "daily", time: "08:00" })).toEqual({ kind: "daily", time: "08:00" });
    expect(schedule({ kind: "weekdays", time: "08:05" })).toEqual({ kind: "weekdays", time: "08:05" });
    expect(schedule({ kind: "weekly", day: 1, time: "09:30" })).toEqual({ kind: "weekly", day: 1, time: "09:30" });
    expect(schedule({ kind: "yearly", date: "02-29", time: "07:00" })).toEqual({ kind: "yearly", date: "02-29", time: "07:00" });
    expect(schedule({ kind: "every", hours: 6, from: "2026-10-12T00:00:00.000Z" })).toEqual({ kind: "every", hours: 6, from: "2026-10-12T00:00:00.000Z" });
    expect(schedule({ kind: "weekly", day: 0, time: "00:00" })).toEqual({ kind: "weekly", day: 0, time: "00:00" });
    expect(schedule({ kind: "every", hours: 168, from: "2026-10-12T00:00:00Z" })).toEqual({ kind: "every", hours: 168, from: "2026-10-12T00:00:00Z" });
    expect(schedule({ kind: "every", hours: 1, from: "2028-02-29T08:05:00+05:30" })).toEqual({ kind: "every", hours: 1, from: "2028-02-29T08:05:00+05:30" });
  });

  it("refuses anything else, with a short message", () => {
    const bad = [
      null, "daily", 7, [],
      { kind: "hourly", time: "08:00" },
      { kind: "daily" },
      { kind: "daily", time: "8:00" },
      { kind: "daily", time: "24:00" },
      { kind: "daily", time: "08:60" },
      { kind: "weekdays", time: "08:00:00" },
      { kind: "weekly", day: 7, time: "09:30" },
      { kind: "weekly", day: -1, time: "09:30" },
      { kind: "weekly", day: 1.5, time: "09:30" },
      { kind: "weekly", day: "1", time: "09:30" },
      { kind: "yearly", date: "13-01", time: "07:00" },
      { kind: "yearly", date: "02-30", time: "07:00" },
      { kind: "yearly", date: "04-31", time: "07:00" },
      { kind: "yearly", date: "00-10", time: "07:00" },
      { kind: "yearly", date: "2-01", time: "07:00" },
      { kind: "yearly", date: "01-00", time: "07:00" },
      { kind: "yearly", date: "01-32", time: "07:00" },
      { kind: "yearly", date: "12-31", time: null },
      { kind: "weekly", time: "09:30" },
      { kind: "weekly", day: NaN, time: "09:30" },
      { kind: "every", hours: 0, from: "2026-10-12T00:00:00Z" },
      { kind: "every", hours: 169, from: "2026-10-12T00:00:00Z" },
      { kind: "every", hours: 2.5, from: "2026-10-12T00:00:00Z" },
      { kind: "every", hours: NaN, from: "2026-10-12T00:00:00Z" },
      { kind: "every", hours: 6, from: "yesterday" },
      { kind: "every", hours: 6, from: "" },
      { kind: "every", hours: "6", from: "2026-10-12T00:00:00Z" },
      ...[
        undefined, 42, "2026-10-12", "10/12/2026", "2026-10-12T08:00:00",
        "2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z",
        "2026-10-12T24:00:00Z", "2026-10-12T00:00:00+24:00",
      ].map((from) => ({ kind: "every", hours: 6, from })),
    ];
    for (const input of bad) expect(() => parseSchedule(input), JSON.stringify(input)).toThrow(Error);
  });
});

describe("nextRun", () => {
  it("daily: the next time it comes, and tomorrow's when `after` is exactly at it", () => {
    const s = schedule({ kind: "daily", time: "08:00" });
    expect(nextRun(s, new Date(2026, 9, 12, 7, 0))).toEqual(new Date(2026, 9, 12, 8, 0));
    expect(nextRun(s, new Date(2026, 9, 12, 8, 0))).toEqual(new Date(2026, 9, 13, 8, 0));
    expect(nextRun(s, new Date(2026, 9, 12, 8, 0, 0, 1))).toEqual(new Date(2026, 9, 13, 8, 0));
  });

  it("weekdays: the same day on a weekday, Monday over the weekend", () => {
    const s = schedule({ kind: "weekdays", time: "08:00" });
    expect(nextRun(s, new Date(2026, 9, 12, 7, 0))).toEqual(new Date(2026, 9, 12, 8, 0)); // Monday before its time
    expect(nextRun(s, new Date(2026, 9, 9, 9, 0))).toEqual(new Date(2026, 9, 12, 8, 0)); // Friday after → Monday
    expect(nextRun(s, new Date(2026, 9, 10, 0, 0))).toEqual(new Date(2026, 9, 12, 8, 0)); // Saturday
    expect(nextRun(s, new Date(2026, 9, 11, 23, 0))).toEqual(new Date(2026, 9, 12, 8, 0)); // Sunday
  });

  it("weekly: the next such day, wrapping past the end of the week", () => {
    const mondays = schedule({ kind: "weekly", day: 1, time: "09:30" });
    expect(nextRun(mondays, new Date(2026, 9, 12, 9, 0))).toEqual(new Date(2026, 9, 12, 9, 30)); // Monday before its time
    expect(nextRun(mondays, new Date(2026, 9, 12, 9, 30))).toEqual(new Date(2026, 9, 19, 9, 30)); // exactly at it → next week
    expect(nextRun(mondays, new Date(2026, 9, 14, 12, 0))).toEqual(new Date(2026, 9, 19, 9, 30)); // Wednesday
    const sundays = schedule({ kind: "weekly", day: 0, time: "10:00" });
    expect(nextRun(sundays, new Date(2026, 9, 12, 8, 0))).toEqual(new Date(2026, 9, 18, 10, 0)); // Monday → Sunday's wrap
  });

  it("all seven weekly days and all weekdays advance strictly past a run", () => {
    for (let day = 0; day < 7; day++) {
      const run = new Date(2026, 9, 11 + day, 8);
      const weekly = schedule({ kind: "weekly", day, time: "08:00" });
      expect(nextRun(weekly, new Date(run.getTime() - 1))).toEqual(run);
      expect(nextRun(weekly, run)).toEqual(new Date(2026, 9, 18 + day, 8));
      const weekdays = schedule({ kind: "weekdays", time: "08:00" });
      const nextDay = day === 0 ? 12 : day === 5 || day === 6 ? 19 : 12 + day;
      expect(nextRun(weekdays, run)).toEqual(new Date(2026, 9, nextDay, 8));
    }
  });

  it("yearly: this year before its date, next year after", () => {
    const s = schedule({ kind: "yearly", date: "07-04", time: "06:00" });
    expect(nextRun(s, new Date(2026, 6, 4, 5, 0))).toEqual(new Date(2026, 6, 4, 6, 0));
    expect(nextRun(s, new Date(2026, 6, 4, 6, 0))).toEqual(new Date(2027, 6, 4, 6, 0));
  });

  it("yearly 29 February: the 29th in a leap year, the 28th otherwise", () => {
    const s = schedule({ kind: "yearly", date: "02-29", time: "07:00" });
    expect(nextRun(s, new Date(2028, 0, 1))).toEqual(new Date(2028, 1, 29, 7, 0)); // leap year
    expect(nextRun(s, new Date(2027, 0, 1))).toEqual(new Date(2027, 1, 28, 7, 0)); // common year
    expect(nextRun(s, new Date(2028, 1, 29, 7, 0))).toEqual(new Date(2029, 1, 28, 7, 0)); // after the leap day itself
    expect(nextRun(s, new Date(2100, 0, 1))).toEqual(new Date(2100, 1, 28, 7, 0)); // a century that isn't leap
    expect(nextRun(s, new Date(2027, 1, 28, 7))).toEqual(new Date(2028, 1, 29, 7));
    expect(nextRun(s, new Date(2000, 0, 1))).toEqual(new Date(2000, 1, 29, 7)); // divisible by 400
  });

  it("every N hours: counted from when it was set", () => {
    const from = "2026-10-12T00:00:00.000Z";
    const s = schedule({ kind: "every", hours: 6, from });
    expect(nextRun(s, new Date(Date.UTC(2026, 9, 12, 7, 0))).toISOString()).toBe("2026-10-12T12:00:00.000Z");
    expect(nextRun(s, new Date(Date.UTC(2026, 9, 12, 6, 0))).toISOString()).toBe("2026-10-12T12:00:00.000Z"); // exactly at a run → the next
    expect(nextRun(s, new Date(Date.UTC(2026, 9, 11, 23, 0))).toISOString()).toBe(from); // before it was set
    const weekly = schedule({ kind: "every", hours: 168, from });
    expect(nextRun(weekly, new Date(Date.UTC(2026, 9, 18, 12, 0))).toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(nextRun(s, new Date(from)).toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(nextRun(s, new Date(Date.parse(from) + 6 * 3_600_000 - 1)).toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(nextRun(s, new Date(Date.parse(from) + 6 * 3_600_000 + 1)).toISOString()).toBe("2026-10-12T12:00:00.000Z");
  });

  it("every N hours keeps its anchor and elapsed hours through both DST changes", () => {
    for (const from of ["2026-03-08T01:15:00-05:00", "2026-11-01T00:15:00-04:00"]) {
      const s = schedule({ kind: "every", hours: 1, from });
      for (let n = 0; n < 4; n++) {
        const after = new Date(Date.parse(from) + n * 3_600_000);
        expect(nextRun(s, after).getTime()).toBe(after.getTime() + 3_600_000);
      }
    }
  });

  it("every N hours preserves the minutes, seconds and milliseconds of from", () => {
    const s = schedule({ kind: "every", hours: 6, from: "2026-10-12T08:17:23.456+05:30" });
    expect(nextRun(s, new Date("2026-10-12T08:47:23.455Z")).toISOString()).toBe("2026-10-12T08:47:23.456Z");
    expect(nextRun(s, new Date("2026-10-12T08:47:23.456Z")).toISOString()).toBe("2026-10-12T14:47:23.456Z");
  });

  it("spring forward: a skipped 02:30 fires at the next valid minute", () => {
    const s = schedule({ kind: "daily", time: "02:30" });
    expect(nextRun(s, new Date(2026, 2, 7, 0, 0))).toEqual(new Date(2026, 2, 7, 2, 30)); // the day before is normal
    const fired = nextRun(s, new Date(2026, 2, 8, 0, 0)); // 2026-03-08: clocks jump 02:00 → 03:00
    expect(fired).toEqual(new Date(2026, 2, 8, 3, 0));
    expect(fired.getTime()).toBe(Date.UTC(2026, 2, 8, 7, 0));
    const weekdays = schedule({ kind: "weekdays", time: "02:15" });
    expect(nextRun(weekdays, new Date(2026, 2, 6, 12, 0))).toEqual(new Date(2026, 2, 9, 2, 15)); // the spring-forward Sunday is a weekend anyway; Monday runs normally
  });

  it("fall back: a repeated 01:30 fires once, at its first occurrence", () => {
    const s = schedule({ kind: "daily", time: "01:30" });
    const fired = nextRun(s, new Date(2026, 10, 1, 0, 0)); // 2026-11-01: clocks fall back at 02:00 EDT
    expect(fired.getTime()).toBe(Date.UTC(2026, 10, 1, 5, 30)); // the first reading (EDT), not the second
    expect(nextRun(s, fired)).toEqual(new Date(2026, 10, 2, 1, 30)); // once that one is past: tomorrow's, not today's repeat
    expect(nextRun(s, new Date("2026-11-01T01:15:00-05:00"))).toEqual(new Date(2026, 10, 2, 1, 30));
    expect(nextRun(s, new Date("2026-11-01T01:30:00-05:00"))).toEqual(new Date(2026, 10, 2, 1, 30));
  });

  it("weekly and yearly share the DST rules, including the firing instant cutoff", () => {
    for (const input of [
      { kind: "daily", time: "02:30" },
      { kind: "weekly", day: 0, time: "02:30" },
      { kind: "yearly", date: "03-08", time: "02:30" },
    ]) {
      const s = schedule(input);
      const fired = new Date("2026-03-08T03:00:00-04:00");
      expect(nextRun(s, new Date(fired.getTime() - 1))).toEqual(fired);
      expect(nextRun(s, fired).getTime()).toBeGreaterThan(fired.getTime());
    }
    for (const input of [
      { kind: "weekly", day: 0, time: "01:30" },
      { kind: "yearly", date: "11-01", time: "01:30" },
    ]) {
      const s = schedule(input);
      const fired = new Date("2026-11-01T01:30:00-04:00");
      expect(nextRun(s, new Date(fired.getTime() - 1))).toEqual(fired);
      expect(nextRun(s, new Date("2026-11-01T01:15:00-05:00")).getTime()).toBeGreaterThan(Date.parse("2026-11-01T02:00:00-05:00"));
    }
  });

  it("handles a half-hour DST jump in the daemon's local zone", () => {
    process.env.TZ = "Australia/Lord_Howe";
    try {
      const skipped = schedule({ kind: "daily", time: "02:15" });
      expect(nextRun(skipped, new Date("2026-10-04T01:59:00+10:30"))).toEqual(new Date("2026-10-04T02:30:00+11:00"));
      const repeated = schedule({ kind: "daily", time: "01:45" });
      const fired = new Date("2026-04-05T01:45:00+11:00");
      expect(nextRun(repeated, new Date("2026-04-05T01:00:00+11:00"))).toEqual(fired);
      expect(nextRun(repeated, fired)).toEqual(new Date("2026-04-06T01:45:00+10:30"));
    } finally {
      process.env.TZ = "America/New_York";
    }
  });

  it("runs in the user's own zone when one is given, whatever the server's", () => {
    const s = schedule({ kind: "weekdays", time: "08:00" });
    // Monday 12 Oct 2026, 23:00 in New York, is already Tuesday 05:00 in Vienna.
    const after = new Date("2026-10-12T23:00:00-04:00");
    expect(nextRun(s, after, "Europe/Vienna").toISOString()).toBe("2026-10-13T06:00:00.000Z");
    expect(nextRun(s, after, "Asia/Kolkata").toISOString()).toBe("2026-10-14T02:30:00.000Z"); // 08:30 there: Wednesday's
    expect(nextRun(s, after).toISOString()).toBe("2026-10-13T12:00:00.000Z"); // the server's zone
    // Vienna's own spring-forward skips 02:30 on 29 March 2026.
    expect(nextRun(schedule({ kind: "daily", time: "02:30" }), new Date("2026-03-29T00:00:00Z"), "Europe/Vienna").toISOString()).toBe("2026-03-29T01:00:00.000Z");
    // And its fall-back repeats 02:30 on 25 October: the first one (CEST).
    expect(nextRun(schedule({ kind: "daily", time: "02:30" }), new Date("2026-10-24T22:00:00Z"), "Europe/Vienna").toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("describe", () => {
  it("says each schedule the way the facts line shows it", () => {
    expect(describeSchedule({ kind: "daily", time: "08:00" })).toBe("Daily at 08:00");
    expect(describeSchedule({ kind: "weekdays", time: "08:00" })).toBe("Weekdays at 08:00");
    expect(describeSchedule({ kind: "weekly", day: 1, time: "09:30" })).toBe("Mondays at 09:30");
    expect(describeSchedule({ kind: "weekly", day: 0, time: "10:00" })).toBe("Sundays at 10:00");
    expect(describeSchedule({ kind: "weekly", day: 6, time: "10:00" })).toBe("Saturdays at 10:00");
    expect(describeSchedule({ kind: "yearly", date: "03-14", time: "07:00" })).toBe("Yearly on 14 Mar at 07:00");
    expect(describeSchedule({ kind: "yearly", date: "12-01", time: "09:05" })).toBe("Yearly on 1 Dec at 09:05");
    expect(describeSchedule({ kind: "every", hours: 6, from: "2026-10-12T00:00:00.000Z" })).toBe("Every 6 hours");
    expect(describeSchedule({ kind: "every", hours: 1, from: "2026-10-12T00:00:00.000Z" })).toBe("Every hour");
  });
});
