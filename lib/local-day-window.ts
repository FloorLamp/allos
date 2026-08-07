// Profile-local DAY attribution over a UTC instant column (issue #2205 phase 1,
// the read-time half of the hr_minutes conversion).
//
// THE QUESTION. `hr_minutes.ts` stores an absolute instant. Every surface over it
// asks a DAY question — "what was my average HR on the 3rd", "give me the 3rd's
// minute buckets" — and a day is profile-local (#94), so the two are related by the
// profile's timezone AT THAT INSTANT. Before #2205 the column stored the local
// minute directly, which made `substr(ts,1,10)` a free day but froze the attribution
// at ingest: change the profile's timezone and every historical row silently meant a
// different local minute than the one it was written with. Deriving the day at READ
// time is what removes that.
//
// THE CONSTRAINT. Doing it naively costs the #387 bound. `getHrDailySummary`
// aggregates in SQL — AVG/MIN/MAX/COUNT grouped per day — over up to 180 days of
// all-day wearable data (~260k rows). Grouping in JS instead would stream every one
// of those rows out of SQLite on a Trends render, which is precisely the unbounded
// scan #387 removed. A per-row SQL user function would keep the grouping in SQL but
// pay an Intl call per row, which is the same cost wearing a different hat.
//
// THE RESOLUTION. A zone's UTC offset is not arbitrary — it is PIECEWISE CONSTANT,
// changing at most a couple of times a year. Inside one such piece the local day is
// exactly `date(ts, '±HH:MM')`, a fixed-offset SQLite modifier that is both exact and
// index-friendly. So a window is split into offset-constant SEGMENTS (typically one,
// at most three for a 180-day window), each aggregated in SQL under its own modifier,
// and the segments are concatenated. Correct across DST because the split lands ON
// the transition; fast because the row work stays in SQLite.
//
// This module is PURE — Intl only, no DB, no clock. `lib/queries/metrics.ts` is its
// caller; the SQL stays there, inline, as the repo's convention requires.

import {
  dateStrInTz,
  parseUtcSql,
  tzOffsetMs,
  zonedWallTimeToUtc,
} from "./date";

// One stretch of a window over which the zone's UTC offset does not change.
// `startUtc` is inclusive, `endUtc` exclusive, both canonical instants.
export interface OffsetSegment {
  startUtc: string;
  endUtc: string;
  // Minutes east of UTC (New York in winter is -300).
  offsetMinutes: number;
  // The same offset as SQLite's date/time modifier, e.g. '-05:00'.
  modifier: string;
}

// A UTC offset in minutes as the modifier SQLite applies to a datetime, so
// `date(ts, modifier)` yields the local calendar day. Whole minutes only, which is
// every real zone (the historical sub-minute offsets predate any stored reading).
export function offsetModifier(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function offsetMinutesAt(tz: string, at: Date): number {
  return Math.round(tzOffsetMs(tz, at) / 60_000);
}

const DAY_MS = 86_400_000;

// The first instant after `from` (and at or before `limit`) at which the zone's UTC
// offset changes, or null when it never does inside the window.
//
// NOT a plain binary search between the endpoints. The offset is a step function that
// steps BACK as well as forward, so a year-long window can begin and end on the same
// offset with two transitions inside it — comparing only the endpoints would report
// "no change" and silently mis-attribute half a year of days. Instead: scan forward a
// DAY at a time until the offset differs from the starting one, then binary-search
// that single day down to the second. The only assumption is that no zone changes
// offset twice within 24 hours, which no real zone does — DST pairs are months apart.
// Cost is one cached-formatter Intl call per probe: ~365/year scanned plus ~17 to
// land the edge, against a query that aggregates hundreds of thousands of rows.
function nextTransition(
  tz: string,
  from: number,
  limit: number
): number | null {
  const base = offsetMinutesAt(tz, new Date(from));
  let a = from;
  while (a < limit) {
    const b = Math.min(a + DAY_MS, limit);
    if (offsetMinutesAt(tz, new Date(b)) !== base) {
      // Invariant: offset(lo) === base, offset(hi) !== base.
      let lo = a;
      let hi = b;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (offsetMinutesAt(tz, new Date(mid)) === base) lo = mid;
        else hi = mid;
      }
      return hi;
    }
    a = b;
  }
  return null;
}

// Split [startUtc, endUtc) into stretches of constant UTC offset. An ordinary window
// yields ONE segment; a window straddling a DST change yields one per side.
//
// SAFETY VALVE: a zone with pathological history (or a caller passing a decade-long
// window) could in principle produce many segments, and each costs a SQL round trip.
// The search is bounded — after `maxSegments` splits the remainder is returned as one
// segment under its starting offset. That degrades day attribution at the far edge of
// an absurd window rather than issuing unbounded queries; every window the app
// actually asks for is far inside the bound.
export function offsetSegments(
  tz: string,
  startUtc: string,
  endUtc: string,
  maxSegments = 8
): OffsetSegment[] {
  const lo = parseUtcSql(startUtc)?.getTime();
  const hi = parseUtcSql(endUtc)?.getTime();
  if (lo == null || hi == null || !(hi > lo)) return [];
  const out: OffsetSegment[] = [];
  let cursor = lo;
  while (cursor < hi && out.length < maxSegments - 1) {
    const offsetMinutes = offsetMinutesAt(tz, new Date(cursor));
    const cut = nextTransition(tz, cursor, hi);
    const segEnd = cut ?? hi;
    out.push({
      startUtc: instant(cursor),
      endUtc: instant(segEnd),
      offsetMinutes,
      modifier: offsetModifier(offsetMinutes),
    });
    cursor = segEnd;
  }
  if (cursor < hi) {
    const offsetMinutes = offsetMinutesAt(tz, new Date(cursor));
    out.push({
      startUtc: instant(cursor),
      endUtc: instant(hi),
      offsetMinutes,
      modifier: offsetModifier(offsetMinutes),
    });
  }
  return out;
}

function instant(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

// The half-open UTC range [startUtc, endUtc) covering profile-local day `date`.
// Half-open on purpose: a local day is 23, 24 or 25 hours long depending on DST, and
// an inclusive upper bound would have to name the last stored minute, which depends
// on the column's grain. `zonedWallTimeToUtc` settles each edge against the offset in
// force AT that edge, so both a spring-forward and a fall-back day come out right.
export function localDayRange(
  tz: string,
  date: string
): { startUtc: string; endUtc: string } {
  return localDaySpan(tz, date, date);
}

// The half-open UTC range covering the inclusive local-day span `from`..`to`.
export function localDaySpan(
  tz: string,
  from: string,
  to: string
): { startUtc: string; endUtc: string } {
  const start = zonedWallTimeToUtc(tz, from, "00:00");
  const nextDay = new Date(`${to}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const end = zonedWallTimeToUtc(
    tz,
    nextDay.toISOString().slice(0, 10),
    "00:00"
  );
  // Both edges are local midnight on a real calendar day, so the refusal arm is
  // unreachable for a well-formed `from`/`to`. It is stated rather than asserted
  // because the alternative — an Invalid Date reaching `instant()` — would produce a
  // range that silently matches nothing.
  if (!start || !end)
    throw new Error(
      `localDaySpan: unresolvable local day range ${from}..${to}`
    );
  return { startUtc: instant(start.getTime()), endUtc: instant(end.getTime()) };
}

// The profile-local day a stored instant belongs to. The single-row companion to the
// segment machinery above — used where the row count is already bounded (a picked
// minute list, the newest row) and a SQL GROUP BY is not in play.
export function localDayOf(tz: string, ts: string): string | null {
  const d = parseUtcSql(ts);
  return d ? dateStrInTz(tz, d) : null;
}
