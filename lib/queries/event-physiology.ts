// The GATHERING half of #4775 §1. The computation is pure and lives in
// lib/event-physiology.ts; nothing here re-derives it.
//
// Three reads per event: the minute stream over the span the window can reach, the
// profile's zone model, and the resting-HR signal the `rest-rhr` rule uses — all
// through existing profile-scoped queries. The two statements this module does own
// (the frontier seek and the prior-events window below) are bounded, indexed and
// scoped by `profile_id` in their WHERE clause, per AGENTS.md.
//
// ── The frontier, and why it is MAX(ts) rather than the stored watermark ─────
//
// `stream_frontiers.frontier_at` (#2341) is a per-source WATERMARK, copied from the
// stream table's own event column at the end of each successful push. It answers "is
// this stream MOVING", which is the question the wear reminder asks. Coverage asks
// something narrower and more literal — do we HOLD minutes past this window's end —
// and the ground truth for that is the stream itself. Reading it directly also means
// a profile whose source has never had a push observed (a fresh deploy, an archive
// import, the Fitbit Takeout path which declares no continuous stream at all) still
// gets an honest coverage answer instead of a permanent `false`. The two agree
// whenever the watermark exists, because the watermark is a copy of this value.

import { db } from "../db";
import { getTimezone } from "../settings";
import { parseUtcSql, zonedMinuteStr } from "../date";
import { now as clockNow } from "../clock";
import { getHrMinutesInRange } from "./metrics";
import { getProfileZoneModel } from "./zones";
import { getRestingHrSignal } from "./coaching";
import { getSleepSessions } from "./metrics";
import { mainSleepNights } from "../sleep-regularity";
import { profileDayZone } from "../travel-excusal";
import {
  eventPhysiology,
  physiologyDaySpan,
  usualValue,
  USUAL_RECENT_EVENTS,
  type EventPhysiology,
} from "../event-physiology";
import { activityWindow, type ActivityWindow } from "../training-zones";
import type { ActivityWindowInput } from "../training-zones";

/**
 * The newest HR minute the profile holds, as a profile-LOCAL minute stamp, or null.
 *
 * One indexed seek on `hr_minutes`' primary key. Projected to the local minute before
 * it is returned so it lives in the same space as every window in this feature — a
 * comparison between a canonical UTC stamp and a local window stamp is the #2096
 * failure class, and it looks right in every query.
 */
export function getHrFrontierLocal(profileId: number): string | null {
  const row = db
    .prepare("SELECT MAX(ts) AS ts FROM hr_minutes WHERE profile_id = ?")
    .get(profileId) as { ts: string | null } | undefined;
  const at = row?.ts ? parseUtcSql(row.ts) : null;
  return at ? zonedMinuteStr(getTimezone(profileId), at) : null;
}

/** The top of the resting range: baseline + its spread, or null with no history. */
export function restingCeilingBpm(profileId: number): number | null {
  const signal = getRestingHrSignal(profileId);
  if (!signal || !(signal.baseline > 0)) return null;
  return signal.baseline + (signal.baselineSpreadBpm ?? 0);
}

/**
 * The resting-HR REFERENCE the practice line's rise is stated over — the profile's
 * own baseline, the same quantity the recovery ceiling above and `rest-rhr` read
 * (#4775 comment 2026-09-02: "one reference for both rules"). Deliberately the
 * baseline rather than the single most recent device value, which moves several bpm
 * with illness, the device and the night before, and would make one practice's rise
 * incomparable to the same practice's rise a week earlier.
 */
export function restingReferenceBpm(profileId: number): number | null {
  const signal = getRestingHrSignal(profileId);
  return signal && signal.baseline > 0 ? signal.baseline : null;
}

/**
 * The full physiology of one bounded window, or null when the row cannot be bounded
 * at all (no start time, and no end or duration to derive one from).
 */
export function getEventPhysiology(
  profileId: number,
  row: ActivityWindowInput,
  at: Date = clockNow()
): EventPhysiology | null {
  const window = activityWindow(row);
  return window ? getWindowPhysiology(profileId, window, at) : null;
}

/** The same, for a window a caller has already bounded. */
export function getWindowPhysiology(
  profileId: number,
  window: ActivityWindow,
  at: Date = clockNow()
): EventPhysiology {
  const span = physiologyDaySpan(window);
  return eventPhysiology({
    window,
    // `getHrMinutesInRange`'s `until` is INCLUSIVE of the named day, and both bands
    // can spill past local midnight, so the span's own first and last days are what is
    // asked for — never the window's own date.
    minutes: getHrMinutesInRange(profileId, span.from, span.to),
    zoneModel: getProfileZoneModel(profileId),
    restingCeilingBpm: restingCeilingBpm(profileId),
    frontier: getHrFrontierLocal(profileId),
    now: zonedMinuteStr(getTimezone(profileId), at),
  });
}

/**
 * The profile's usual recovery for a KIND of event, over its own prior windowed rows —
 * `priorsNewestFirst` capped at `USUAL_RECENT_EVENTS` before anything is read, so the
 * cost of this is bounded by a constant and not by account age.
 *
 * Rows the stream could not answer for contribute nothing: below three MEASURED
 * recoveries there is no usual and the fact renders alone. That is deliberately
 * stricter than "three prior events" — a usual averaged over one real recovery and two
 * silences would be a number with a plural word in front of it.
 */
export function usualRecoveryMin(
  profileId: number,
  priorsNewestFirst: readonly ActivityWindowInput[]
): number | null {
  const measured: number[] = [];
  for (const row of priorsNewestFirst.slice(0, USUAL_RECENT_EVENTS)) {
    const recovery = getEventPhysiology(profileId, row)?.recoveryMin;
    if (recovery != null) measured.push(recovery);
  }
  return usualValue(measured);
}

/**
 * The recovery fact for one finished event, plus the profile's usual for its kind, or
 * null when the stream cannot honestly answer. The COVERAGE gate is applied here so no
 * caller has to remember it: an uncovered window's recovery is not "not yet", it is a
 * measurement over minutes that have not arrived.
 */
export function eventRecovery(
  profileId: number,
  row: ActivityWindowInput,
  priorsNewestFirst: readonly ActivityWindowInput[],
  at: Date = clockNow()
): { recoveryMin: number; usualRecoveryMin: number | null } | null {
  const physiology = getEventPhysiology(profileId, row, at);
  if (!physiology?.covered || physiology.recoveryMin == null) return null;
  return {
    recoveryMin: physiology.recoveryMin,
    usualRecoveryMin: usualRecoveryMin(profileId, priorsNewestFirst),
  };
}

/**
 * The profile's own PRIOR windowed events of one activity type, newest first and
 * capped — the "same kind" a usual is averaged over. Bounded by
 * `USUAL_RECENT_EVENTS` in SQL rather than in the caller, because the point of the cap
 * is that this read cannot grow with account age.
 *
 * "Prior" is the (date, id) LEDGER order the rest of the app walks, not the date
 * alone: two sessions on one day are ordered, and a usual that included the session it
 * is being compared against would flatten toward it.
 */
export function priorEventWindows(
  profileId: number,
  type: string,
  before: { date: string; id: number }
): ActivityWindowInput[] {
  return db
    .prepare(
      `SELECT date, start_time, end_time, duration_min FROM activities
        WHERE profile_id = ? AND type = ? AND start_time IS NOT NULL
          AND (date < ? OR (date = ? AND id < ?))
        ORDER BY date DESC, id DESC
        LIMIT ?`
    )
    .all(
      profileId,
      type,
      before.date,
      before.date,
      before.id,
      USUAL_RECENT_EVENTS
    ) as ActivityWindowInput[];
}

// ── The overnight minimum, per night (#4775 §5) ──────────────────────────────

/**
 * The least of a night that has to be MEASURED before its minimum describes the
 * night rather than a moment. An hour: below that the floor is whatever the watch
 * happened to catch, and a single low minute from a half-worn night would sit in a
 * paired-observation arm as if it were a night's reading.
 *
 * THE ARGUMENT IS MEASURED; THE NUMBER IS NOT (owner ruling 2026-09-03, on #4775).
 * That a half-worn night's minimum is not a night's minimum is a real property of the
 * data. Sixty minutes is a judgement about where that stops being true, and nothing
 * was counted to pick it. So it is deliberately a round hour rather than a
 * precise-looking 45 or 75, which would imply a fit that was never done.
 *
 * AND A FIT IS POSSIBLE, which is what makes this a tracked question rather than a
 * shrug. Two constants on this stream WERE fitted to measurements
 * (docs/internals/integrations-sync.md): the 2.5 h dip tolerance, to a gap
 * distribution that came back bimodal with an empty valley at 2.1–2.5 h separating 16
 * routine removals from 5 real events; and `frozenEvidence` N=4, to the finding that
 * every clean false positive in 28 days was k=2 while every true detection was k>=5.
 * Fitting from a measurement is the house style here — but DECLARED from it, never
 * learned at runtime, which that document forbids outright.
 *
 * The closest relative is the one that was NOT fitted: the 40-minute bedtime floor,
 * "dominated" at N=4 and "kept only because it costs nothing and still states the
 * intent". But it is the closest relative, not a twin, and the difference runs against
 * this constant. That floor is INERT — dominated is why the docs can say it costs
 * nothing — while this one is the sole gate and actively drops nights. And it is
 * bounded on both sides by a measurement (long enough that a watch put down minutes
 * before the slot is not announced, short enough that the measured 55-minute incident
 * still clears it), where sixty has no bound in either direction.
 *
 * So this is the least-evidenced number on the stream, not one of two. That is the
 * honest comparison, and it is the reason the revisit rule below is not a formality.
 *
 * WHAT A FIT WOULD ACTUALLY NEED, since the obvious answer is the wrong one. Counting
 * how many nights a threshold excludes measures its COST, not its correctness. The
 * validity question is different: take nights that were well covered, subsample them
 * to N measured minutes, and see how far the observed minimum drifts from the night's
 * true one. Prod's `hr_minutes` can answer that. The published 56-day cut cannot be
 * reused directly — it is daytime gap durations, ten of them the evening charge.
 *
 * WHAT WOULD SEND SOMEONE BACK TO IT, per the ruling: a REAL night excluded. If a
 * night someone actually slept through, and would recognise as a night, falls under
 * the hour and drops out of the series, this number is wrong. Note that nothing
 * announces that: the drop below is a bare `continue`, with no counter and no log, so
 * a night lost this way is simply one fewer datapoint. Someone has to go looking, and
 * a counter here is the cheapest thing that would change that.
 */
export const OVERNIGHT_MIN_MEASURED_MIN = 60;

/**
 * The overnight HR MINIMUM per night, dated on the WAKE day, oldest→newest.
 *
 * Scoped to each night's own main sleep SESSION (#1118) rather than to clock hours,
 * for the reason §4's line is: a 02:00 bedtime and a 22:00 one are the same night.
 *
 * ONE read of the minute stream covers the whole span rather than one per night —
 * ninety nights through the per-event gather would be ninety day-range reads, and
 * this runs inside the coaching gather on every dashboard render.
 *
 * A night is DROPPED, not zero-filled, when the stream has not passed its end (the
 * most recent night on a lagging pipeline) or when under an hour of it was measured.
 * The paired engine's arms are counts of nights, so a dropped night is simply one
 * fewer datapoint — which is honest — while a wrong one moves a mean.
 */
export function getOvernightHrMinSeries(
  profileId: number,
  limitDays: number
): { date: string; value: number }[] {
  const tz = getTimezone(profileId);
  const zone = profileDayZone(profileId);
  const nights = mainSleepNights(getSleepSessions(profileId), zone).slice(
    -limitDays
  );
  if (nights.length === 0) return [];
  const local = (at: string): string | null => {
    const d = parseUtcSql(at);
    return d ? zonedMinuteStr(tz, d) : null;
  };
  const windows = nights.flatMap((night) => {
    const start = local(night.start);
    const end = local(night.end);
    return start && end && end > start
      ? [{ wakeDay: night.wakeDay, start, end }]
      : [];
  });
  if (windows.length === 0) return [];
  const frontier = getHrFrontierLocal(profileId);
  if (frontier == null) return [];
  const minutes = getHrMinutesInRange(
    profileId,
    windows[0].start.slice(0, 10),
    windows[windows.length - 1].end.slice(0, 10)
  );
  // EACH NIGHT SLICES, IT DOES NOT SCAN (#5010). This loop used to `filter` the whole
  // span per night — 90 nights over ~125,000 minutes is 11 million comparisons for a
  // series of 90 numbers, and it grew as the PRODUCT of the two windows the caller
  // widens independently. Sorted once and bounded by two binary searches it is the
  // same set of rows in the same order, which is why the answer cannot move: the
  // stamps compared are the ones the filter compared.
  //
  // SORTED BY THE LOCAL STAMP, NOT BY THE INSTANT, and they are not the same order.
  // The rows arrive as profile-local minutes, and a fall-back night runs 01:59 → 01:00
  // on the wall clock while the instants keep climbing — so ordering by arrival would
  // leave the array unsorted exactly on the night this reader most needs to be right
  // about, and a binary search over an unsorted region silently returns a short slice.
  // Sorting by the stamp also keeps a repeated wall-clock minute's two instants
  // adjacent, so both stay inside the window, which is what the filter did.
  const sorted = [...minutes].sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
  );
  const lowerBound = (stamp: string) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].ts < stamp) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const out: { date: string; value: number }[] = [];
  for (const w of windows) {
    if (frontier < w.end) continue;
    const from = lowerBound(w.start);
    const to = lowerBound(w.end);
    if (to - from < OVERNIGHT_MIN_MEASURED_MIN) continue;
    let value = Infinity;
    for (let i = from; i < to; i++) {
      if (sorted[i].bpm < value) value = sorted[i].bpm;
    }
    out.push({ date: w.wakeDay, value });
  }
  return out;
}
