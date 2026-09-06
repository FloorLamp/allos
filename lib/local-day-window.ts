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
// A ZONE THAT MOVED IS THE SAME SHAPE AS A ZONE THAT CHANGED OFFSET (#3428 item 5).
// The segments above exist because a zone's offset is piecewise constant; a profile
// that TRAVELLED has a second source of pieces, and the day bucketing cannot tell the
// two apart because it never needed to: `date(ts, modifier)` asks only for the offset
// in force at the row's instant. So every entry point here takes a `ProfileDayZone` —
// a plain IANA name for the overwhelming case of a profile that has never moved, or
// the recorded resolver for one that has — and the offset probe reads the zone in
// force AT the probed instant. A switch then falls out as one more boundary, with no
// mechanism added for it: the day either side of a move is that side's own
// midnight-to-midnight, which is what the header's "AT THAT INSTANT" always claimed.
//
// This module is PURE — Intl only, no DB, no clock. `lib/queries/metrics.ts` is its
// caller; the SQL stays there, inline, as the repo's convention requires.

import {
  dateStrInTz,
  parseUtcSql,
  shiftDateStr,
  tzOffsetMs,
  zonedWallTimeToUtc,
} from "./date";
import { zoneOf, type ProfileDayZone } from "./travel-timezone";

// One stretch of a window over which the zone's UTC offset does not change.
// `startUtc` is inclusive, `endUtc` exclusive, both canonical instants.
export interface OffsetSegment {
  startUtc: string;
  endUtc: string;
  // The same two edges as epoch milliseconds, at full precision — the strings above
  // are truncated to whole seconds, which every real boundary already falls on.
  // Carried rather than re-parsed: every consumer below needs them as numbers, and
  // re-deriving them from the strings makes each one write a fallback for a parse
  // that cannot fail.
  startMs: number;
  endMs: number;
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

// The UTC offset the profile's day was running on AT `at` — the zone in force then,
// asked at that instant, not the zone it is standing in now.
function offsetMinutesAt(zone: ProfileDayZone, at: Date): number {
  return Math.round(tzOffsetMs(zoneOf(zone, at), at) / 60_000);
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
// that single day down to the MILLISECOND. The only assumption is that no zone changes
// offset twice within 24 hours, which no real zone does — DST pairs are months apart.
// Cost is one cached-formatter Intl call per probe: ~365/year scanned plus ~27 to
// land the edge, against a query that aggregates hundreds of thousands of rows.
//
// THE EXACT EDGE IS HELD HERE, NOT RESTORED DOWNSTREAM. The search used to stop at a
// 1000 ms interval and return its upper bound, which is the first probe KNOWN to carry
// the new offset — so the returned cut sat somewhere in [transition, transition+1000).
// No output ever differed: `offsetSegments` emits every boundary through `instant()`,
// which truncates to whole seconds, and a real zone transition falls on a whole second,
// so a cut anywhere in that window truncates back down onto the transition. The
// segments and the minutes `localMinuteProjector` derives from them were byte-identical
// at 999, 1000 and 1001 ms.
//
// So this is not a bug fix. It moves the exactness into the search, where the comments
// downstream already claim it is: `localMinuteProjector` says it relies on a
// "millisecond-exact cut", and what actually made it exact was a truncation two steps
// away that any future caller reading the cut at a finer grain — or before it is
// truncated — would bypass without noticing. The loop now ends with offset(lo) === base,
// offset(hi) !== base and hi === lo + 1, so `hi` IS the transition instant. Cost is
// about ten more cached-Intl probes per transition found.
//
// A RECORDED TRAVEL SWITCH IS FOUND BY THE SAME SEARCH (#3428). It is a step in the
// same offset function, so nothing here knows or cares which kind of step it is, and
// the binary search lands it to the millisecond exactly as it lands a DST cut. The
// day-at-a-time scan carries its one standing assumption across unchanged: no more
// than one offset change per 24 hours. DST pairs are months apart; a traveller who
// leaves and returns inside a single day is the case that assumption now admits, and
// that stretch keeps the offset it started on rather than gaining two pieces.
function nextTransition(
  zone: ProfileDayZone,
  from: number,
  limit: number
): number | null {
  const base = offsetMinutesAt(zone, new Date(from));
  let a = from;
  while (a < limit) {
    const b = Math.min(a + DAY_MS, limit);
    if (offsetMinutesAt(zone, new Date(b)) !== base) {
      // Invariant: offset(lo) === base, offset(hi) !== base.
      let lo = a;
      let hi = b;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (offsetMinutesAt(zone, new Date(mid)) === base) lo = mid;
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
//
// THE DEFAULT IS SIZED FOR TRAVEL, NOT FOR DST (#3428). At 8 it was three times what a
// 180-day window can reach on transitions alone. A profile that MOVES adds a piece per
// recorded switch inside the window, and the issue's own sizing for a heavy traveller
// is ~100 moves a year — so a 180-day Trends window can legitimately want ~50 pieces,
// and a valve that clipped it there would hand back one wrong offset for the tail of
// the window rather than a bounded number of right ones. Each extra piece is one more
// indexed range aggregate over a window the query already bounds.
export function offsetSegments(
  zone: ProfileDayZone,
  startUtc: string,
  endUtc: string,
  maxSegments = 64
): OffsetSegment[] {
  const lo = parseUtcSql(startUtc)?.getTime();
  const hi = parseUtcSql(endUtc)?.getTime();
  if (lo == null || hi == null || !(hi > lo)) return [];
  const out: OffsetSegment[] = [];
  let cursor = lo;
  while (cursor < hi && out.length < maxSegments - 1) {
    const cut = nextTransition(zone, cursor, hi);
    out.push(segment(zone, cursor, cut ?? hi));
    cursor = cut ?? hi;
  }
  if (cursor < hi) out.push(segment(zone, cursor, hi));
  return out;
}

// One piece, labelled by the offset in force at its START — which is the offset in
// force throughout it, because that is what makes it a piece.
function segment(
  zone: ProfileDayZone,
  startMs: number,
  endMs: number
): OffsetSegment {
  const offsetMinutes = offsetMinutesAt(zone, new Date(startMs));
  return {
    startUtc: instant(startMs),
    endUtc: instant(endMs),
    startMs,
    endMs,
    offsetMinutes,
    modifier: offsetModifier(offsetMinutes),
  };
}

function instant(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

// The instant a profile-local day BEGINS: the first moment its clock reads `date`.
//
// For a profile whose zone has never moved this is `zonedWallTimeToUtc` and nothing
// else — the same call, the same answer, byte for byte.
//
// For one that HAS moved, local midnight is not a single question. A westward move
// puts the clock back, so a day's midnight arrives under the OLD zone and the day then
// runs 27 hours; an eastward move can jump the clock straight over midnight, so the
// day begins at the SEAM and no midnight is ever read at all. Both fall out of walking
// the window's offset pieces in order and taking the first one whose midnight the
// profile actually reached: inside a piece the offset is constant, so that piece's
// midnight is `date`'s UTC anchor minus its offset, and a midnight lying BEFORE the
// piece began is one the clock jumped over.
//
// Half-open ranges built from this partition time exactly — one day ends where the
// next begins — which is what keeps a switch day 27 hours long (#3263's stated rule)
// rather than double-counting or dropping the hours around the seam.
function localDayStart(zone: ProfileDayZone, date: string): Date | null {
  if (typeof zone === "string") return zonedWallTimeToUtc(zone, date, "00:00");
  const anchor = parseUtcSql(`${date}T00:00:00`)?.getTime(); // a calendar day, UTC-anchored
  if (anchor == null) return null;
  // Every real offset is inside ±14 h, so the day's midnight lies in this bracket
  // whichever zone was in force at it; a move inside the bracket is one more piece.
  const bracket = 15 * 3_600_000;
  for (const seg of offsetSegments(
    zone,
    instant(anchor - bracket),
    instant(anchor + bracket)
  )) {
    const midnight = anchor - seg.offsetMinutes * 60_000;
    if (midnight < seg.startMs) return new Date(seg.startMs);
    if (midnight < seg.endMs) return new Date(midnight);
  }
  return null;
}

// The half-open UTC range [startUtc, endUtc) covering profile-local day `date`.
// Half-open on purpose: a local day is 23, 24 or 25 hours long depending on DST — or
// 21 or 27 across a travel switch — and an inclusive upper bound would have to name
// the last stored minute, which depends on the column's grain.
export function localDayRange(
  zone: ProfileDayZone,
  date: string
): { startUtc: string; endUtc: string } {
  return localDaySpan(zone, date, date);
}

// The half-open UTC range covering the inclusive local-day span `from`..`to`.
export function localDaySpan(
  zone: ProfileDayZone,
  from: string,
  to: string
): { startUtc: string; endUtc: string } {
  const start = localDayStart(zone, from);
  const end = localDayStart(zone, shiftDateStr(to, 1));
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

// A calendar date's midnight instant and the days either side of it, memoised per
// window by `localMinuteProjector`.
interface UtcDay {
  midnightMs: number;
  dates: [string, string, string];
}

// The shape every stored instant column holds: a calendar date, a separator, and a
// minute of day. Canonical rows spell it 'YYYY-MM-DDTHH:MM:SSZ'; SQLite's own
// datetime() spells the separator as a space, and both are read by index below.
const STORED_STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

// The profile-local MINUTE stamp ('YYYY-MM-DDTHH:MM') of every stored instant in one
// window, derived from the window's offset segments instead of from `Intl` per row.
//
// THE SAME ARGUMENT AS THE SEGMENTS ABOVE, ONE UNIT FINER. `date(ts, modifier)` pushes
// the DAY question into SQLite because the offset is constant inside a segment. A
// consumer that needs the MINUTE — the intraday chart, the training-zone windows, the
// overnight window filter — cannot express that as a GROUP BY, so it materialises rows
// and used to convert each one through `zonedMinuteStr`, at ~10 µs of `formatToParts`
// apiece. But the offset it is applying is the SAME constant the segment already
// carries: inside a segment the local wall clock is exactly `ts + offset`, so the
// conversion is addition, and `Intl` is needed only to find where the segments are
// (~90 probes for a 90-day window, against 125,000 conversions).
//
// EXACT, NOT APPROXIMATE, and the difference is the whole reason this is safe to do.
// The offset is piecewise constant with the pieces bounded by `nextTransition`'s
// millisecond-exact cut, so a row on either side of a transition — including one
// landing on the transition instant itself — reads the offset actually in force at
// that instant. Every zone's offset is a whole number of minutes (the sub-minute
// offsets predate any stored reading), so truncating the shifted instant to its minute
// is the same truncation `Intl` performs on the wall clock. Non-hour offsets
// (Kathmandu's +05:45, Chatham's +12:45/+13:45, Lord Howe's 30-minute DST step) fall
// out of the arithmetic with nothing special done for them.
//
// The returned function is for THIS window: the caller's query bounds its rows by the
// same `startUtc`/`endUtc`, and an instant outside them keeps the nearest segment's
// offset. Unparseable input yields null, so a surprise row stays visible to the caller
// rather than being silently dated.
export function localMinuteProjector(
  zone: ProfileDayZone,
  startUtc: string,
  endUtc: string
): (ts: string) => string | null {
  const segments = offsetSegments(zone, startUtc, endUtc);
  // Linear over the window's pieces — 1 or 2 for every window the app asks for, and
  // one per recorded move for a traveller's. Cheaper than a binary search's setup at
  // this length, and the rows arrive in no guaranteed order so a cursor would not hold.
  const offsetMinutesFor = (utcMs: number): number => {
    let offset = segments.length > 0 ? segments[0].offsetMinutes : null;
    for (const seg of segments) {
      if (utcMs < seg.startMs) break;
      offset = seg.offsetMinutes;
    }
    return offset ?? offsetMinutesAt(zone, new Date(utcMs));
  };

  // ONE `Date` PER CALENDAR DAY IN THE WINDOW, NOT ONE PER ROW (#5061). The segments
  // above removed `Intl` from the row loop; measured after that, what was left was
  // the row loop's own `new Date(...).toISOString()` — 294,420 of each on one
  // dashboard render, 1.0 µs apiece and the single largest remaining self time on the
  // page. A stored stamp is a fixed-width UTC calendar date and a minute-of-day, so
  // everything a local minute needs from that date — its midnight instant, and the
  // calendar days either side of it for a minute that rolls over — is the same for
  // every row of that day and is memoised here. The row itself is then integer
  // arithmetic on two character pairs.
  const days = new Map<string, UtcDay | null>();
  const dayOf = (date: string): UtcDay | null => {
    const known = days.get(date);
    if (known !== undefined) return known;
    const midnightMs = Date.parse(`${date}T00:00:00Z`);
    // THE DAY LABEL IS THE PARSED DATE, NEVER THE INPUT SUBSTRING. `Date` rolls an
    // impossible calendar date over — `2026-02-30` is 2026-03-02 — so a loop that
    // labelled the row with the characters it read would answer differently from the
    // `Date` path it replaced on exactly the stamps nobody checks. `shiftDateStr(d, 0)`
    // is that same normalisation, taken once per day instead of once per row.
    const day = Number.isNaN(midnightMs)
      ? null
      : {
          midnightMs,
          dates: [
            shiftDateStr(date, -1),
            shiftDateStr(date, 0),
            shiftDateStr(date, 1),
          ] as [string, string, string],
        };
    days.set(date, day);
    return day;
  };

  return (ts: string) => {
    if (STORED_STAMP.test(ts)) {
      const hours = (ts.charCodeAt(11) - 48) * 10 + (ts.charCodeAt(12) - 48);
      const minutes = (ts.charCodeAt(14) - 48) * 10 + (ts.charCodeAt(15) - 48);
      const day = hours < 24 && minutes < 60 ? dayOf(ts.slice(0, 10)) : null;
      if (day) {
        const minuteOfDay = hours * 60 + minutes;
        // Every real offset is inside ±14 h, so a local minute lands on the stored
        // day or on one of its neighbours and one correction is always enough.
        let local =
          minuteOfDay + offsetMinutesFor(day.midnightMs + minuteOfDay * 60_000);
        let dayIndex = 1;
        if (local < 0) {
          local += 1440;
          dayIndex = 0;
        } else if (local >= 1440) {
          local -= 1440;
          dayIndex = 2;
        }
        return (
          `${day.dates[dayIndex]}T` +
          `${String((local / 60) | 0).padStart(2, "0")}:` +
          `${String(local % 60).padStart(2, "0")}`
        );
      }
    }
    // Any other shape `Date` understands goes the long way; true garbage yields null,
    // so a surprise row stays visible to the caller rather than being silently dated.
    const d = parseUtcSql(ts);
    if (!d) return null;
    const t = d.getTime();
    return new Date(t + offsetMinutesFor(t) * 60_000)
      .toISOString()
      .slice(0, 16);
  };
}

// The profile-local day a stored instant belongs to. The single-row companion to the
// segment machinery above — used where the row count is already bounded (a picked
// minute list, the newest row) and a SQL GROUP BY is not in play.
export function localDayOf(zone: ProfileDayZone, ts: string): string | null {
  const d = parseUtcSql(ts);
  return d ? dateStrInTz(zoneOf(zone, d), d) : null;
}
