// The #1490 subject-context BUILDER: gathers the STABLE facts the Trends card
// ranker (lib/trends-card-rank.ts) scores against, once per request.
//
// This is the #448 builder tier — the layer every confirmed rule-engine defect
// actually lived in — so it carries its own DB-tier fixture test
// (lib/__db_tests__/trends-context.test.ts) per scenario, not just pure tests of
// the engine it feeds.
//
// TWO RULES THIS FILE KEEPS:
//
//  1. STABLE FACTS ONLY. Life stage, live goals, active conditions, and whether a
//     series has data — never a VALUE, a threshold crossing, or "today's reading".
//     A default order that moved with this morning's weigh-in would be a feed, and
//     chart cards are a place (#1413/#559).
//
//  2. CHEAP. It runs on every Body-tab render, so presence is measured with
//     aggregate counts (one grouped statement across `metric_samples`, one over
//     `body_metrics`, one over `mood_logs`) and with reads the tab ALREADY makes —
//     `getBiomarkerSeries` is `cache()`d per request, so the five vitals presences
//     are free inside the page that also charts them. Nothing here re-derives a
//     series.
//
// profileId-first and auth-blind (no `lib/auth` import): the page resolves the
// profile from `requireSession()` and passes the id down.

import { db } from "../db";
import { isGrowthTracked } from "../life-stage";
import { isGoalLive } from "../goals";
import { getHomeLocation, getUserAge } from "../settings";
import { HRV_METRIC, SKIN_TEMP_DELTA_METRIC } from "../vitals-input";
import {
  conditionMonitorTags,
  presenceLevel,
  type BodyCardId,
  type PresenceLevel,
  type TrendsSubjectContext,
} from "../trends-card-rank";
import type { BodyMetricKind } from "../types";
import { getConditions } from "./clinical";
import { getGoals } from "./training";
import { getBiomarkerSeries } from "./medical";
import { getLatestHrDay } from "./metrics";

// Card → `metric_samples.metric`. One grouped query answers all of them.
const METRIC_SAMPLE_CARDS: Readonly<Partial<Record<BodyCardId, string>>> = {
  steps: "steps",
  sleep: "sleep_min",
  hrv: HRV_METRIC,
  "skin-temp": SKIN_TEMP_DELTA_METRIC,
  height: "height_cm",
  "head-circ": "head_circumference_cm",
  "lean-mass": "lean_mass_kg",
  "bone-mass": "bone_mass_kg",
  bmr: "bmr_kcal",
  hydration: "hydration_l",
  calories: "nutrition_kcal",
};

// Card → the canonical biomarker its chart plots (`getBiomarkerSeries`, which
// collapses the #482 family). Cached per request, so this costs nothing on the tab
// that also charts them.
const BIOMARKER_CARDS: Readonly<Partial<Record<BodyCardId, string>>> = {
  systolic: "Blood Pressure Systolic",
  diastolic: "Blood Pressure Diastolic",
  spo2: "Oxygen Saturation",
  "respiratory-rate": "Respiratory Rate",
  temperature: "Body Temperature",
};

// Presence from a latest-date alone, for a store too large to count cheaply
// (hr_minutes is per-MINUTE data). A profile with any recorded HR day has plenty of
// points by construction, so recency is the whole question.
function presenceFromLatest(
  latestDate: string | null,
  todayStr: string
): PresenceLevel {
  return presenceLevel(
    latestDate ? Number.MAX_SAFE_INTEGER : 0,
    latestDate,
    todayStr
  );
}

// The weaker of two presences — for a DERIVED card (BMI pairs weight with height;
// the growth card needs heights) so a derived chart is never claimed richer than
// its thinnest input.
function weakest(a: PresenceLevel, b: PresenceLevel): PresenceLevel {
  const rankOf = { none: 0, sparse: 1, rich: 2 } as const;
  return rankOf[a] <= rankOf[b] ? a : b;
}

export function buildTrendsSubjectContext(
  profileId: number,
  todayStr: string
): TrendsSubjectContext {
  // ── Life stage ────────────────────────────────────────────────────────────
  // The ONE shared line (lib/life-stage), the same predicate planBodyCharts and
  // the growth quick-add read — never a second age fork.
  const growthTracked = isGrowthTracked(getUserAge(profileId));

  // ── Live goals ────────────────────────────────────────────────────────────
  // Same liveness definition the chart's own target overlay uses (isGoalLive +
  // a target value), so the card a goal decorates is the card a goal promotes.
  const goalMetrics: BodyMetricKind[] = [
    ...new Set(
      getGoals(profileId)
        .filter((g) => isGoalLive(g) && g.target_value != null)
        .map((g) => g.body_metric)
        .filter((m): m is BodyMetricKind => m != null)
    ),
  ];

  // ── Monitored conditions ──────────────────────────────────────────────────
  const monitors = conditionMonitorTags(
    getConditions(profileId, { status: "active" }).map((c) => ({
      name: c.name,
      code: c.code ?? null,
    }))
  );

  // ── Data presence ─────────────────────────────────────────────────────────
  const presence: Partial<Record<BodyCardId, PresenceLevel>> = {};

  // One grouped pass over the daily-metric store covers eleven cards.
  const sampleRows = db
    .prepare(
      `SELECT metric, COUNT(DISTINCT date) AS n, MAX(date) AS last
         FROM metric_samples WHERE profile_id = ? GROUP BY metric`
    )
    .all(profileId) as { metric: string; n: number; last: string | null }[];
  const byMetric = new Map(sampleRows.map((r) => [r.metric, r]));
  for (const [card, metric] of Object.entries(METRIC_SAMPLE_CARDS)) {
    const row = byMetric.get(metric!);
    presence[card as BodyCardId] = presenceLevel(
      row?.n ?? 0,
      row?.last ?? null,
      todayStr
    );
  }

  // Body composition — one pass, one column per card.
  const body = db
    .prepare(
      `SELECT
         COUNT(weight_kg)     AS n_weight,
         MAX(CASE WHEN weight_kg     IS NOT NULL THEN date END) AS last_weight,
         COUNT(body_fat_pct)  AS n_fat,
         MAX(CASE WHEN body_fat_pct  IS NOT NULL THEN date END) AS last_fat,
         COUNT(resting_hr)    AS n_rhr,
         MAX(CASE WHEN resting_hr    IS NOT NULL THEN date END) AS last_rhr
       FROM body_metrics WHERE profile_id = ?`
    )
    .get(profileId) as {
    n_weight: number;
    last_weight: string | null;
    n_fat: number;
    last_fat: string | null;
    n_rhr: number;
    last_rhr: string | null;
  };
  presence.weight = presenceLevel(body.n_weight, body.last_weight, todayStr);
  presence["body-fat"] = presenceLevel(body.n_fat, body.last_fat, todayStr);
  presence["resting-hr"] = presenceLevel(body.n_rhr, body.last_rhr, todayStr);

  // Mood check-ins.
  const mood = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(date) AS last FROM mood_logs WHERE profile_id = ?`
    )
    .get(profileId) as { n: number; last: string | null };
  presence.mood = presenceLevel(mood.n, mood.last, todayStr);

  // Vitals charted from lab-shaped records.
  for (const [card, canonical] of Object.entries(BIOMARKER_CARDS)) {
    const rows = getBiomarkerSeries(profileId, canonical!);
    presence[card as BodyCardId] = presenceLevel(
      rows.length,
      rows.length > 0 ? rows[rows.length - 1].date : null,
      todayStr
    );
  }

  // Worn heart rate — the intraday card and the daily summary read the same store.
  const hrDay = getLatestHrDay(profileId);
  presence.hr = presenceFromLatest(hrDay, todayStr);
  presence["hr-day"] = presence.hr;

  // Derived cards: BMI pairs each weigh-in with the height in effect, and the
  // growth-percentile card is a height trajectory.
  presence.bmi = weakest(presence.weight ?? "none", presence.height ?? "none");
  presence.growth = presence.height ?? "none";

  // Sun / outdoor daylight has no series of its own to count — it is derived from
  // outdoor activity against the solar day at the HOME LOCATION, and the card is
  // gated on that location existing at all. So the gate IS its presence: no home
  // location, no card; with one, a neutral "sparse" (we don't re-derive the series
  // just to bucket it). Every card in the layout gets an entry — an unmeasured card
  // defaulting to neutral would float above a genuinely empty one under the
  // data-present floor, which is how "nothing tracked yet" would have produced a
  // reshuffled layout instead of the static one.
  presence.sun = getHomeLocation(profileId) ? "sparse" : "none";

  return { growthTracked, goalMetrics, monitors, presence };
}
