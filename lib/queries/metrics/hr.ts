// HEART-RATE MINUTES — one of the five submodules behind lib/queries/metrics.ts
// (issue #5171): the profile-local day readers over the UTC `hr_minutes.ts` column —
// daily summaries, the latest HR day, one day's minute buckets, and the in-range
// minute and instant reads behind the training-zone aggregations. The day-window
// aggregates they share with the per-source series live in ./common.ts. Every read
// is profile-scoped.

import { db } from "../../db";
import { cache } from "../../request-cache";
import { pickRowsOneSourcePerDay } from "../../metric-sources";
import { getTimezone } from "../../settings";
import {
  localDayOf,
  localDayRange,
  localDaySpan,
  localMinuteProjector,
} from "../../local-day-window";
import { profileDayZone } from "../../travel-excusal";
import { parseUtcSql } from "../../date";
import type { HrMinute } from "../../types";
import {
  hrDayAggregates,
  hrInstantBounds,
  markPartialToday,
  recentHrCutoff,
  resolutionFor,
} from "./common";

// ---- hr_minutes: profile-local days over a UTC instant column (#2205) --------
//
// `hr_minutes.ts` is an absolute instant since migration 164; every reader below asks
// a profile-LOCAL day question. The translation is lib/local-day-window.ts, and it is
// used two ways:
//
//   • a day (or span of days) becomes a half-open UTC RANGE, which the primary key's
//     own index on (profile_id, ts, source) serves as a plain range scan — this is
//     why 164 dropped idx_hr_minutes_day rather than replacing it;
//   • a GROUP BY day stays in SQL as `date(ts, '±HH:MM')`, run once per offset-constant
//     SEGMENT of the window, so DST is exact and the row work never leaves SQLite
//     (the #387 bound).
//
// A day that CONTAINS a DST transition is the only one that appears in two segments;
// `mergeHrDayRows` folds those halves back into one row with a count-weighted average.

// Daily HR summary derived from the 1-minute buckets, oldest→newest. Since the
// hr_minutes key gained `source` (migration 013, issue #14) two sources can carry
// the same minutes, so each day keeps ONE source's buckets — the 'heart_rate'
// primary source when set, else the default preference, else the source with the
// most minutes that day — instead of blending overlapping streams.
export function getHrDailySummary(
  profileId: number,
  limitDays = 180
): { date: string; avg: number; min: number; max: number; partial?: true }[] {
  // Bound the GROUP BY to the limitDays most-recent days-with-data (issue #387).
  // The JS slice below still picks one source per day over exactly this window.
  const cutoff = recentHrCutoff(profileId, limitDays);
  if (cutoff === null) return [];
  const zone = profileDayZone(profileId);
  const bounds = hrInstantBounds(profileId);
  if (!bounds) return [];
  const lastDay = localDayOf(zone, bounds.last);
  if (!lastDay) return [];
  const { startUtc, endUtc } = localDaySpan(zone, cutoff, lastDay);
  const rows = hrDayAggregates(profileId, zone, startUtc, endUtc);
  const picked = pickRowsOneSourcePerDay(
    rows,
    resolutionFor(profileId, "heart_rate"),
    (r) => r.date,
    (r) => r.source,
    (r) => r.n
  ).sort((a, b) => (a.date < b.date ? -1 : 1));
  // Match SQLite LIMIT semantics used by the other Trends queries: a negative
  // limit is the ALL_ROWS sentinel, not Array.slice(1).
  return markPartialToday(
    profileId,
    (limitDays < 0 ? picked : picked.slice(-limitDays)).map(
      ({ date, avg, min, max }) => ({ date, avg, min, max })
    )
  );
}

// Daily HR summary inside an explicit calendar window. Unlike the recent-days
// reader above, this bounds the high-volume GROUP BY by the dates the caller is
// actually rendering. A historical custom range therefore does not need to read
// every newer day first, and the ordinary 90-day Trends view never aggregates a
// profile's lifetime hr_minutes table. No bounds deliberately means all time.
export function getHrDailySummaryInRange(
  profileId: number,
  from?: string,
  to?: string
): { date: string; avg: number; min: number; max: number; partial?: true }[] {
  if (!from && !to) return getHrDailySummary(profileId, -1);

  // One window whichever end is open: an absent bound is resolved to the profile's
  // own first/last day-with-data, so the UTC range is always concrete and the
  // aggregate is always the same shape.
  const zone = profileDayZone(profileId);
  const bounds = hrInstantBounds(profileId);
  if (!bounds) return [];
  const fromDay = from ?? localDayOf(zone, bounds.first);
  const toDay = to ?? localDayOf(zone, bounds.last);
  if (!fromDay || !toDay || fromDay > toDay) return [];
  const { startUtc, endUtc } = localDaySpan(zone, fromDay, toDay);
  const rows = hrDayAggregates(profileId, zone, startUtc, endUtc);

  return markPartialToday(
    profileId,
    pickRowsOneSourcePerDay(
      rows,
      resolutionFor(profileId, "heart_rate"),
      (row) => row.date,
      (row) => row.source,
      (row) => row.n
    )
      .sort((left, right) => (left.date < right.date ? -1 : 1))
      .map(({ date, avg, min, max }) => ({ date, avg, min, max }))
  );
}

// The most recent day that has any HR buckets, or null.
export function getLatestHrDay(profileId: number): string | null {
  const row = db
    .prepare(
      "SELECT ts FROM hr_minutes WHERE profile_id = ? ORDER BY ts DESC LIMIT 1"
    )
    .get(profileId) as { ts: string } | undefined;
  return row ? localDayOf(getTimezone(profileId), row.ts) : null;
}

// A single day's 1-minute HR buckets, ordered by time. One source per day
// (issue #14) — same pick as getHrDailySummary — so an intraday chart never
// zig-zags between two devices' overlapping minutes.
export function getHrMinutes(profileId: number, date: string): HrMinute[] {
  // The local day as a half-open UTC range — 23, 24 or 25 hours wide depending on
  // DST, which is precisely what a `substr` day could not express.
  const tz = getTimezone(profileId);
  const { startUtc, endUtc } = localDayRange(tz, date);
  const rows = db
    .prepare(
      `SELECT * FROM hr_minutes
        WHERE profile_id = ? AND ts >= ? AND ts < ?
        ORDER BY ts`
    )
    .all(profileId, startUtc, endUtc) as HrMinute[];
  // PROJECT to the profile-local minute on the way out (#2205). The column stores an
  // absolute instant; every consumer of this shape — the intraday chart, the
  // training-zone windows, the ride series — compares it against activity times that
  // are profile-local wall clocks. Storage is UTC, presentation is local, and the
  // conversion happens HERE, once, instead of each surface guessing.
  const toLocalMinute = localMinuteProjector(tz, startUtc, endUtc);
  const local = rows.map((r) => ({ ...r, ts: toLocalMinute(r.ts) ?? r.ts }));
  return pickRowsOneSourcePerDay(
    local,
    resolutionFor(profileId, "heart_rate"),
    () => date,
    (r) => r.source
  );
}

// Per-minute HR buckets (ts + bpm) within an inclusive [since, until] date range, one
// source per day — the shared read behind the training-zone aggregations
// (lib/queries/zones.ts), so zone minutes can't double-count a workout recorded by two
// HR sources at once (issue #14). Both bounds are profile-local days.
//
// `until` IS REQUIRED (#5069). It used to default to the day of the profile's LAST
// STORED instant, which reads as "to now" only while the last row is roughly now — a
// coincidence, not a bound. A device stamping ahead (#5035) widened this scan with
// nothing saying so: #5069 records a snapshot whose rows ran into the future, where the
// zone reads materialised 144,000 minutes and kept 86. Every caller already knew the
// window it meant, so the open-ended form is DELETED rather than guarded — the
// parameter is the bound, and a caller that forgets one no longer compiles.
//
// REQUEST-CACHED because a dashboard asks for the SAME window more than once (#5010):
// `getDayLoadInputs` and `getIntensitySignal` read the same 42 days on one render, and
// each read is a wide materialisation. `cache()` is identity outside a Next request
// (lib/request-cache.ts says so deliberately), so a notify tick and the DB tier behave
// exactly as before. Keyed on the arguments, so two spellings of one span would stay
// separate reads — with `until` required, the trailing window has one spelling.
export const getHrMinutesInRange = cache(function getHrMinutesInRange(
  profileId: number,
  since: string,
  until: string
): { ts: string; bpm: number }[] {
  const tz = getTimezone(profileId);
  if (!hrInstantBounds(profileId)) return [];
  if (until < since) return [];
  const { startUtc, endUtc } = localDaySpan(tz, since, until);
  const rows = db
    .prepare(
      `SELECT ts, bpm, source FROM hr_minutes
        WHERE profile_id = ? AND ts >= ? AND ts < ?`
    )
    .all(profileId, startUtc, endUtc) as {
    ts: string;
    bpm: number;
    source: string | null;
  }[];
  // Projected to the profile-local minute before anything groups or compares it —
  // same boundary rule as getHrMinutes above. Once projected, the day is the stamp's
  // own prefix again and the training-zone windows line up as they always did.
  //
  // Through the window's OFFSET SEGMENTS rather than through `Intl` per row (#5010).
  // The zone's offset is constant inside a segment, so the local minute is the stored
  // instant plus that constant; the segments cost ~90 `Intl` probes for a 90-day
  // window against the 125,000 `formatToParts` calls this line used to make. Identical
  // output, including on the transition instant itself — pinned minute by minute
  // against `zonedMinuteStr` in lib/__tests__/local-day-window.test.ts.
  const toLocalMinute = localMinuteProjector(tz, startUtc, endUtc);
  const local = rows.map((r) => ({ ...r, ts: toLocalMinute(r.ts) ?? r.ts }));
  return pickRowsOneSourcePerDay(
    local,
    resolutionFor(profileId, "heart_rate"),
    (r) => r.ts.slice(0, 10),
    (r) => r.source
  ).map(({ ts, bpm }) => ({ ts, bpm }));
});

// THE SAME WINDOW AND THE SAME ONE-SOURCE-PER-DAY PICK, ANSWERED IN INSTANTS (#5212
// falsifying pass, F3). The projection above is the right answer for everything that
// groups or renders BY DAY — but it is lossy, and exactly once a year it loses the
// thing a duration reader needs. In a fall-back hour two stored instants project to
// the SAME local minute, so a caller that resolves the local string back through the
// zone gets the first of the two for both: an hour of a person's readings collapses
// onto the hour before it, the newest measured minute moves an hour into the past, and
// a quiet stretch appears where there was effort.
//
// A caller measuring real elapsed spans therefore reads the stored instant, which
// `hr_minutes.ts` has been since #2205. The local day is still what decides which
// source wins a day (#14), so the projection is still computed — it is used for
// GROUPING and thrown away, rather than returned as if it were the fact.
export const getHrInstantsInRange = cache(function getHrInstantsInRange(
  profileId: number,
  since: string,
  until: string
): { at: number; bpm: number }[] {
  const tz = getTimezone(profileId);
  if (!hrInstantBounds(profileId)) return [];
  if (until < since) return [];
  const { startUtc, endUtc } = localDaySpan(tz, since, until);
  const rows = db
    .prepare(
      `SELECT ts, bpm, source FROM hr_minutes
        WHERE profile_id = ? AND ts >= ? AND ts < ?
        ORDER BY ts ASC`
    )
    .all(profileId, startUtc, endUtc) as {
    ts: string;
    bpm: number;
    source: string | null;
  }[];
  const toLocalMinute = localMinuteProjector(tz, startUtc, endUtc);
  return (
    pickRowsOneSourcePerDay(
      rows,
      resolutionFor(profileId, "heart_rate"),
      (r) => (toLocalMinute(r.ts) ?? r.ts).slice(0, 10),
      (r) => r.source
    )
      // `parseUtcSql`, NEVER `Date.parse` (#5338, found by the fourth falsifying pass on
      // #5212). `hr_minutes.ts` is a stored stamp and a zoneless date-TIME string is
      // SERVER-LOCAL by specification, so `Date.parse` reads it through whatever `TZ` the
      // host has — every db fixture in the repo, migration 164's unconverted rows and any
      // `seedTimezoneFromEnv` self-host emit one without a `Z`. Under
      // `TZ=America/New_York` that moved a whole trace by the offset and stamped a
      // completed workout onto a window with no heart rate in it, which is a WRITE and
      // reaches the safety-tier post-workout dispatch. The projection above is thrown away
      // precisely so this line reads the stored instant; parsing it in the host's zone
      // gives back the loss that seam exists to prevent.
      .map(({ ts, bpm }) => ({ at: parseUtcSql(ts)?.getTime() ?? NaN, bpm }))
      .filter((r) => Number.isFinite(r.at))
      .sort((left, right) => left.at - right.at)
  );
});
