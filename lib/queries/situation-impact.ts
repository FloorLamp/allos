// The DB gather seam for situation-window analytics (#1297). The pooling math + window
// derivation are pure (lib/situation-impact.ts, over lib/protocol-compare); this module
// resolves the profile-scoped inputs — the declared transition log + each default outcome
// metric's series — and hands them to the pure builder. No `.prepare` here: every read
// delegates to an already profile-scoped reader (getSituationEvents, resolveOutcomeSeries),
// so the scoping guard is unaffected.

import { getSituationEvents } from "../settings";
import type { WeightUnit } from "../settings";
import { resolveOutcomeSeries } from "./protocols";
import type { OutcomeSeries } from "../protocol-compare";
import {
  buildSituationImpact,
  declaredSituationNames,
  situationWindows,
  type SituationImpact,
} from "../situation-impact";

// The automatic outcome set the impact cards compare — a small default drawn from the
// SAME registry protocols use (lib/protocol-metrics): sleep regularity, body weight, and
// resting heart rate, the three the #1297 headline names. One metric vocabulary, two
// window sources (#221). SRI leads so "did Travel wreck my sleep" reads first.
export const DEFAULT_SITUATION_METRIC_KEYS = [
  "index:sri",
  "metric:weight",
  "metric:resting_hr",
] as const;

// Every declared situation's pooled impact card for a profile (#1297). Windows come from
// the transition log (declared-only — a derived Poor sleep / Period writes none, so it
// never appears); each situation with enough windowed history AND a computable outcome
// renders. `today` is the profile-local date (tz-window convention); `weightUnit` threads
// the display unit into the weight series (the units boundary lives in resolveOutcomeSeries).
// Sorted most-during-days first so the situation with the richest history leads.
export function getSituationImpacts(
  profileId: number,
  today: string,
  weightUnit: WeightUnit
): SituationImpact[] {
  const events = getSituationEvents(profileId);
  if (events.length === 0) return [];

  const series: OutcomeSeries[] = DEFAULT_SITUATION_METRIC_KEYS.map((k) =>
    resolveOutcomeSeries(profileId, k, weightUnit)
  ).filter((s): s is OutcomeSeries => s != null);

  const impacts: SituationImpact[] = [];
  for (const name of declaredSituationNames(events)) {
    const windows = situationWindows(name, events, today);
    const impact = buildSituationImpact({ situation: name, windows, series });
    if (impact) impacts.push(impact);
  }
  return impacts.sort(
    (a, b) =>
      b.duringDays - a.duringDays || a.situation.localeCompare(b.situation)
  );
}
