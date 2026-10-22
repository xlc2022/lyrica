// Time zones, by IANA name: each user's own (Profile.timeZone), else the server's.
// Every wall time Lyrica reads or writes for a user goes through here, so the
// model's date line, routines and sleep agree with the times the user sees.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

/** The server's own zone, which a user without one of their own gets. */
export function serverZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The zone a user's times are in. */
export const zoneOf = (p: { timeZone?: string }): string => p.timeZone ?? serverZone();

/** Whether this server knows `zone` as a time zone name, such as "Europe/Vienna". */
export function validZone(zone: string): boolean {
  if (!zone || zone !== zone.trim()) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

/** A moment's wall time in `zone`: month 1–12, weekday 0 (Sunday) to 6. */
export interface Wall { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

export function wall(at: Date | number, zone: string): Wall {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    formats.set(zone, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(at)) p[part.type] = part.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: WEEKDAYS.indexOf(p.weekday!) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" in `zone`. */
export function localDate(at: Date | number, zone: string): string {
  const w = wall(at, zone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** "HH:MM", 24-hour, in `zone`. */
export function localTime(at: Date | number, zone: string): string {
  const w = wall(at, zone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** A moment's wall time as a UTC-shaped number, to compare against. */
const wallMs = (t: number, zone: string) => { const w = wall(t, zone); return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute); };

/**
 * The moment wall time `hh:mm` on that date comes in `zone`. When a
 * spring-forward skipped it, the first minute that exists after it (the jump
 * itself); when a fall-back repeats it, its first occurrence.
 */
export function zonedTime(year: number, month: number, day: number, hh: number, mm: number, zone: string): number {
  const target = Date.UTC(year, month - 1, day, hh, mm);
  // The offsets either side of the day: a zone changes its offset at most once in that span.
  const offsets = [...new Set([target - DAY_MS, target, target + DAY_MS].map((t) => wallMs(t, zone) - t))];
  const hits = offsets.map((o) => target - o).filter((t) => wallMs(t, zone) === target);
  if (hits.length) return Math.min(...hits);
  // Skipped: binary-search the jump, between the two offsets' readings of the target.
  let lo = target - Math.max(...offsets);
  let hi = target - Math.min(...offsets);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (wallMs(mid, zone) >= target) hi = mid; else lo = mid;
  }
  return hi;
}
