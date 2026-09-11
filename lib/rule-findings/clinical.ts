// Clinical and reproductive rule findings (#2962).
//
// Oral health, prolonged bleeding, the trying-to-conceive workup prompt and sun
// exposure each read a clinical record — a condition, a cycle, a profile attribute, a
// biomarker — rather than a log of behavior, and each stays a calm COACHING observation
// by product ruling (docs/internals/findings.md): none of them notifies, and none
// interprets a result for the person.

import {
  getIntakeSafetyContext,
  getBiomarkerSeries,
  getCanonicalResultDefinition,
  getDaylightOutdoorMinutesTotal,
} from "../queries";
import { getHomeLocation, getProfileSex, getProfileAge } from "../settings";
import { isMinor } from "../life-stage";
import { optimalStatus } from "../reference-range";
import {
  decideSunExposure,
  SUN_EXPOSURE_WINDOW_DAYS,
  SUN_EXPOSURE_WINDOW_WEEKS,
} from "../sun-exposure";
import { prolongedBleedingObservations } from "../cycle-observation";
import { listCyclePeriods } from "../cycle-store";
import { decideWorkupPrompt } from "../ttc";
import { getTtcStart } from "../settings/profile-attrs";
import { getRiskAttributes } from "../settings";
import { decidePeriodontalObservation } from "../oral-health-observation";
import {
  deriveRiskFactors,
  EMPTY_RISK_ATTRIBUTES,
} from "../risk-stratification";
import { lastNDates } from "../date";
import {
  FINDING_DASHBOARD_RELEVANCE,
  type RollupOnlyFinding,
} from "../findings";
import { COACHING_ENTITY_FINDING_LIMITS } from "./limits";

// ---- Oral health: diabetes↔periodontitis link (coaching tier only, #706) ----

// A calm, informational coaching finding for a profile with active diabetes: the
// bidirectional gum-health ↔ glycemic-control link, worth knowing alongside the
// (separately surfaced) tighter dental cadence. Coaching tier ONLY (#449): it joins
// collectCoachingFindings, its dedupeKey rides the shared suppression bus
// (ORAL_HEALTH_PREFIX is registered in RULE_FINDING_PREFIXES), and it NEVER notifies
// / never reaches the hero. "Has diabetes" is resolved through the SAME
// deriveRiskFactors engine the visit-cadence tightening uses, so the note and the
// tightened dental cadence key on one answer (one question, one computation). No
// owned SQL is added here (reads through the profile-scoped intake-safety gather).
export function buildOralHealthFindings(
  profileId: number
): RollupOnlyFinding[] {
  // Active conditions from the ONE shared intake-safety gather (#661).
  const conditions = getIntakeSafetyContext(profileId).conditions;
  const factors = deriveRiskFactors({
    familyConditions: [],
    activeConditions: conditions,
    attributes: EMPTY_RISK_ATTRIBUTES,
  });
  const obs = decidePeriodontalObservation({
    hasDiabetes: factors.has("diabetes"),
  });
  if (!obs) return [];
  return [
    {
      domain: "oral-health",
      dedupeKey: obs.dedupeKey,
      title: obs.title,
      detail: obs.detail,
      // Calm FYI — informational, never an alarm and never a push.
      tone: "info",
      // Coaching-tier ONLY means the rollup is this note's whole reach, so it
      // declares rollup relevance explicitly (#3129).
      dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
      evidence:
        "Diabetes and periodontitis are bidirectionally linked (ADA / AAP).",
      actionHref: "/records/history/visits",
      actionLabel: "Dental care",
    },
  ];
}

// ---- Prolonged bleeding (#1682 fix b) --------------------------------------

// A calm note for a recorded period at or past PROLONGED_PERIOD_DAYS bleeding days.
// The write path deliberately STORES such a period unrefused — refusing it would make
// the app unable to record a genuine emergency — so the observation is how the app says
// what it noticed. COACHING tier by hard product contract (#449): it joins
// collectCoachingFindings, its dedupeKey (`cycle-bleeding:<period_start>`,
// CYCLE_BLEEDING_PREFIX registered) rides the shared suppression bus, and it NEVER
// notifies / never reaches the hero — cycle carries no obligation, and a body-state
// observation must never arrive as a push. Reads the SAME profile-scoped period history
// every cycle surface derives from (listCyclePeriods), so the note and the recorded row
// can't disagree about a period's length. No owned SQL added here.
export function buildCycleBleedingFindings(
  profileId: number,
  today: string
): RollupOnlyFinding[] {
  return prolongedBleedingObservations(listCyclePeriods(profileId), today)
    .slice(0, COACHING_ENTITY_FINDING_LIMITS.prolongedBleeding)
    .map((obs) => ({
      domain: "cycle-bleeding",
      dedupeKey: obs.dedupeKey,
      title: obs.title,
      detail: obs.detail,
      // Calm, observational — never an alarm, never a push (coaching tier).
      tone: "info",
      dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
      evidence:
        "Recorded from your own period log — informational, not a diagnosis.",
      actionHref: "/medical/cycles",
      actionLabel: "View cycle log",
    }));
}

// ---- Trying-to-conceive workup prompt (#1680) ------------------------------

// A calm note once someone has been trying for the standard threshold — 12 months, or 6
// from age 35 — suggesting that a clinician conversation is the usual next step.
//
// COACHING tier by hard product contract (#449): it joins collectCoachingFindings, its
// dedupeKey (`ttc-workup:<declared start>`, TTC_WORKUP_PREFIX registered in
// RULE_FINDING_PREFIXES) rides the shared suppression bus, and it NEVER notifies and never
// reaches dashboard Now. TTC carries no obligation (the attention doctrine), and a
// fertility timeline arriving as a push would be the single worst place for it.
//
// Gated on the DECLARED start only — nothing here infers that someone is trying — and it
// goes silent during a pregnancy. The copy states elapsed time and the usual next step:
// no cause, no odds, no encouragement, no milestone (the #716/#992 sensitivity precedent).
// No owned SQL added here.
export function buildTtcWorkupFindings(
  profileId: number,
  today: string
): RollupOnlyFinding[] {
  // Adult-only content, the same `!isMinor` line the other adult-topic surfaces use.
  if (isMinor(getProfileAge(profileId))) return [];
  const prompt = decideWorkupPrompt({
    ttcStart: getTtcStart(profileId),
    today,
    age: getProfileAge(profileId),
    pregnant: getRiskAttributes(profileId).pregnant,
  });
  if (!prompt) return [];
  return [
    {
      domain: "ttc-workup",
      dedupeKey: prompt.dedupeKey,
      title: prompt.title,
      detail: prompt.detail,
      tone: "info",
      // The cycles page shows elapsed months, never this workup suggestion —
      // the rollup is the prompt's only surface, so it clears the floor
      // explicitly (#3129).
      dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
      evidence:
        "Counted from the start date you recorded — informational, not a diagnosis.",
      actionHref: "/medical/cycles",
      actionLabel: "View cycle log",
    },
  ];
}

// ---- Domain: sun exposure (coaching tier only, issue #571) ----------------

// The vitamin-D outcome family: getBiomarkerSeries collapses D2/D3/total to one
// series (#482), so any member name resolves the whole family. This literal is a
// catalog member name (the passport reads the same one).
const VITAMIN_D_CANONICAL = "Vitamin D, 25-Hydroxy";

// A calm, OBSERVATIONAL coaching finding when a profile has logged little daylight-
// outdoor time over the recent window AND its last vitamin D was below optimal.
// Coaching tier only: it joins collectCoachingFindings, its dedupeKey rides the
// shared suppression bus (SUN_EXPOSURE_PREFIX is registered in RULE_FINDING_PREFIXES),
// and it NEVER notifies / never reaches the hero. Copy stays observational — sun
// exposure is dual-edged, so it surfaces the data and prescribes nothing. Needs a
// home location (else the daylight math is meaningless) → otherwise empty.
export function buildSunExposureFindings(
  profileId: number,
  today: string
): RollupOnlyFinding[] {
  const home = getHomeLocation(profileId);
  if (!home) return [];

  // Latest vitamin-D reading (family-collapsed, oldest→newest → last is latest).
  const series = getBiomarkerSeries(profileId, VITAMIN_D_CANONICAL);
  const latest = series.at(-1);
  if (!latest || latest.value_num == null) return [];

  const cb = getCanonicalResultDefinition(
    latest.canonical_name ?? VITAMIN_D_CANONICAL
  );
  const status = optimalStatus(
    latest.value_num,
    cb,
    getProfileSex(profileId),
    getProfileAge(profileId)
  );

  // Daylight-outdoor minutes over the window — the ONE computation (lib/queries/sun),
  // averaged to a per-week figure the copy formats.
  const dates = lastNDates(today, SUN_EXPOSURE_WINDOW_DAYS);
  const totalMin = getDaylightOutdoorMinutesTotal(profileId, dates);
  const avgWeeklyDaylightMin = totalMin / SUN_EXPOSURE_WINDOW_WEEKS;

  const obs = decideSunExposure({
    hasHomeLocation: true,
    avgWeeklyDaylightMin,
    vitaminDStatus: status,
    vitaminDValue: latest.value_num,
    vitaminDUnit: latest.unit,
    vitaminDDate: latest.date,
  });
  if (!obs) return [];

  return [
    {
      domain: "sun-exposure",
      dedupeKey: obs.dedupeKey,
      title: obs.title,
      detail: obs.detail,
      // Calm FYI — a neutral observation, never an alarm.
      tone: "info",
      // Coaching-tier only with no origin tab of its own: the rollup is this
      // observation's whole reach, declared explicitly (#3129).
      dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
      // The biomarker browser lives on Results (#1164 merged the Trends duplicate in).
      actionHref: "/results/clinical-results",
      actionLabel: "View biomarkers",
    },
  ];
}
