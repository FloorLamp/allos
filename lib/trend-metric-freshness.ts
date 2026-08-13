// PRESENTATION FLOORS for the Trends body-census chart cards (#2615 item 3). PURE — no
// DB, no clock.
//
// THE DEFECT. A full chart card's header carries the metric's name and, beside it, the
// latest plotted value as a big headline. That headline is CURRENT-SHAPED copy: "99.2 °F"
// with nothing attached to it reads as a temperature you have. The census showed exactly
// that over a reading fourteen days old, and the card said nothing about when — the plot
// underneath ran to today's edge with its last mark two weeks back, which is a fact a
// reader has to reconstruct from a 30-day axis instead of being told.
//
// The freshness doctrine's rule is the one being broken: an aggregate with nothing current
// may not render current-shaped copy, and the fix is what it CLAIMS, never what it hides.
// So the value stays exactly where it is, at full prominence, and gains an as-of stamp.
//
// WHICH CLOCK. The DECISION is the shared one (`freshnessState`, lib/freshness.ts); the
// only thing this module supplies is which interval applies to which metric, which is the
// same division of labour `lib/fitness-freshness.ts` and `VITAL_PRESENTATION_FLOORS` each
// use. And the interval genuinely differs per metric: a fortnight-old body temperature is
// history, a fortnight-old adult height is simply your height. One global number would
// have to be wrong for one of those two, which is the argument #2303 already made one card
// over.
//
// A FLOOR IS FRAMING, NEVER VISIBILITY. Nothing here hides a card, drops a point, moves a
// value out of the headline slot, produces a Finding, or reaches a notification. The whole
// consequence is a date beside a number. That is why round figures are honest here and the
// exact days are low-stakes — the same posture the two existing floor registries state.
//
// NO SECOND ANSWER FOR A QUANTITY THAT ALREADY HAS ONE. Blood pressure and resting heart
// rate already have a declared presentation floor (`VITAL_PRESENTATION_FLOORS`, the
// dashboard's Latest-vitals card), so those three slugs take it BY REFERENCE rather than
// restating a number. Two registries disagreeing about how old a blood pressure may be is
// the drift this avoids by construction, not by a review note.

import { VITAL_PRESENTATION_FLOORS } from "./vitals-latest";
import type { VitalPresentationFloor } from "./vitals-latest";
import {
  freshnessAgeDays,
  freshnessState,
  type FreshnessState,
} from "./freshness";
import { TREND_METRIC_SLUGS, type TrendMetricSlug } from "./trend-metrics";

// The named floors, so 27 metrics declare a CADENCE rather than 27 unrelated integers.
// A metric picks the shape of its own arrival; the numbers live here, once.

// Only meaningful right now. A thermometer reading is taken because of a question being
// asked today, and it answers that day and no other.
const ACUTE: VitalPresentationFloor = { days: 7, label: "a week" };

// Arrives on its own, every day something is worn or a check-in is tapped. Two weeks of
// silence means the stream stopped — whatever it last said, it is not your value now.
// This is the same fortnight `VITAL_PRESENTATION_FLOORS["resting-hr"]` argued for.
const STREAM: VitalPresentationFloor = { days: 14, label: "two weeks" };

// Measured when you think of it: a scale, a tape measure. Weeks between readings is
// ordinary and not a lapse; a season is.
const SELF_MEASURED: VitalPresentationFloor = { days: 45, label: "six weeks" };

// Measured when there is a reason — a cuff before an appointment, an oximeter while
// unwell. Months apart is a legitimate cadence.
const EPISODIC: VitalPresentationFloor =
  VITAL_PRESENTATION_FLOORS["blood-pressure"];

// A body attribute that moves over seasons and years. A year-old adult height is still
// your height.
const SLOW: VitalPresentationFloor = { days: 365, label: "a year" };

// Every trend metric's floor. TOTAL over the slug union on purpose: a new metric is a
// compile error here, so the floor is a DECISION and never an oversight (the
// `missingFreshnessPolicies` discipline, expressed as a type because this registry can
// be).
export const TREND_METRIC_PRESENTATION_FLOORS: Record<
  TrendMetricSlug,
  VitalPresentationFloor
> = {
  // ── Vitals with an already-declared floor: taken by reference, never restated. ──
  systolic: VITAL_PRESENTATION_FLOORS["blood-pressure"],
  diastolic: VITAL_PRESENTATION_FLOORS["blood-pressure"],
  "resting-hr": VITAL_PRESENTATION_FLOORS["resting-hr"],

  // ── Acute: the reading is about the day it was taken. ──
  temperature: ACUTE,

  // ── Episodic: picked up for a reason, months apart is normal. ──
  spo2: EPISODIC,
  "respiratory-rate": EPISODIC,

  // ── Streams: a wearable, a daily derivation, a daily check-in. ──
  hrv: STREAM,
  "skin-temp": STREAM,
  "peak-flow": STREAM,
  sun: STREAM,
  steps: STREAM,
  "active-calories": STREAM,
  hr: STREAM,
  hydration: STREAM,
  calories: STREAM,
  mood: STREAM,
  energy: STREAM,
  calm: STREAM,

  // ── Self-measured body composition: a scale step-on or a tape. ──
  weight: SELF_MEASURED,
  "body-fat": SELF_MEASURED,
  "waist-circ": SELF_MEASURED,
  bmi: SELF_MEASURED,
  "lean-mass": SELF_MEASURED,
  "bone-mass": SELF_MEASURED,
  bmr: SELF_MEASURED,

  // ── Slow attributes. ──
  height: SLOW,
  "head-circ": SLOW,
};

// Slugs with no declared floor. Empty by construction (the record above is total), kept as
// a runtime census so the completeness test reads the same way the fitness one does and a
// hand-edited registry cannot quietly shed an entry.
export function missingTrendMetricFloors(
  slugs: readonly TrendMetricSlug[] = TREND_METRIC_SLUGS
): TrendMetricSlug[] {
  return slugs.filter(
    (s) =>
      !Object.prototype.hasOwnProperty.call(TREND_METRIC_PRESENTATION_FLOORS, s)
  );
}

// May a chart card present this metric's latest reading as the current value? `today` is
// the PROFILE-local day (#1186), never the server's. `date` absent ⇒ `not-applicable`:
// nothing is knowable about an undated reading's age, so no claim is withdrawn and none is
// made — never folded into `due`.
export function trendMetricPresentationFreshness(
  slug: TrendMetricSlug,
  date: string | null | undefined,
  today: string | null | undefined
): FreshnessState {
  return freshnessState(
    freshnessAgeDays(date, today),
    TREND_METRIC_PRESENTATION_FLOORS[slug].days
  );
}
