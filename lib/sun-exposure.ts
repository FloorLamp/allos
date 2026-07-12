// The PURE decision half of the sun-exposure coaching observation (issue #571).
// Coaching-tier only (findings two-tier policy): it joins collectCoachingFindings,
// its dedupeKey prefix is registered in RULE_FINDING_PREFIXES, and it NEVER notifies
// and never reaches the non-hideable "Needs attention" hero.
//
// COPY STAYS OBSERVATIONAL, NEVER PRESCRIPTIVE. Sun exposure is genuinely dual-edged
// (vitamin D vs. skin-cancer risk), so we surface the DATA — little daylight logged,
// last vitamin D below optimal — and never prescribe UV or sun exposure.
//
// Pure (no DB/clock); the DB input assembly lives in lib/queries/sun +
// buildSunExposureFindings (lib/rule-findings.ts).

// dedupeKey namespace for the suppression bus + the RULE_FINDING_PREFIXES registry.
export const SUN_EXPOSURE_PREFIX = "sun-exposure:";

// The observation window (weeks of daylight-outdoor exposure to average over).
export const SUN_EXPOSURE_WINDOW_WEEKS = 6;

// "Little daylight" threshold: fewer than this many daylight-outdoor MINUTES PER WEEK
// (averaged over the window). ~an hour a week is already generous for "barely any".
export const LOW_WEEKLY_DAYLIGHT_MIN = 60;

// The episode key: the specific below-optimal vitamin-D reading (its date). Once
// dismissed, the observation stays silenced until a NEW vitamin-D reading arrives —
// "dismiss once, silence until it changes" — rather than re-nagging every week.
export function sunExposureSignalKey(vitaminDDate: string): string {
  return `${SUN_EXPOSURE_PREFIX}daylight:${vitaminDDate}`;
}

export interface SunExposureInput {
  hasHomeLocation: boolean;
  // Average daylight-outdoor minutes PER WEEK over the window (the one computation).
  avgWeeklyDaylightMin: number;
  // The latest vitamin-D reading's below/optimal/… status + its value/unit/date.
  vitaminDStatus: "optimal" | "below" | "above" | "unknown";
  vitaminDValue: number | null;
  vitaminDUnit: string | null;
  vitaminDDate: string | null;
}

export interface SunExposureObservation {
  dedupeKey: string;
  title: string;
  detail: string;
}

// Decide whether to surface the observation. Emits ONLY when: a home location is set
// (so the daylight math is meaningful), the last vitamin D is BELOW optimal, and the
// averaged daylight-outdoor exposure is under the "little" threshold. Returns null
// otherwise. Pure.
export function decideSunExposure(
  input: SunExposureInput
): SunExposureObservation | null {
  if (!input.hasHomeLocation) return null;
  if (input.vitaminDStatus !== "below") return null;
  if (input.vitaminDDate == null) return null;
  if (input.avgWeeklyDaylightMin >= LOW_WEEKLY_DAYLIGHT_MIN) return null;

  const perWeek = Math.round(input.avgWeeklyDaylightMin);
  const valueText =
    input.vitaminDValue != null
      ? `${input.vitaminDValue}${input.vitaminDUnit ? ` ${input.vitaminDUnit}` : ""}`
      : "your last reading";
  return {
    dedupeKey: sunExposureSignalKey(input.vitaminDDate),
    title: "Little daylight logged, and vitamin D is below optimal",
    // Observational: states the two facts and their relationship, prescribes nothing.
    // Sun exposure is dual-edged, so it deliberately does not advise more sun/UV.
    detail:
      `Over the last ${SUN_EXPOSURE_WINDOW_WEEKS} weeks you've logged about ` +
      `${perWeek} min/week of outdoor time in daylight, and your last vitamin D ` +
      `(${valueText}) was below the optimal range. Diet, supplements, and sunlight ` +
      `all affect vitamin D — worth discussing with your clinician.`,
  };
}
