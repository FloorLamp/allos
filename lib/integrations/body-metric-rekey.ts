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
// PUSH reconciles what it actually carries: for an incoming reading we can say exactly
// which day it WOULD have been filed under in a zone the profile has left, and delete
// only that row. A day the exporter does not re-send is never touched, in either
// direction, at any offset — the eastward/westward asymmetry falls out of the day
// arithmetic instead of being encoded as a bound.
//
// TWO CONDITIONS, AND ONLY THE SECOND IS A JUDGEMENT CALL.
//
//   1. `switchedAtMs > readingMs` — EXACT, not a heuristic. Allos always keys a row with
//      the zone the profile is on AT THE MOMENT OF THE PUSH. So a reading can only have
//      been filed under a departed zone Z if some push happened while the profile was
//      still on Z, i.e. before it left; and that push cannot have carried a reading that
//      had not happened yet. A reading taken AFTER the profile left Z was therefore never
//      filed under Z by anything, and there is nothing of it there to delete. This is
//      what makes today's freshly-taken reading unable to reach yesterday's stored row
//      no matter which way the profile moved — a property the day arithmetic alone does
//      NOT give you (`day(t, Z)` is `today − 1` for any early-morning reading after a
//      westward move), and the reason the "seeded days survive a switch plus a real
//      push" criterion holds by construction here rather than by choice of offsets.
//
//   2. `SWITCH_LOOKBACK_DAYS` — the owner's ruling says "the `from` of each switch in
//      the last 3 days". THE 3 IS THE OLD `SWEEP_DAYS` NUMBER, and it has never been
//      independently evidenced: the payload census it was argued from lives in
//      `data/integration-payloads/`, which is gitignored and absent from the tree, so no
//      lane can measure it. It is kept because the ruling names it and because it can
//      only ever REMOVE candidate zones, never add one — and it is deliberately doing
//      much less work than it used to. Under the old sweep this number decided how many
//      days of health data were destroyed. Here it decides only how far back the list of
//      departed zones is read; condition 1 decides what is actually deleted, and a
//      widening of this bound cannot make a row eligible that condition 1 refuses.
export const SWITCH_LOOKBACK_DAYS = 3;

const DAY_MS = 86_400_000;

// A zone the profile has left, and the instant it left. `at` is milliseconds since the
// epoch — the comparison in condition 1 is against a reading instant, so it is done in
// absolute time and never in anybody's wall clock.
export interface DepartedZone {
  zone: string;
  at: number;
}

// The stored day a reading was filed under before the move, and the zone that put it
// there. `zone` is carried for the log line and for test readability; the delete keys on
// `date` alone.
export interface RekeyedDay {
  date: string;
  zone: string;
}

// The zones this profile has LEFT recently, newest first, from its recorded switch
// history (`timezone_switches`, #3263). A record whose zone or instant is unusable is
// dropped rather than thrown: this runs on the ingest path, and one corrupt entry must
// not be able to fail a push.
export function departedZones(
  switches: readonly TimezoneSwitch[],
  now: Date,
  lookbackDays: number = SWITCH_LOOKBACK_DAYS
): DepartedZone[] {
  const floor = now.getTime() - lookbackDays * DAY_MS;
  const out: DepartedZone[] = [];
  for (const sw of switches) {
    const at = new Date(sw.at).getTime();
    if (!Number.isFinite(at) || at < floor) continue;
    if (!isValidTimezone(sw.from)) continue;
    out.push({ zone: sw.from, at });
  }
  return out.sort((a, b) => b.at - a.at);
}

// The days one incoming reading may already be stored under, because a departed zone
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
    // Condition 1. Strict: a reading taken at the very instant of the switch is already
    // on the new zone's clock by the time anything can push it.
    if (d.at <= readingMs) continue;
    const was = dateStrInTz(d.zone, readingAt);
    if (was === date || seen.has(was)) continue;
    seen.add(was);
    out.push({ date: was, zone: d.zone });
  }
  return out;
}
