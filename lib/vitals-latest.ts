// The Latest-vitals dashboard card's prepared MODEL (#1221, recency floor #2303).
// PURE — no DB, no clock: the page gathers the two bounded trend tails, reduces each
// through `latestTrend`, and hands the results here; the card is a thin formatter over
// what comes back (#221).
//
// ── The question this module asks ────────────────────────────────────────────────────
// "May this card present this reading as your CURRENT value?" — a PRESENTATION floor,
// not a retest clock. `biomarkerRetestStatus` answers a different question over the same
// substrate and returns `not-applicable` for `category === "vitals"` on stated grounds
// ("physiologic vitals are monitored, not redrawn on a yearly cadence"), and that stays
// exactly as it is. Nothing here creates a "BP retest due" nudge, an Upcoming row, or a
// notification: this is one card's copy.
//
// The principle is #1216's, not a new one. That issue put a recency floor on the Recent
// labs widget — same dashboard, same glance context — because "a value beyond it read as
// 'current' on a glance dashboard is the dishonesty this closes". Vitals never inherited
// it (LAB_CATEGORIES is `lab` only, #1076), and this card shipped afterwards, so a
// four-year-old blood pressure rendered as a headline number with a trend arrow.
//
// Both floors resolve through `freshnessState` (lib/freshness.ts), so the repo holds ONE
// staleness decision and this module supplies only what is genuinely its own: which
// interval applies per quantity.

import {
  freshnessAgeDays,
  freshnessState,
  type FreshnessState,
} from "./freshness";
import type { LatestTrend, TrendDirection } from "./latest-trend";

// The two quantities this card renders. Deliberately not a general per-metric table:
// a presentation floor is glance-framing policy, and METRIC_KNOWLEDGE (clinical
// knowledge source) is the wrong home for one. A third surface needing floors is when
// a registry earns its keep.
export type VitalQuantity = "blood-pressure" | "resting-hr";

export interface VitalPresentationFloor {
  // Days after which the card stops implying the reading is current. Stale STRICTLY
  // after (the shared boundary): a reading exactly this old is still current.
  days: number;
  // How long that interval reads in a sentence, so the card's explanatory copy and the
  // number it explains cannot drift apart. The SENTENCE stays in the component —
  // phrasing is per surface — this is just the interval said in words.
  label: string;
}

// The floors decide FRAMING, never visibility — the same posture as #1216's round 365,
// which is why round figures are honest here and the exact numbers are low-stakes.
export const VITAL_PRESENTATION_FLOORS: Record<
  VitalQuantity,
  VitalPresentationFloor
> = {
  // A daily wearable stream. Two weeks of silence means the device stopped, or stopped
  // being worn; whatever it last said, it is not "your resting heart rate" now.
  "resting-hr": { days: 14, label: "two weeks" },
  // Episodic by nature — a weekly logger, or an annual physical. A reading a few months
  // old is legitimately the most recent real measurement; past half a year the card must
  // stop implying currency.
  "blood-pressure": { days: 180, label: "six months" },
};

// The presentation verdict for one dated vital, through the shared decision. `today` is
// the PROFILE-local day (#1186), never the server's.
export function vitalPresentationFreshness(
  quantity: VitalQuantity,
  date: string | null | undefined,
  today: string | null | undefined
): FreshnessState {
  return freshnessState(
    freshnessAgeDays(date, today),
    VITAL_PRESENTATION_FLOORS[quantity].days
  );
}

// A trend arrow is a claim about NOW ("up versus previous"), so it may only ride a
// reading the card is still presenting as current. `not-applicable` (an undatable
// reading) withholds it too: no age is knowable, so no claim either way.
export function presentedDirection(
  direction: TrendDirection | null,
  freshness: FreshnessState
): TrendDirection | null {
  return freshness === "current" ? direction : null;
}

// What each row of the card carries. The two rows age INDEPENDENTLY — a resting HR from
// yesterday next to a blood pressure from 2022 is the exact shape #2303 reported — so
// freshness is per row, never per card.
export interface VitalsLatestRow {
  date: string;
  freshness: FreshnessState;
  direction: TrendDirection | null;
}

export interface VitalsLatestModel {
  bp: (VitalsLatestRow & { systolic: number; diastolic: number }) | null;
  restingHr: (VitalsLatestRow & { value: number }) | null;
}

// Build the card's model from the reduced series. Returns null when neither quantity has
// a reading at all — the page's data-aware CTA state. A row that is `due` is KEPT at full
// prominence: the fix is what the card CLAIMS, never what it hides (the freshness
// doctrine, and #1216's precedent one card over).
export function vitalsLatestModel(
  systolic: LatestTrend | null,
  diastolic: LatestTrend | null,
  restingHr: LatestTrend | null,
  today: string
): VitalsLatestModel | null {
  // A BP row needs both halves; it is dated by the systolic reading, which the paired
  // gather takes from the same record set.
  const bp =
    systolic && diastolic
      ? (() => {
          const freshness = vitalPresentationFreshness(
            "blood-pressure",
            systolic.date,
            today
          );
          return {
            systolic: systolic.value,
            diastolic: diastolic.value,
            date: systolic.date,
            freshness,
            direction: presentedDirection(systolic.direction, freshness),
          };
        })()
      : null;
  const hr = restingHr
    ? (() => {
        const freshness = vitalPresentationFreshness(
          "resting-hr",
          restingHr.date,
          today
        );
        return {
          value: restingHr.value,
          date: restingHr.date,
          freshness,
          direction: presentedDirection(restingHr.direction, freshness),
        };
      })()
    : null;
  return bp || hr ? { bp, restingHr: hr } : null;
}
