// THE CLOCK A DOSE SLOT IS USUALLY TAKEN AT (#5813) — `USUAL_KINDS.doseSlotClock`,
// read for the quick-log sheet's past-day "Usually" chip.
//
// One bounded read: this profile's scheduled doses taken with a STATED instant over
// the kind's 14-day window, bucketed by each dose's declared slot. A row whose instant
// is unknown (a "Don't know" check-off, #5595) is no evidence of a clock and is left
// out rather than guessed from its capture stamp.
//
// Each clock is measured from the slot's opening, up to `SLOT_CLOCK_EARLY` before it
// and the rest of the day after, so a Bedtime dose at 00:30 sits 210 minutes after
// 21:00 instead of 20 hours before it — the same reason sleep anchors at noon.
//
// THE DECLARED LEG IS THE SLOT'S OPENING, stated here rather than through `usual()`:
// that leg treats a value at or below zero as absent, and Morning opens at minute 0.
// Anytime declares no clock, so below the floor it answers nothing.
import { hoistedStatement } from "../../db";
import { minuteOfDayInTz, shiftDateStr } from "../../date";
import {
  TIME_BUCKET_OPENS_AT,
  timeBucket,
  type TimeBucket,
} from "../../intake-schedule";
import { recordedUsual, USUAL_KINDS } from "../../usual";

export interface DoseSlotClock {
  /** Profile-local minute of day, 0–1439. */
  minute: number;
  source: "recorded" | "declared";
}

// Doses run late far more than early, so a clock counts as early only within 6h of
// its slot's opening, and never before the day's own midnight: a slot opening at
// 00:00 (Morning, Anytime) spans its whole day, since the log's day is the dose's.
const SLOT_CLOCK_EARLY = 360;

const TAKEN_SLOT_CLOCKS_STMT = hoistedStatement(
  `SELECT d.time_of_day AS timeOfDay, l.occurred_at AS occurredAt
     FROM intake_item_logs l
     JOIN intake_items s ON s.id = l.item_id
     JOIN intake_item_doses d ON d.id = l.dose_id
    WHERE s.profile_id = ? AND s.obligation <> 'may'
      AND l.status = 'taken' AND l.occurred_at IS NOT NULL
      AND l.date > ? AND l.date <= ?
    ORDER BY l.occurred_at DESC`
);

export function getDoseSlotClocks(
  profileId: number,
  localToday: string,
  tz: string
): Partial<Record<TimeBucket, DoseSlotClock>> {
  const rows = TAKEN_SLOT_CLOCKS_STMT.all(
    profileId,
    shiftDateStr(localToday, -USUAL_KINDS.doseSlotClock.windowDays),
    localToday
  ) as { timeOfDay: string | null; occurredAt: string }[];
  const offsets = new Map<TimeBucket, number[]>();
  for (const row of rows) {
    const bucket = timeBucket(row.timeOfDay);
    const opens = TIME_BUCKET_OPENS_AT[bucket];
    const minute = minuteOfDayInTz(tz, new Date(row.occurredAt));
    const early = Math.min(SLOT_CLOCK_EARLY, opens);
    const offset = ((minute - opens + early + 1440) % 1440) - early;
    offsets.set(bucket, [...(offsets.get(bucket) ?? []), offset]);
  }
  const clocks: Partial<Record<TimeBucket, DoseSlotClock>> = {};
  for (const bucket of Object.keys(TIME_BUCKET_OPENS_AT) as TimeBucket[]) {
    const opens = TIME_BUCKET_OPENS_AT[bucket];
    const recorded = recordedUsual(
      offsets.get(bucket) ?? [],
      USUAL_KINDS.doseSlotClock
    );
    if (recorded != null)
      clocks[bucket] = {
        minute: (((opens + Math.round(recorded)) % 1440) + 1440) % 1440,
        source: "recorded",
      };
    else if (bucket !== "Anytime")
      clocks[bucket] = { minute: opens, source: "declared" };
  }
  return clocks;
}
