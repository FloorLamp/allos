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
