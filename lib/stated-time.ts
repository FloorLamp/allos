// ONE "WHEN DID THIS HAPPEN?" MODEL (issue #2236) — the pure half of the shared
// event-time control (components/WhenControl.tsx).
//
// ── THE VALUE ────────────────────────────────────────────────────────────────
//
// A stated event time is a PAIR: the row's profile-local `date` and the stated
// instant `statedAt` — an ISO UTC instant somebody actually SAID, or null meaning
// "not stated". The pair carries one invariant that no two independent widgets can
// enforce: the stated instant's profile-local date IS the row's date. Every
// constructor in this module either builds the instant FROM the date (so the rule
// holds by construction) or verifies it and refuses.
//
// `statedAt` is never a record stamp and never a coalesced fallback. A caller that
// holds `given_at ?? taken_at` does not hold a statement — it holds a filing
// timestamp wearing one's clothes (#2228's laundering defect) — so the type is
// `string | null` and null RENDERS EMPTY rather than being filled in. Nothing here
// defaults to now: an absent statement stays absent (#2053's rule).
//
// ── WHY THE MODULE IS DOMAIN-NEUTRAL ─────────────────────────────────────────
//
// The acceptance rule below was born as `acceptEatenAt` (lib/food-eating-time.ts,
// #2053) wearing a food name, while nine other surfaces asked the identical
// question with no shared anything. The rule is not about food: "not meaningfully
// in the future, and on the row's own day" is what keeps ANY dated observation
// from contradicting itself. Food re-exports it; the day-hours offer that #2227
// specified as `eatingHoursOnDate` is born here as `statedHoursOnDate`, and the
// food module keeps only its genuinely-food reach-back-from-now offer.
//
// NO DB, NO AMBIENT CLOCK — every function takes its `now`.

import { dateStrInTz, zonedDateParts, zonedWallTimeToUtc } from "./date";

// The pair the shared control renders and emits. One value, both grains.
export interface WhenValue {
  // The row's profile-local day, YYYY-MM-DD.
  date: string;
  // The stated instant (ISO UTC), or null = "not stated" — a real answer, never
  // a gap to fill. When non-null, its profile-local date is `date`.
  statedAt: string | null;
}

// One offered hour of a named day: the local wall time the option shows and the
// instant it means. Resolved from the profile's timezone so the browser never
// converts a profile-local hour with its own locale.
export interface StatedHourOption {
  hhmm: string;
  iso: string;
}

// Tolerated clock difference between a client and the server before a stated
// instant reads as future. Five minutes of skew is neither a forgery nor a broken
// clock (the same tolerance the dose given_at guard uses).
export const STATED_FUTURE_SKEW_MS = 5 * 60 * 1000;

// The instant a statement should actually carry, or null meaning "record no
// stated time". THE one acceptance gate (moved from lib/food-eating-time.ts's
// acceptEatenAt, #2053): two rules, and the second is the load-bearing one —
//
//   1. not meaningfully in the future (beyond STATED_FUTURE_SKEW_MS), and
//   2. the instant's profile-local date IS the row's `date`.
//
// An instant outside its own row's day is not a correction, it is corruption:
// `date` is what dose, adherence, cadence and the digest key on, and a stated
// instant that disagrees with it makes the row answer two questions differently.
//
// What a refusal COSTS is the caller's decision, deliberately: a log path treats
// null as "keep the row, drop the statement" (losing the stated minute is
// cosmetic, losing the serving is not), while a correction path — where the
// statement IS the whole submission — surfaces it as an error the user sees.
export function acceptStatedAt(
  statedAt: Date | null | undefined,
  tz: string,
  date: string,
  now: Date
): Date | null {
  if (!statedAt || Number.isNaN(statedAt.getTime())) return null;
  if (statedAt.getTime() > now.getTime() + STATED_FUTURE_SKEW_MS) return null;
  return dateStrInTz(tz, statedAt) === date ? statedAt : null;
}

// Anchor a wall clock on a named day, enforcing the pair rule by construction:
// the returned instant's profile-local parts are exactly (`date`, `hhmm`), or the
// answer is null. The round-trip check is what makes it DST-honest — a wall time
// inside a spring-forward gap settles onto a different clock reading, which would
// silently change what the user stated, so it is refused instead.
//
// No future check here: whether "later today" is acceptable is the acceptance
// gate's question (`acceptStatedAt`), asked at the write boundary against the
// server's clock — not this constructor's.
export function statedInstantOnDate(
  date: string,
  hhmm: string,
  tz: string
): Date | null {
  const inst = zonedWallTimeToUtc(tz, date, hhmm);
  if (!inst) return null;
  const parts = zonedDateParts(tz, inst);
  return parts.date === date && parts.hhmm === hhmm ? inst : null;
}

// The hours of `date` an event may be stated to have happened at, each carrying
// the instant it means — the enumerated offer behind the shared control's `hour`
// grain (#2227's `eatingHoursOnDate`, born domain-neutral). Truncated at the
// current local hour when `date` is today (an offer the acceptance gate would
// refuse should never be on screen); the whole day otherwise.
//
// DST-safe via `statedInstantOnDate`: a spring-forward day simply lacks its
// nonexistent hour (23 options, none duplicated), and a fall-back day offers each
// wall hour once, settled onto one instant.
export function statedHoursOnDate(
  date: string,
  tz: string,
  now: Date
): StatedHourOption[] {
  const today = dateStrInTz(tz, now);
  const out: StatedHourOption[] = [];
  for (let h = 0; h < 24; h++) {
    const hhmm = `${String(h).padStart(2, "0")}:00`;
    const inst = statedInstantOnDate(date, hhmm, tz);
    if (!inst) continue;
    if (date === today && inst.getTime() > now.getTime()) continue;
    out.push({ hhmm, iso: inst.toISOString() });
  }
  return out;
}

// Re-anchor a stated instant onto a new day, keeping its wall-clock time — what
// the shared control does when the DATE half of the pair changes, so the two
// fields cannot come apart. Null stays null (a date change never invents a
// statement), and the result is null — cleared, never guessed — when the wall
// time does not exist on the new day (a DST gap) or would land meaningfully in
// the future (moving an afternoon statement onto a morning today).
export function reanchorStatedAt(
  statedAt: string | null,
  newDate: string,
  tz: string,
  now: Date
): string | null {
  if (statedAt === null) return null;
  const from = new Date(statedAt);
  if (Number.isNaN(from.getTime())) return null;
  const inst = statedInstantOnDate(newDate, zonedDateParts(tz, from).hhmm, tz);
  return acceptStatedAt(inst, tz, newDate, now)?.toISOString() ?? null;
}

// The display half of a stated instant: its profile-local wall clock, or "" for
// "not stated" — what a time input renders as its value.
export function statedHhmm(statedAt: string | null, tz: string): string {
  if (statedAt === null) return "";
  const d = new Date(statedAt);
  return Number.isNaN(d.getTime()) ? "" : zonedDateParts(tz, d).hhmm;
}
