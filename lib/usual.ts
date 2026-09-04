// ONE USUAL (issue #5143) — "what does this person usually do", answered once.
//
// Six domains derived a habit from history, each with its own window, its own floor
// and its own fallback, and only one of them had the order written down. That one —
// `practiceDurationPrefill` (#2204) — states the rule all six should follow:
//
//   1. the RECORDED usual, the centre of a recent window of this person's own history;
//   2. else a DECLARED value, the one place a person states it themselves;
//   3. else nothing. The app does not invent a habit for someone who has none.
//
// This is that order as a function, with the per-kind differences moved into the table
// below so they are visible in one place rather than discovered one module at a time.
//
// ── THE CENTRE IS PER KIND, AND THAT IS NOT COSMETIC ─────────────────────────
// The six do not share one centre and were never going to: sleep's typical times take
// a MEDIAN over noon-relative minutes, the recovery usual takes a MEAN, and the
// practice prefill takes a MODE with a newest-wins tie-break. #5143 puts every window
// and floor out of scope for changing, and the same has to hold for the centre — a
// unified median would silently move four fixtures' answers, which is the opposite of
// an extraction. So `centre` is a field of the table, not a decision made here.
//
// ── TWO KINDS OF WINDOW, AND ONLY ONE OF THEM IS THIS FUNCTION'S ─────────────
// A COUNT window — the recovery usual's ten events, the prefill's sessions — is
// applied here, because it is arithmetic over the samples themselves. A DAY window —
// sleep's 28 nights, food's 21 days — belongs to the caller's query, and this function
// never sees a date. The table records both so the differences are legible together,
// but `windowDays` is a statement ABOUT a caller rather than something executed here.
// Writing that down beats pretending one function applies both.

import { median } from "./robust-stats";
import { modalValue } from "./weekly-rhythm";

/** How a kind reduces its samples to one number. */
export type UsualCentre = "median" | "mean" | "mode";

export interface UsualKind {
  /**
   * How many of the newest samples count, or null when every sample does. Applied
   * here; see the header for why a day window is not.
   */
  recentCount: number | null;
  /**
   * The trailing window a CALLER's query spends, in days, or null when it counts
   * events instead. Declared for legibility; nothing here reads it.
   */
  windowDays: number | null;
  /** Fewest samples below which this kind has no recorded usual. */
  minSamples: number;
  centre: UsualCentre;
}

/**
 * WHAT EACH KIND SPENDS, in one place (#5143).
 *
 * Every number here is what shipped before this table existed. Changing one is a
 * behaviour change and belongs to whichever issue wants it, not to the extraction.
 */
export const USUAL_KINDS = {
  /** Bed and wake clock minutes, noon-anchored by the caller (#1117/#160). */
  sleepClock: {
    recentCount: null,
    windowDays: 28,
    minSamples: 14,
    centre: "median",
  },
  /** Recovery and effort minutes over recent events (#4897). */
  eventPhysiology: {
    recentCount: 10,
    windowDays: null,
    minSamples: 3,
    centre: "mean",
  },
  /** A practice's own duration, most common wins, newest breaks a tie (#2204). */
  practiceDuration: {
    recentCount: null,
    windowDays: null,
    minSamples: 1,
    centre: "mode",
  },
} as const satisfies Record<string, UsualKind>;

export type UsualKindName = keyof typeof USUAL_KINDS;

function centreOf(
  values: readonly number[],
  centre: UsualCentre
): number | null {
  if (values.length === 0) return null;
  if (centre === "mode") return modalValue(values);
  if (centre === "median") return median(values);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The recorded usual alone — leg 1, with no declared fallback.
 *
 * Separate because two callers need exactly this and nothing else: a surface that
 * renders "usually 20 minutes" beside a stated value must not print the stated value
 * back as if history had produced it.
 *
 * `samples` is NEWEST FIRST, the order every reader here already gathers in — which is
 * also what makes `mode`'s tie-break "the newest wins".
 */
export function recordedUsual(
  samplesNewestFirst: readonly number[],
  kind: UsualKind
): number | null {
  const recent =
    kind.recentCount == null
      ? samplesNewestFirst
      : samplesNewestFirst.slice(0, kind.recentCount);
  if (recent.length < kind.minSamples) return null;
  return centreOf(recent, kind.centre);
}

/**
 * The three legs: recorded, else declared, else nothing.
 *
 * A declared value at or below zero is treated as absent rather than obeyed — a zero
 * duration or a zero rest is not a statement anybody means, and seeding one would put
 * an impossible value in front of a person (#2204 constraint 2).
 */
export function usual(
  samplesNewestFirst: readonly number[],
  declared: number | null,
  kind: UsualKind
): number | null {
  const recorded = recordedUsual(samplesNewestFirst, kind);
  if (recorded != null) return recorded;
  if (declared != null && Number.isFinite(declared) && declared > 0)
    return declared;
  return null;
}
