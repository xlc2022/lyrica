// Routines' schedule maths (docs/briefs/routines.md part A): when a routine runs
// next, in its user's time zone (core/src/zone.ts). Pure; firing and storage live
// in the daemon. A wall time skipped by a spring-forward fires at the next valid
// minute; one that comes twice in a fall-back fires once, at its first occurrence.
import { serverZone, wall, zonedTime } from "./zone.ts";

export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "yearly"; date: string; time: string }
  | { kind: "every"; hours: number; from: string };

const HOUR_MS = 3_600_000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{2})-(\d{2})$/;
// February keeps its 29th: a routine set for it runs on the 28th in other years.
const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** A schedule from JSON (the routines table's column): checked, or a short Error. */
export function parseSchedule(input: unknown): Schedule {
  if (typeof input !== "object" || input === null) throw new Error("a schedule is an object");
  const o = input as Record<string, unknown>;
  switch (o.kind) {
    case "daily": return { kind: "daily", time: parseTime(o.time) };
    case "weekdays": return { kind: "weekdays", time: parseTime(o.time) };
    case "weekly": {
      const day = o.day;
      if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) throw new Error("a weekly schedule's day is 0 (Sunday) to 6 (Saturday)");
      return { kind: "weekly", day, time: parseTime(o.time) };
    }
    case "yearly": return { kind: "yearly", date: parseDate(o.date), time: parseTime(o.time) };
    case "every": {
      const hours = o.hours;
      if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error("an every schedule's hours is a whole number from 1 to 168");
      return { kind: "every", hours, from: parseFrom(o.from) };
    }
    default: throw new Error(`unknown schedule kind ${JSON.stringify(o.kind ?? null)}`);
  }
}

/** The first run strictly after `after`, in `zone` (the server's when left out). */
export function nextRun(schedule: Schedule, after: Date, zone = serverZone()): Date {
  const afterMs = after.getTime();
  if (schedule.kind === "every") {
    // Absolute milliseconds from when it was set: no DST adjustment.
    const step = schedule.hours * HOUR_MS;
    const fromMs = Date.parse(schedule.from);
    let t = fromMs + Math.max(0, Math.ceil((afterMs - fromMs) / step)) * step;
    if (t <= afterMs) t += step;
    return new Date(t);
  }
  const [hh, mm] = timeParts(parseTime(schedule.time));
  // Walk the zone's calendar days from `after`'s own until one runs later than it.
  const w = wall(after, zone);
  for (let i = 0; i < 800; i++) {
    const day = new Date(Date.UTC(w.year, w.month - 1, w.day + i));
    if (!runsOn(schedule, day)) continue;
    const t = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, zone);
    if (t > afterMs) return new Date(t);
  }
  throw new Error("the schedule never runs"); // unreachable: every kind runs within a year
}

/** The words the facts line shows, such as "Weekdays at 08:00". */
export function describe(schedule: Schedule): string {
  switch (schedule.kind) {
    case "daily": return `Daily at ${schedule.time}`;
    case "weekdays": return `Weekdays at ${schedule.time}`;
    case "weekly": return `${WEEKDAYS[schedule.day]} at ${schedule.time}`;
    case "yearly": {
      const [month, day] = dateParts(schedule.date);
      return `Yearly on ${day} ${MONTHS[month - 1]} at ${schedule.time}`;
    }
    case "every": return schedule.hours === 1 ? "Every hour" : `Every ${schedule.hours} hours`;
  }
}

/** Whether the schedule's kind picks this calendar day, a UTC midnight (yearly keeps its leap-day rule). */
function runsOn(schedule: Schedule, day: Date): boolean {
  switch (schedule.kind) {
    case "daily": return true;
    case "weekdays": { const w = day.getUTCDay(); return w >= 1 && w <= 5; }
    case "weekly": return day.getUTCDay() === schedule.day;
    case "yearly": {
      const [month, date] = dateParts(schedule.date);
      if (day.getUTCMonth() + 1 !== month) return false;
      // A routine set for 29 February runs on the 28th when it isn't a leap year.
      return day.getUTCDate() === date || (month === 2 && date === 29 && !leap(day.getUTCFullYear()) && day.getUTCDate() === 28);
    }
    case "every": return false; // handled before the day walk
  }
}

const leap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

/** A schedule's "HH:MM", or a short Error. */
function parseTime(time: unknown): string {
  if (typeof time !== "string" || !TIME.test(time)) throw new Error(`a schedule's time is HH:MM, not ${JSON.stringify(time ?? null)}`);
  return time;
}

const timeParts = (time: string): [number, number] => TIME.exec(time)!.slice(1, 3).map(Number) as [number, number];

/** A yearly schedule's "MM-DD", or a short Error. */
function parseDate(date: unknown): string {
  const [month, day] = dateParts(date);
  if (day > MONTH_LENGTHS[month - 1]!) throw new Error(`${JSON.stringify(date)} is not a date`);
  return date as string;
}

function dateParts(date: unknown): [number, number] {
  const m = typeof date === "string" ? DATE.exec(date) : null;
  if (!m) throw new Error(`a yearly schedule's date is MM-DD, not ${JSON.stringify(date ?? null)}`);
  const month = Number(m[1]), day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1) throw new Error(`${JSON.stringify(date)} is not a date`);
  return [month, day];
}

/** An every schedule's `from`: an ISO timestamp, or a short Error. */
function parseFrom(from: unknown): string {
  // Require an instant, not Date.parse's loose dates or a zone-dependent time.
  const m = typeof from === "string" ? /^(\d{4})-(\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(from) : null;
  if (typeof from !== "string" || !m || Number.isNaN(Date.parse(from))) throw new Error("an every schedule's from is an ISO timestamp with a time zone");
  const [month, day] = dateParts(parseDate(m[2]));
  if (month === 2 && day === 29 && !leap(Number(m[1]))) throw new Error("an every schedule's from is not a date");
  return from;
}
