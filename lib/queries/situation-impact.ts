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
import { WEATHER_SITUATIONS } from "../weather-situations";
import {
  getWeatherSituationWindows,
  weatherSituationsRelevant,
} from "./weather-situations";

// The automatic outcome set the impact cards compare — a small default drawn from the
// SAME registry protocols use (lib/protocol-metrics): sleep regularity, body weight, and
// resting heart rate, the three the #1297 headline names. One metric vocabulary, two
// window sources (#221). SRI leads so "did Travel wreck my sleep" reads first.
export const DEFAULT_SITUATION_METRIC_KEYS = [
  "index:sri",
  "metric:weight",
  "metric:resting_hr",
] as const;

// Every situation's pooled impact card for a profile (#1297). Declared situations take
// their windows from the transition log (a derived Poor sleep / Period writes none, so
// it never appears); WEATHER situations (#1726) take theirs from the cached daily series
// via the predicates, which is reconstructable without writing anything. Each situation
// with enough windowed history AND a computable outcome renders. `today` is the profile-local date (tz-window convention); `weightUnit` threads
// the display unit into the weight series (the units boundary lives in resolveOutcomeSeries).
// Sorted most-during-days first so the situation with the richest history leads.
export function getSituationImpacts(
  profileId: number,
  today: string,
  weightUnit: WeightUnit
): SituationImpact[] {
  const events = getSituationEvents(profileId);
  // Weather windows come from the cached series, not the transition log, so a profile
  // with weather data but no declared situation still gets cards.
  const weatherRelevant = weatherSituationsRelevant(profileId, today);
  if (events.length === 0 && !weatherRelevant) return [];

  const series: OutcomeSeries[] = DEFAULT_SITUATION_METRIC_KEYS.map((k) =>
    resolveOutcomeSeries(profileId, k, weightUnit)
  ).filter((s): s is OutcomeSeries => s != null);

  const impacts: SituationImpact[] = [];
  for (const name of declaredSituationNames(events)) {
    const windows = situationWindows(name, events, today);
    const impact = buildSituationImpact({ situation: name, windows, series });
    if (impact) impacts.push(impact);
  }

  // ---- Weather situations (#1726 payoff 2) ----
  // The SAME pooled comparison engine, a different WINDOW SOURCE — no new correlation
  // code, which is the whole point of making weather a situation. The #1360 rule that a
  // derived situation contributes no windows was written for per-day verdicts (poor
  // sleep, period) that leave no reconstructable span. A weather spell is different: it
  // is a fact in a cached series, identical every time it is recomputed, so its windows
  // are derivable without anything ever being written. Still no transitions, still no
  // machine-written situations row.
  //
  // A weather situation the user has ALSO declared manually is skipped here: its
  // transition log already produced a card above, and two cards for one name would be
  // the same question answered twice (#221).
  if (weatherRelevant) {
    const declaredNames = new Set(
      declaredSituationNames(events).map((n) => n.toLowerCase())
    );
    for (const name of WEATHER_SITUATIONS) {
      if (declaredNames.has(name.toLowerCase())) continue;
      const windows = getWeatherSituationWindows(profileId, name, today);
      const impact = buildSituationImpact({ situation: name, windows, series });
      if (impact) impacts.push(impact);
    }
  }

  return impacts.sort(
    (a, b) =>
      b.duringDays - a.duringDays || a.situation.localeCompare(b.situation)
  );
}
