import { dateStrInTz } from "@/lib/date";
import { isValidTimezone } from "@/lib/timezone";
import type { TimezoneSwitch } from "@/lib/travel-timezone";

// WHICH STORED DAY A RE-PUSHED READING WAS FILED UNDER BEFORE THE PROFILE MOVED (#3524).
//
// PURE. Intl + the switch history only: no DB, no clock, no settings. The database half
// is lib/integrations/ingest-timezone-reconcile.ts.
//
// THE PROBLEM THIS ANSWERS, and the one it replaces. `body_metrics.date` is a
// PROFILE-LOCAL day computed at ingest, so when the profile's zone moves, the next push
// of the same reading files it on a different day and #608's duplicate appears: one
// instant, two rows. Until this change the app dealt with that by DELETING every
// Health Connect body_metrics row inside a trailing day window on every zone change
// (`sweepIngestWindowForTimezoneChange`, SWEEP_DAYS = 3) and trusting the next push to
// put them back. It does not: the exporter re-sends one day, so three days went and one
// came back. Four days of a real profile's resting HR were lost across two travel
// switches, and every further switch took three more.
//
// No day-range bound fixes that, in either direction: at 3 it destroys a day per switch,
// at 1 it leaves an unswept #608 duplicate on 295 of 552 ordered zone pairs, and the
// curve between them trades one harm for the other (PR #3539's adversarial lens; owner
// ruling on #3524, 2026-08-22). So nothing is deleted on the switch at all. Instead the
// PUSH reconciles what it actually carries: for an incoming MEASURE we can say exactly
// which day it WOULD have been filed under in a zone the profile has left, and clear
// only that measure there. A day the exporter does not re-send is never touched, in
// either direction, at any offset — the eastward/westward asymmetry falls out of the day
// arithmetic instead of being encoded as a bound.
//
// PER MEASURE, NOT PER ROW, and the distinction is the whole of the owner's 2026-08-23
// ruling. `body_metrics` is ONE WIDE ROW per (profile, day, source) carrying weight,
// body fat and resting HR — three measures with three instants. An earlier draft deleted
// that row to re-key one measure, so an ordinary push of a single resting-HR record
// destroyed the same day's weigh-in, which Health Connect (push-only) never re-sends.
// The unit here is therefore the MEASURE and its own instant: this module answers the
// day question for one instant, and its caller nulls one column.
//
// ONE CONDITION, AND IT IS EXACT RATHER THAN A BOUND.
//
//   `switchedAtMs > readingMs`. Allos always keys a row with the zone the profile is on
//   AT THE MOMENT OF THE PUSH. So a reading can only have been filed under a departed
//   zone Z if some push happened while the profile was still on Z, i.e. before it left;
//   and that push cannot have carried a reading that had not happened yet. A reading
//   taken AFTER the profile left Z was therefore never filed under Z by anything, and
//   there is nothing of it there to null. This is what stops today's freshly-taken
//   reading reaching yesterday's stored row no matter which way the profile moved — a
//   property the day arithmetic alone does NOT give you (`day(t, Z)` is `today − 1` for
//   any early-morning reading after a westward move), and the reason "seeded days
//   survive a switch plus a real push" holds by construction here rather than by choice
//   of offsets.
//
//   THERE IS NO DAY-RANGE LOOKBACK, and the absence is deliberate. An earlier draft
//   carried `SWITCH_LOOKBACK_DAYS = 3` because the owner's first phrasing named it —
//   the old `SWEEP_DAYS` number wearing a new hat, never independently evidenced. It
//   constrained nothing: the predicate above decides what is touched, and the stored
//   history is already bounded (`SWITCH_RETENTION_DAYS`, `MAX_STORED_SWITCHES` in
//   lib/travel-timezone.ts). Owner ruling, #3524, 2026-08-23: "a number that constrains
//   nothing is one someone will defend later."

// A zone the profile has left, and the instant it left. `at` is milliseconds since the
// epoch — the comparison in the condition above is against a reading instant, so it is
// done in absolute time and never in anybody's wall clock.
export interface DepartedZone {
  zone: string;
  at: number;
}

// The stored day a reading was filed under before the move, and the zone that put it
// there. `zone` is carried for test readability; the write keys on `date` alone.
export interface RekeyedDay {
  date: string;
  zone: string;
}

// The zones this profile has LEFT, newest first, from its recorded switch history
// (`timezone_switches`, #3263). The whole retained history: no clock and no window —
// see the condition above. A record whose zone or instant is unusable is dropped rather
// than thrown, because this runs on the ingest path and one corrupt entry must not be
// able to fail a push.
export function departedZones(
  switches: readonly TimezoneSwitch[]
): DepartedZone[] {
  const out: DepartedZone[] = [];
  for (const sw of switches) {
    const at = new Date(sw.at).getTime();
    if (!Number.isFinite(at)) continue;
    if (!isValidTimezone(sw.from)) continue;
    out.push({ zone: sw.from, at });
  }
  return out.sort((a, b) => b.at - a.at);
}

// The days one incoming MEASURE may already be stored under, because a departed zone
// filed the same instant on a different local day.
//
// `date` is the day the reading files under NOW — the caller's current-zone attribution,
// not recomputed here, so the reconcile can never disagree with the upsert about where
// the row is going. A candidate equal to it is not a re-key at all and is dropped.
export function rekeyedDaysFor(
  readingAt: Date,
  date: string,
  departed: readonly DepartedZone[]
): RekeyedDay[] {
  const readingMs = readingAt.getTime();
  if (!Number.isFinite(readingMs)) return [];
  const seen = new Set<string>();
  const out: RekeyedDay[] = [];
  for (const d of departed) {
    // The condition, strict: a reading taken at the very instant of the switch is
    // already on the new zone's clock by the time anything can push it.
    if (d.at <= readingMs) continue;
    const was = dateStrInTz(d.zone, readingAt);
    if (was === date || seen.has(was)) continue;
    seen.add(was);
    out.push({ date: was, zone: d.zone });
  }
  return out;
}
