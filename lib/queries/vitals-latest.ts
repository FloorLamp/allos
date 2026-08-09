// The Latest-vitals dashboard card's gather (#1221 / #1367 / #2303).
//
// The card reads only the last two points of each series, so this pulls the bounded
// trend TAILS (getLatestBiomarkerTrendPoints / getLatestBodyMetricDailyPoints) rather
// than materializing years of synced readings per render — they return exactly the
// points the full series' tail would.
//
// The decisions all live in the pure layer: `latestTrend` reduces each tail to a value
// plus a direction (and withholds the direction for a same-day pair), and
// `vitalsLatestModel` applies the per-quantity presentation floor through the shared
// `freshnessState`. This module is the seam between them and SQL, and exists so the whole
// model — not just its parts — has one DB-tier regression to point at.

import { getLatestBiomarkerTrendPoints } from "./medical";
import { getLatestBodyMetricDailyPoints } from "./metrics";
import { latestTrend } from "../latest-trend";
import { vitalsLatestModel, type VitalsLatestModel } from "../vitals-latest";

// `todayStr` is the PROFILE-local day, resolved at the auth boundary and passed in, so
// the server's local day can never decide how old a profile's reading looks (#1186).
export function getVitalsLatestModel(
  profileId: number,
  todayStr: string
): VitalsLatestModel | null {
  const points = (canonical: string) =>
    getLatestBiomarkerTrendPoints(profileId, canonical).map((r) => ({
      date: r.date,
      value: Math.round(r.value_num as number),
    }));
  const systolic = latestTrend(points("Blood Pressure Systolic"));
  const diastolic = latestTrend(points("Blood Pressure Diastolic"));
  const restingHr = latestTrend(
    getLatestBodyMetricDailyPoints(profileId, "resting_hr").map((w) => ({
      date: w.date,
      value: Math.round(w.value),
    }))
  );
  return vitalsLatestModel(systolic, diastolic, restingHr, todayStr);
}
