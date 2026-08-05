// ONE CLOCK-SKEW CANONICALIZATION (#2088).
//
// "A provider's timestamp disagrees with the profile's clock by a plausible UTC
// offset" is a property of INGEST. It was being evaluated at DETECTION, and
// differently each time: #2011/#2055 taught the duplicate detector to forgive a
// whole-hour gap, #2063/#2092 widened that guard to the half- and three-quarter-hour
// offsets the world actually uses, and #2056 found that the same gap ACROSS MIDNIGHT
// files the two copies under different profile-local dates, where the detector's
// date bucket could not reach them. Three symptoms, one question, three places
// answering it.
//
// This module is the one place. It owns:
//
//   • THE PLAUSIBLE-OFFSET TABLE — which gaps are offset-shaped at all, and how
//     wide a gap stays more plausible as "one session, two clocks" than as "two
//     sessions". Everything downstream reads it; nothing keeps a second copy.
//   • CONTINUOUS-CLOCK ARITHMETIC — two dated wall-clock readings measured from ONE
//     midnight, so a 23:30 reading and a 00:30 reading the next day are an hour
//     apart rather than 23 hours apart. This is the whole of #2056: the arithmetic
//     was right and the FRAME was wrong.
//   • CANONICALIZATION — given a provider timestamp, the profile's timezone, and
//     the candidate readings either side of it, the canonical profile-local
//     date+clock, or a typed refusal.
//
// TWO BRANCHES, AND THE DIFFERENCE BETWEEN THEM IS EVIDENCE:
//
//   A. The provider handed us a TRUE INSTANT. Then the profile-local date and clock
//      follow from the profile's timezone and nothing is inferred — this is
//      knowledge, so it applies to a lone row and is the ingest-side close of the
//      class (see lib/integrations/strava.ts, where a stale `utc_offset` is exactly
//      how #2011's copy arrived an hour early).
//   B. The provider handed us only a WALL CLOCK. Then a skew can only be inferred
//      from cross-source evidence — and #2055 already ruled what the system may
//      conclude from it: that the two clocks disagree, and by how much, but NEVER
//      which of two providers lied. So branch B reports the skew and refuses to pick
//      a winner; the pair goes to a person in Data → Review. A lone row with no
//      evidence gets `no-evidence` and is left exactly as reported.
//
// PURE: no DB, no queries, no `lib/auth`. `zonedDateParts` is Intl arithmetic.

import { daysBetweenDateStr, zonedDateParts, hhmmToMinutes } from "./date";

export const MINUTES_PER_DAY = 1440;

// ── The plausible-offset table ────────────────────────────────────────────────
//
// The gaps REAL UTC OFFSETS differ by. Several are not whole hours: India +5:30,
// Newfoundland -3:30, Nepal +5:45, Chatham +12:45, Eucla +8:45. A provider that
// resolves one of those against a whole-hour neighbour lands its copy 30 or 45
// minutes off — which the original whole-hour-only guard rejected outright, leaving
// the defect silently unfixed for every household in those zones (#2063/#2092).
//
// So an admitted gap is a whole number of hours PLUS one of these minute parts. 15
// is deliberately absent: it is reachable in principle (Chatham read as +13:00,
// Eucla as +9:00 — populations in the hundreds), but the quarter hour is also the
// grid people actually schedule on, so admitting it would spend the safety margin
// below on the least likely misresolution in the world. That residual is the
// documented out-of-scope case, not an oversight.
export const PLAUSIBLE_OFFSET_MINUTE_PARTS: readonly number[] = [0, 30, 45];

// The widest disagreement forgiven. One hour is the common case (a non-DST
// `utc_offset`, a DST boundary); two covers a doubly-wrong offset and travel.
// Beyond that "same session, wrong clock" stops being more plausible than "two
// sessions".
export const MAX_PLAUSIBLE_OFFSET_MIN = 120;

// The narrowest one. Half an hour, not an hour, because of the table above.
export const MIN_PLAUSIBLE_OFFSET_MIN = 30;

/** Is this gap the SHAPE a UTC offset difference has? (Bounds are separate.) */
export function isOffsetShaped(gapMinutes: number): boolean {
  return PLAUSIBLE_OFFSET_MINUTE_PARTS.includes(Math.abs(gapMinutes) % 60);
}

/**
 * The gap when it is a plausible UTC-offset disagreement, else null.
 *
 * THE SHAPE REQUIREMENT IS THE ENTIRE SAFETY MARGIN. Two genuinely distinct
 * back-to-back sessions of similar length do not begin an exact offset apart; an
 * offset copy of ONE session does, exactly. A zero gap is not a disagreement, so it
 * is refused too (the bound starts at MIN_PLAUSIBLE_OFFSET_MIN).
 */
export function plausibleOffsetMinutes(gapMinutes: number): number | null {
  const gap = Math.abs(gapMinutes);
  if (!isOffsetShaped(gap)) return null;
  return gap >= MIN_PLAUSIBLE_OFFSET_MIN && gap <= MAX_PLAUSIBLE_OFFSET_MIN
    ? gap
    : null;
}

/** The gap as a person reads it — "1h", "30m", "1h30m". */
export function formatOffset(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

// ── Continuous-clock arithmetic ───────────────────────────────────────────────

/** A dated wall-clock reading: a profile-local day plus a minute of that day. */
export interface ClockReading {
  date: string;
  minutes: number;
}

/**
 * The reading's minute measured from midnight of `baseDate` — so two readings on
 * DIFFERENT days sit on one continuous axis. Null when either date is unparseable
 * (a gap we decline to guess at). Identical to `r.minutes` when the reading is on
 * the base date, which is every same-day comparison.
 */
export function minutesFromBase(
  r: ClockReading,
  baseDate: string
): number | null {
  const days = daysBetweenDateStr(baseDate, r.date);
  if (days == null) return null;
  return r.minutes + days * MINUTES_PER_DAY;
}

/**
 * The gap between two dated readings, in minutes, measured across their dates.
 *
 * THIS IS #2056. Comparing `a.minutes` to `b.minutes` made a 23:30 reading and the
 * next day's 00:30 copy 1380 minutes apart — an implausible gap that no offset
 * table would ever admit — when they are one hour apart on the clock a person
 * lives on.
 */
export function clockGapMinutes(
  a: ClockReading,
  b: ClockReading
): number | null {
  const bFromA = minutesFromBase(b, a.date);
  if (bFromA == null) return null;
  return Math.abs(bFromA - a.minutes);
}

/** Do these two readings sit on different days? */
export function spansMidnight(a: ClockReading, b: ClockReading): boolean {
  return a.date !== b.date;
}

// ── The near-midnight candidate window ────────────────────────────────────────
//
// A pair can only be COMPARED once both rows have been loaded, and the loaders group
// by profile-local date — so an offset that crossed midnight put the two copies in
// different groups and the comparison never happened (#2056). The candidate phase
// therefore reaches one day either side, bounded by the same offset this module is
// willing to forgive: a row is a near-midnight candidate only within
// MAX_PLAUSIBLE_OFFSET_MIN of the midnight it could have been pushed across.
//
// Deriving the bound here rather than spelling it at each loader is the point: the
// candidate set can never be wider than the classifier's own reach.

export const EVENING_CANDIDATE_MIN = MINUTES_PER_DAY - MAX_PLAUSIBLE_OFFSET_MIN;
export const MORNING_CANDIDATE_MIN = MAX_PLAUSIBLE_OFFSET_MIN;

/** A minute of the day as the "HH:MM" clock the row stores. */
export function clockAtMinute(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export const EVENING_CANDIDATE_CLOCK = clockAtMinute(EVENING_CANDIDATE_MIN);
export const MORNING_CANDIDATE_CLOCK = clockAtMinute(MORNING_CANDIDATE_MIN);

/**
 * Are these two readings on ADJACENT days and close enough to the midnight between
 * them that one session pushed across it is the plausible reading? Order-independent;
 * false for same-day readings (the ordinary date group already holds those) and for
 * any wider date gap.
 */
export function nearMidnightCandidate(
  a: ClockReading | null,
  b: ClockReading | null
): boolean {
  if (!a || !b) return false;
  const days = daysBetweenDateStr(a.date, b.date);
  if (days == null || Math.abs(days) !== 1) return false;
  const [evening, morning] = days === 1 ? [a, b] : [b, a];
  return (
    evening.minutes >= EVENING_CANDIDATE_MIN &&
    morning.minutes <= MORNING_CANDIDATE_MIN
  );
}

// ── Branch A: the profile-local reading of a true instant ─────────────────────

/**
 * Where a TRUE INSTANT falls on the profile's own clock. No inference: the instant
 * is unambiguous and the zone is the profile's own setting, so this is the canonical
 * answer for a lone row and needs no cross-source evidence.
 *
 * This is the same `zonedDateParts` every other #94 day-attribution goes through —
 * an evening event lands on the right local day even though production runs UTC.
 */
export function localReadingOf(instant: Date, tz: string): ClockReading | null {
  if (Number.isNaN(instant.getTime())) return null;
  const { date, hhmm } = zonedDateParts(tz, instant);
  return { date, minutes: hhmmToMinutes(hhmm) };
}

// ── The verdict ───────────────────────────────────────────────────────────────

/**
 * What canonicalization concluded.
 *
 * `canonical` carries a reading to FILE THE ROW UNDER. `skew` carries a
 * disagreement the system can see but must not resolve on its own — #2055's ruling:
 * nothing in a pair of wall clocks says which of two providers lied, so a heuristic
 * there would be the system asserting knowledge it does not have. `refused` is
 * everything else, each reason named so a caller renders the right thing instead of
 * treating "no evidence" and "not offset-shaped" as one silence.
 */
export type ClockCanonicalization =
  | {
      kind: "canonical";
      reading: ClockReading;
      /** Minutes the provider's own wall clock was off by (0 when it agreed). */
      offsetMinutes: number;
      /** False when the row is ALREADY canonical — the idempotent re-run. */
      changed: boolean;
      /** Whether canonicalization moves the row to a different profile-local day. */
      movesDate: boolean;
    }
  | {
      kind: "skew";
      offsetMinutes: number;
      spansMidnight: boolean;
    }
  | {
      kind: "refused";
      reason: "edit-locked" | "no-clock" | "no-evidence" | "not-offset-shaped";
    };

export interface ClockCanonicalizationInput {
  /** The wall clock the provider filed the row under, when it stated one. */
  reported: ClockReading | null;
  /** The true instant behind that row, when the provider sent one. */
  instant?: { at: Date; tz: string } | null;
  /** Candidate readings either side of it — the cross-source evidence. */
  evidence?: readonly ClockReading[];
  /** The #133 lock: the user hand-corrected this row. */
  editLocked?: boolean;
}

/**
 * THE canonicalization (#2088).
 *
 * Order matters and is the policy:
 *
 * 1. An EDIT-LOCKED row is never rewritten, whatever the evidence says. A manual
 *    correction outranks every provider, which is the same stance `isEditLocked`
 *    enforces across every ingest path.
 * 2. A TRUE INSTANT answers outright (branch A) — including `changed: false` when
 *    the row is already canonical, so re-running at ingest is a no-op.
 * 3. Otherwise the row has only a wall clock, so nothing may be concluded from it
 *    ALONE: with no evidence the answer is `no-evidence`, never a speculative shift.
 * 4. With evidence, the smallest plausible offset among the candidates is reported
 *    as a `skew` — a disagreement, named and measured, for a person to resolve.
 */
export function canonicalizeProviderClock(
  input: ClockCanonicalizationInput
): ClockCanonicalization {
  if (input.editLocked) return { kind: "refused", reason: "edit-locked" };

  if (input.instant) {
    const reading = localReadingOf(input.instant.at, input.instant.tz);
    if (!reading) return { kind: "refused", reason: "no-clock" };
    if (!input.reported)
      return {
        kind: "canonical",
        reading,
        offsetMinutes: 0,
        changed: true,
        movesDate: false,
      };
    const gap = clockGapMinutes(input.reported, reading) ?? 0;
    return {
      kind: "canonical",
      reading,
      offsetMinutes: gap,
      changed: gap !== 0,
      movesDate: reading.date !== input.reported.date,
    };
  }

  if (!input.reported) return { kind: "refused", reason: "no-clock" };
  const evidence = input.evidence ?? [];
  if (evidence.length === 0) return { kind: "refused", reason: "no-evidence" };

  let best: { offsetMinutes: number; spansMidnight: boolean } | null = null;
  for (const other of evidence) {
    const gap = clockGapMinutes(input.reported, other);
    if (gap == null) continue;
    const offset = plausibleOffsetMinutes(gap);
    if (offset == null) continue;
    if (!best || offset < best.offsetMinutes)
      best = {
        offsetMinutes: offset,
        spansMidnight: spansMidnight(input.reported, other),
      };
  }
  if (!best) return { kind: "refused", reason: "not-offset-shaped" };
  return { kind: "skew", ...best };
}
