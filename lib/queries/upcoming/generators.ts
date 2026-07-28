// Upcoming-page aggregation. One profile-scoped entry
// point, collectUpcoming(), fans out across the EXISTING forward-looking
// due-signals — reusing each domain's own read + pure helper rather than
// reinventing the logic — and returns a flat UpcomingItem[] for the pure
// banding/sorting layer (lib/upcoming.ts). Every read here is profile-scoped:
// the functions it calls all filter profile_id (enforced by
// lib/__tests__/profile-scoping.test.ts), and the dynamic no-bleed guard lives
// in lib/__db_tests__/upcoming.scoping.test.ts.

import { cache } from "../../request-cache";
import { shiftDateStr } from "../../date";
import {
  signalKey,
  isItemHiddenBySuppression,
  type SuppressionRecord,
} from "../../upcoming-suppress";
import { isDueOn, timeBucket } from "../../supplement-schedule";
import { doseSortKey } from "../../dose-order";
import { formatMedicationDoseProduct } from "../../medication-dose-format";
import {
  daysOfSupplyLeft,
  isLowSupply,
  DEFAULT_LOW_SUPPLY_DAYS,
} from "../../refill";
import {
  biomarkerViewHref,
  intakeHref,
  nutritionTabHref,
  timelineDayHref,
  MEDICATIONS_HREF,
  INSTRUMENTS_HREF,
  SUPPLIES_HREF,
} from "../../hrefs";
import { getInstrumentStates } from "../../instrument-records";
import { mentalHealthCrisisKey, severityBand } from "../../mental-health";
import { crisisFindingLine } from "../../crisis-resources";
import { getResolvedCrisisResources } from "../../settings";
import { refillSignalKey, poolRefillSignalKey } from "../../refill-nudge";
import { getPoolView, poolIdsForProfiles } from "../intake/supply-pool";
import { assessSchedule } from "../../immunization-status";
import { preventiveAssessmentToUpcomingItem } from "../../preventive-upcoming";
import { scheduledMatchForRule } from "../../preventive-appointment";
import {
  isBiomarkerStale,
  isBeyondRetestHorizon,
  retestIntervalDays,
  daysBetween,
} from "../../reference-range";
import { retestDaysForBiomarker, isRetestWorthy } from "../../biomarker-retest";
import {
  biomarkerRetestTitle,
  biomarkerRetestDetail,
} from "../../biomarker-retest-copy";
import {
  retestModulationFor,
  screeningPriorityFor,
  immunizationPriorityFor,
  isAnchoredOneShotReading,
} from "../../risk-stratification";
import { lifeStage } from "../../life-stage";
import { getRiskFactors } from "./risk";
import { biomarkerRetestIdentity } from "../../canonical-name";
import { biomarkerDismissalKey } from "../../dismissal-keys";
import { derivedInputCanonicalNamesFor } from "../../derived-biomarkers";
import {
  getUserSex,
  getUserAgeOn,
  profileAgeMonths,
  getMentalHealthShareFull,
} from "../../settings";
import { getEffectiveActiveSituations } from "../derived-situations";
import { sharedSurfaceDetail } from "../../appointment-sensitivity";
import {
  CANONICAL_DISPLAY_UNITS,
  type UpcomingDisplayUnits,
  type UpcomingItem,
} from "../../upcoming";
import type { DistanceUnit, TemperatureUnit } from "../../settings";
import {
  type Reason,
  riskReasonsFrom,
  flaggedReason,
  situationReason,
  concatReasons,
  plainRiskReasons,
} from "../../reasons";
import { isFlaggedForRetest } from "../../biomarker-retest-copy";
import type { MedicalRecord } from "../../types";
import { pickNextAppointment } from "../../household";
import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getRefillRates,
  getDietaryLimitWarnings,
  getInteractionWarnings,
  getPgxWarnings,
  getContrastSafetyWarnings,
  getDentalSafetyWarnings,
  getOtotoxicWarnings,
  getDrugAllergyWarnings,
  getMedMonitoringItems,
  getPrnOverMaxItems,
} from "../intake";
import { prnMaxSignalKey } from "../../prn-redose";
import {
  dietaryLimitSignalKey,
  ulWarningTitle,
  ulWarningDetail,
} from "../../dri";
import { interactionTitle, interactionDetail } from "../../drug-interactions";
import { pgxTitle, pgxDetail } from "../../pgx";
import {
  contrastTitle,
  contrastDetail,
  type ContrastStudySource,
} from "../../contrast-safety";
import { dentalSafetyTitle, dentalSafetyDetail } from "../../dental-safety";
import { ototoxicTitle, ototoxicDetail } from "../../ototoxic";
import { drugAllergyTitle, drugAllergyFullDetail } from "../../drug-allergy";
import {
  medMonitoringTitle,
  medMonitoringDetail,
} from "../../medication-monitoring";
import { medMonitoringReason } from "../../reasons";
import type { AppRoute } from "../../hrefs";
import { getScheduledAppointments, kindedScheduled } from "../appointments";
import { getActivitiesByDate, isPredictedWorkoutDay } from "../training";
import {
  getMedicalRecords,
  getImmunizations,
  getImmunityTiters,
  getImmunizationOverrides,
} from "../medical";
import { assessProfilePreventive } from "./preventive";
import { getFindingSuppressions } from "./suppressions";
import { illnessCareItems } from "../../illness-care-findings";
import { conditionReviewItems } from "../../condition-suggestion-findings";
import { tempRedFlagItems } from "../../temp-red-flag-findings";
import { followUpItems } from "../../followup-findings";
import { getUvDoseForDay } from "../weather";
import { decideUvOverexposure } from "../../uv-overexposure";
import {
  carePlanItems,
  enduranceEventItems,
  goalItems,
  markCarePlanItemDone,
  practiceItems,
  trainingItems,
} from "./plans";
export { markCarePlanItemDone } from "./plans";
import {
  contrastItems,
  dentalSafetyItems,
  dietaryLimitItems,
  doseItems,
  drugAllergyItems,
  interactionItems,
  medMonitoringItems,
  mentalHealthCrisisItems,
  ototoxicItems,
  pgxItems,
  poolRefillItems,
  prnMaxItems,
  refillItems,
  uvOverexposureItems,
} from "./intake-safety";

// Biomarker categories a retest nudge makes sense for: `lab` ONLY (#1076).
// Vitals/scans/prescriptions aren't "labs to redraw", genomics/reference never go
// stale (handled by isBiomarkerStale), and instruments/derived composites carry no
// retest clock. Kept narrow so the retest signal stays a labs signal. The cadence
// is per-analyte (curated retest_days, default 365) rather than flat.
const RETEST_CATEGORIES = new Set(["lab"]);

function immunizationItems(profileId: number, today: string): UpcomingItem[] {
  const sex = getUserSex(profileId);
  const ageMonths = profileAgeMonths(profileId, today);
  const riskFactors = getRiskFactors(profileId);

  const summary = assessSchedule(
    getImmunizations(profileId).map((r) => ({
      vaccine: r.vaccine,
      date: r.date,
    })),
    ageMonths,
    sex,
    today,
    getImmunityTiters(profileId).map((t) => ({
      marker: t.marker,
      status: t.status,
    })),
    getImmunizationOverrides(profileId).map((o) => ({
      vaccine: o.vaccine,
      kind: o.kind,
    }))
  );

  return summary.assessments
    .filter((a) => a.status === "overdue" || a.status === "due")
    .map((a) => {
      const item: UpcomingItem = {
        key: `immunization:${a.code}`,
        domain: "immunization" as const,
        title: a.name,
        detail: a.nextLabel ?? a.detail,
        href: "/records/history/immunizations",
        dueDate: null,
        band:
          a.status === "overdue" ? ("overdue" as const) : ("today" as const),
        dueText: a.status === "overdue" ? "Overdue" : "Due",
      };
      const { priority, reasons, sourced } = immunizationPriorityFor(
        a.code,
        riskFactors
      );
      if (priority > 0) {
        item.priority = priority;
        const suffix = reasons.join(", ");
        item.detail = item.detail ? `${item.detail} · ${suffix}` : suffix;
        // Carry the SAME cited reasons structurally (issue #656) — detail unchanged.
        item.reasons = riskReasonsFrom(sourced);
      }
      return item;
    });
}

// Combine a screening's two additive risk dimensions (#711): the priority-only
// ranking (screeningPriorityFor — family-history → lipid) and the assessor's
// hereditary-risk cadence reason/priority (screeningModulationFor, stashed on
// riskReasons/riskPriority). Highest priority wins; the cadence reasons lead
// (they explain why it's due sooner), then the ranking reasons, de-duplicated.
function mergeScreeningRisk(
  ranking: { priority: number; reasons: string[] },
  cadenceReasons: string[],
  cadencePriority: number
): { priority: number; reasons: string[] } {
  const reasons: string[] = [];
  for (const r of [...cadenceReasons, ...ranking.reasons]) {
    if (!reasons.includes(r)) reasons.push(r);
  }
  return { priority: Math.max(ranking.priority, cadencePriority), reasons };
}

// Maps the preventive actionable slice into Upcoming items, adding the prefilled
// "Book" CTA and — when a matching-kind visit is already booked (issue #85) — a
// quiet "Scheduled" state (from the profile's still-scheduled appointments). The
// underlying assessment is assessProfilePreventive (./preventive), shared with the
// proactive nudge so the page and the push can never diverge on WHICH items are due.
function preventiveItems(profileId: number, today: string): UpcomingItem[] {
  const scheduled = kindedScheduled(profileId);
  // Risk-stratified priority (issue #517): a screening the profile's risk factors
  // make more important (family cardiac history → lipid screening) ranks up and
  // says why, in a calm line. Cadence of the catalog is unchanged — this is the
  // ranking + explanation side only.
  const riskFactors = getRiskFactors(profileId);
  return assessProfilePreventive(profileId, today).actionable.map((a) => {
    const item = preventiveAssessmentToUpcomingItem(a, {
      today,
      scheduledDate: scheduledMatchForRule(a.key, scheduled, today),
    });
    // A VISIT whose cadence the risk factors tightened (Substrate 3, #707) carries the
    // reason + rank the assessor already computed (riskReasons/riskPriority). A
    // SCREENING has TWO additive risk dimensions: the priority-only ranking from
    // screeningPriorityFor (family-history → lipid) AND, for a hereditary-risk cadence
    // rule (#711 — BRCA → mammography / Lynch → colorectal), the reason + rank the
    // assessor stashed (riskReasons/riskPriority) when it also tightened the interval.
    // Merge them so both surface — one computation each, joined here.
    const { priority, reasons } =
      a.kind === "visit"
        ? { priority: a.riskPriority, reasons: a.riskReasons }
        : mergeScreeningRisk(
            screeningPriorityFor(a.key, riskFactors),
            a.riskReasons,
            a.riskPriority
          );
    if (priority > 0 || reasons.length > 0) {
      if (priority > 0) item.priority = priority;
      const suffix = reasons.join(", ");
      if (suffix)
        item.detail = item.detail ? `${item.detail} · ${suffix}` : suffix;
      // Carry the SAME merged reasons structurally (issue #656). The preventive
      // assessor pre-merges these as plain strings (the visit/hereditary-cadence
      // lines aren't sourced through it yet), so these are text-only reasons —
      // detail unchanged. Threading `source` through the assessor is a follow-up.
      if (reasons.length) item.reasons = plainRiskReasons(reasons);
    }
    return item;
  });
}

// Approximate whole months for a span of days, for the cadence due-text
// ("every 12mo", "tested 14mo ago"). Clamped to at least 1 so a sub-month cadence
// still reads sensibly.
function monthsApprox(days: number): number {
  return Math.max(1, Math.round(days / 30.44));
}

// Biomarkers whose latest reading is past their PER-ANALYTE retest window (reuses
// getMedicalRecords' current-per-group read + isBiomarkerStale, now consulting the
// curated retest_days). The retest-due date is the last reading + that analyte's
// interval, so a quarterly HbA1c reads as overdue far sooner than an annual lipid
// panel; uncurated analytes keep the flat 365-day fallback.
//
// Readings are grouped by the RETEST-clock identity (biomarkerRetestIdentity) — the
// #482 family for every analyte, WIDENED for vitamin D to the broad total+D2+D3 25-OH
// scope (#1193). Almost every analyte is its own family (keyed by canonical name), but
// the interchangeable-clock families (the 25-hydroxy vitamin-D variants
// total/generic/D2/D3, and A1c ↔ eAG) collapse into one: a recent reading of ANY
// member supersedes an old sibling, so the stale variants don't each nag as overdue
// when a fresh family reading exists — even though the D2/D3 fractions now keep their
// OWN identity on the series/dedup/star surfaces (they share only the redraw clock).
// Per family we keep the NEWEST reading; its name → the stable family
// `biomarker:<family>` dismissal key (via biomarkerDismissalKey, which routes through
// the SAME retest identity), so a dismiss on any member silences the family and the
// key doesn't drift as which member is newest changes.
//
// DERIVED-analyte freshness (#482 scope 2): a stored derived index (Non-HDL, eGFR…)
// inherits its INPUTS' freshness — re-drawing Total + HDL re-derives Non-HDL — so we
// take the newest of (the reading, its input readings) as the effective last-tested
// date. A non-derived analyte has no inputs, so its effective date is just its own.
function biomarkerItems(profileId: number, today: string): UpcomingItem[] {
  const latest = getMedicalRecords(profileId, { current: true });
  // Newest reading date per family across ALL current readings — the input→derived
  // freshness lookup below reads an input analyte's family date from here.
  const latestDateByFamily = new Map<string, string>();
  for (const r of latest) {
    const fam = biomarkerRetestIdentity(r.canonical_name?.trim() || r.name);
    const prev = latestDateByFamily.get(fam);
    if (!prev || r.date > prev) latestDateByFamily.set(fam, r.date);
  }
  const byFamily = new Map<string, MedicalRecord>();
  for (const r of latest) {
    if (!RETEST_CATEGORIES.has(r.category ?? "")) continue;
    const famKey = biomarkerRetestIdentity(r.canonical_name?.trim() || r.name);
    const prev = byFamily.get(famKey);
    // Newest wins; tie-break on higher id (later-entered), matching
    // getMedicalRecords' "date DESC, id DESC" current-reading ranking.
    if (!prev || r.date > prev.date || (r.date === prev.date && r.id > prev.id))
      byFamily.set(famKey, r);
  }
  // Risk-stratified cadence + priority (issue #517): family history, active
  // conditions, and the occupational/immune attributes tighten an analyte's retest
  // interval and rank it up. Gathered once per profile (request-cached).
  const riskFactors = getRiskFactors(profileId);
  const items: UpcomingItem[] = [];
  for (const r of byFamily.values()) {
    const name = r.canonical_name?.trim() || r.name;
    // The cadence is looked up on the SAME display identity everything else in this
    // loop uses (canonical-or-raw name), and resolves through the SAME retest family
    // the readings were grouped by above (#1394/#1395) — so a family whose newest
    // member the dataset doesn't name (an eAG line representing the A1c family, a
    // vitamin-D fraction representing the 25-OH clock) keeps the family's curated
    // interval instead of dropping to the flat 365-day default. Passing the bare
    // `canonical_name` here also silently gave a legacy row with only a raw name no
    // cadence at all, while its clock still grouped off that raw name.
    const retestDays = retestDaysForBiomarker(name);
    // Fold in input freshness for a derived analyte (empty for everything else).
    let effectiveDate = r.date;
    for (const input of derivedInputCanonicalNamesFor(
      r.canonical_name?.trim() || ""
    )) {
      const inputDate = latestDateByFamily.get(biomarkerRetestIdentity(input));
      if (inputDate && inputDate > effectiveDate) effectiveDate = inputDate;
    }
    // Anchored one-shot (issue #517): a newborn analyte (bilirubin / metabolic
    // screen) drawn in infancy is a life-stage milestone, not a recurring retest —
    // skip it entirely so it never nags on a yearly clock. Age is resolved on the
    // READING date, so an adult bilirubin stays a normal recurring LFT.
    if (
      isAnchoredOneShotReading(
        name,
        lifeStage(getUserAgeOn(profileId, effectiveDate))
      )
    )
      continue;
    // Age ceiling (issue #546): a reading older than ~10 years is historical baseline,
    // not "retest overdue" — drop it from the nudge entirely rather than banding it as
    // an urgency action item, regardless of the analyte's cadence.
    if (isBeyondRetestHorizon(effectiveDate, today)) continue;
    // Modulate the cadence by the matched risk rules (tightest multiplier wins),
    // then test staleness + band against the MODULATED interval so a high-risk
    // analyte comes due sooner.
    const mod = retestModulationFor(name, riskFactors);
    // Retest-worthiness gate (issues #546 / #587): an incidental one-off analyte
    // (heavy metal, allergen IgE, LDL subfraction…) with no risk-layer elevation isn't
    // a standing recurring action — drop it from the retest nudge entirely rather than
    // ranking it -1 (which is invisible when it's alone in its band). A flagged one-off
    // is still surfaced by the Biomarkers flag/trajectory treatment; a risk-elevated
    // analyte (mod.priority > 0) keeps its retest clock.
    if (!isRetestWorthy(name) && mod.priority === 0) continue;
    const priority = mod.priority;
    const interval = Math.max(
      1,
      Math.round(retestIntervalDays(retestDays) * mod.multiplier)
    );
    // Immune-positive durable-immunity titers never go stale (#516) — pass the
    // reading's identity + result so isBiomarkerStale can exempt them. A negative/
    // equivocal titer keeps the (risk-modulated) clock, so the risk layer's
    // hepatitis-A tightening still bites exactly the readings that warrant followup.
    if (
      !isBiomarkerStale(effectiveDate, r.category, today, interval, {
        name,
        flag: r.flag,
        value: r.value,
        notes: r.notes,
        reference: r.reference_range,
        // Carry the LOINC too (#910): an immutable attribute whose printed name the
        // regexes miss — Epic's "ABORh Interpretation" blood type — is exempted by
        // its code instead of being nudged yearly for a value that cannot change.
        loinc: r.loinc,
      })
    )
      continue;
    const agoMonths = monthsApprox(daysBetween(effectiveDate, today));
    items.push({
      key: biomarkerDismissalKey(name),
      domain: "biomarker",
      // The item is a retest nudge, not a flag alert — carry the verb so it reads
      // as an action, and (when the stale reading was flagged) acknowledge the
      // status in the detail so the row explains itself (issues #513 / #514).
      title: biomarkerRetestTitle(name),
      detail: biomarkerRetestDetail({
        effectiveDate,
        agoMonths,
        intervalMonths: monthsApprox(interval),
        flag: r.flag,
        reasons: mod.reasons,
      }),
      // The SAME reasons the detail flattens, carried structurally (issue #656): the
      // cited risk lines lead (they explain "why sooner"), then the flag status when
      // the stale reading was out-of-range/non-optimal. `detail` is unchanged.
      reasons: concatReasons(
        riskReasonsFrom(mod.sourced),
        isFlaggedForRetest(r.flag) ? [flaggedReason(r.flag)] : []
      ),
      href: biomarkerViewHref(r.canonical_name, r.name),
      dueDate: shiftDateStr(effectiveDate, interval),
      priority,
    });
  }
  return items;
}

// Scheduled medical visits (reuses getScheduledAppointments — only 'scheduled'
// rows, so completed/cancelled drop off). The visit's calendar date drives the
// band: a visit today lands in Today, tomorrow in This week, and a past-and-still-
// scheduled one reads as Overdue (a missed/unlogged appointment worth chasing).
//
// `shared` (#997) applies the sensitivity-aware detail decision: on the SHARED
// household strip a mental_health visit shows only "Medical appointment" (no
// provider/reason) unless the profile owner opted it into full shared detail. The
// profile's OWN Upcoming page passes shared:false and always sees full detail. The
// `key` stays `appointment:<id>` in both so a dismissal/suppression matches across
// surfaces.
function appointmentItems(
  profileId: number,
  opts: { shared?: boolean } = {}
): UpcomingItem[] {
  const shareFull = opts.shared ? getMentalHealthShareFull(profileId) : true;
  return getScheduledAppointments(profileId).map((a) => {
    // scheduled_at may be a datetime; the banding is calendar-day, so use the date.
    const dueDate = a.scheduled_at.slice(0, 10);
    const minimal =
      opts.shared === true &&
      sharedSurfaceDetail(a.kind, "full", {
        sensitiveShareFull: shareFull,
      }) === "minimal";
    if (minimal) {
      return {
        key: `appointment:${a.id}`,
        domain: "appointment" as const,
        title: "Medical appointment",
        detail: "Scheduled visit",
        href: "/records/history/visits",
        dueDate,
      };
    }
    const parts = [a.provider_name, a.location].filter(Boolean);
    return {
      key: `appointment:${a.id}`,
      domain: "appointment" as const,
      title: a.title?.trim() || a.provider_name || "Appointment",
      detail: parts.length ? parts.join(" · ") : "Scheduled visit",
      href: "/records/history/visits",
      dueDate,
    };
  });
}

// Every forward-looking due-signal for the active profile, BEFORE snooze/dismiss
// filtering. `today` is resolved by the caller in the profile's timezone.
//
// Wrapped in request-scoped cache() (issue #389): the /upcoming page runs BOTH
// collectUpcoming and collectSuppressedUpcoming, and each independently fans out the
// full generator set (2× assessProfilePreventive's medical_records/encounters/
// appointments/procedures/care-plan reads, 2× everything else). cache() collapses
// the two calls in one request to a single fan-out. Outside a server request (the
// notify tick, DB tests) cache() degrades to a plain passthrough, so behavior is
// unchanged — the digest reuse still recomputes per call as before.
// Display units ride as PRIMITIVE cache() arguments (not an object) so the
// request-scoped memo still collapses the page's collectUpcoming +
// collectSuppressedUpcoming pair into one fan-out — an object param would defeat
// the cache on identity.
const rawUpcoming = cache(function rawUpcoming(
  profileId: number,
  today: string,
  temperatureUnit: TemperatureUnit,
  distanceUnit: DistanceUnit
): UpcomingItem[] {
  return [
    ...doseItems(profileId, today),
    ...prnMaxItems(profileId, today),
    ...refillItems(profileId, today),
    ...poolRefillItems(profileId, today),
    ...dietaryLimitItems(profileId, today),
    ...illnessCareItems(profileId, today),
    ...conditionReviewItems(profileId),
    ...mentalHealthCrisisItems(profileId),
    ...tempRedFlagItems(profileId, today, temperatureUnit),
    ...drugAllergyItems(profileId),
    ...interactionItems(profileId),
    ...uvOverexposureItems(profileId, today),
    ...pgxItems(profileId),
    ...contrastItems(profileId, today),
    ...dentalSafetyItems(profileId),
    ...ototoxicItems(profileId),
    ...medMonitoringItems(profileId, today),
    ...appointmentItems(profileId),
    ...carePlanItems(profileId),
    ...followUpItems(profileId, today),
    ...preventiveItems(profileId, today),
    ...immunizationItems(profileId, today),
    ...biomarkerItems(profileId, today),
    ...goalItems(profileId),
    ...trainingItems(profileId),
    ...practiceItems(profileId),
    ...enduranceEventItems(profileId, today, distanceUnit),
  ];
});

// Whether an item is currently hidden by a snooze/dismiss row in `map`. Routes
// through the shared persistence-aware dispatcher (isItemHiddenBySuppression) so a
// care-persistent item (an overdue #700 follow-up) resists an indefinite dismiss but
// still honors a live snooze — the ONE decision the "snoozed & dismissed" complement
// below shares.
function isItemSuppressed(
  map: Map<string, SuppressionRecord>,
  item: UpcomingItem,
  today: string
): boolean {
  return isItemHiddenBySuppression(item, map.get(signalKey(item)), today);
}

// Aggregate every forward-looking due-signal for the active profile into a flat
// UpcomingItem[], with snoozed/dismissed items filtered out. `today` is resolved
// by the caller in the profile's timezone. Read-only and fully profile-scoped.
// The Telegram digest reuses this, so a suppression applies to the push too.
// `units` (#1019): a WEB boundary passes the viewer's login prefs so
// measurement-carrying item strings render in the viewer's unit; login-less
// callers (digest, calendar feed, AI insights) omit it and get canonical units.
export function collectUpcoming(
  profileId: number,
  today: string,
  units: UpcomingDisplayUnits = CANONICAL_DISPLAY_UNITS
): UpcomingItem[] {
  const map = getFindingSuppressions(profileId);
  return rawUpcoming(
    profileId,
    today,
    units.temperatureUnit,
    units.distanceUnit
  ).filter((item) => !isItemSuppressed(map, item, today));
}

// The actionable household rollup for ONE profile (issue #31): the subset of the
// Upcoming aggregation the Household cards act on — due doses, low refills, and
// the single soonest scheduled visit. It reuses the SAME per-domain builders as
// collectUpcoming (no duplicated aggregation), but deliberately skips the heavier
// immunization/biomarker/goal/training domains the cards don't render, and honors
// the same snooze/dismiss suppressions so a finding hidden on Upcoming stays
// hidden here too.
//
// COST: the Household page calls this once per ACCESSIBLE profile. It is bounded —
// a household is a handful of profiles — and each call is a few cheap, indexed,
// profile-scoped reads: supplements + their doses + today's taken-log (doseItems),
// the refill rates (refillItems), the scheduled appointments (appointmentItems),
// and the suppressions map. No cross-profile SQL; every read filters profile_id.
export interface HouseholdRollup {
  dueDoses: UpcomingItem[];
  lowRefills: UpcomingItem[];
  nextAppointment: UpcomingItem | null;
}

export function collectHouseholdRollup(
  profileId: number,
  today: string
): HouseholdRollup {
  const map = getFindingSuppressions(profileId);
  const live = (item: UpcomingItem) => !isItemSuppressed(map, item, today);
  return {
    dueDoses: doseItems(profileId, today).filter(live),
    lowRefills: [
      ...refillItems(profileId, today),
      ...poolRefillItems(profileId, today),
    ].filter(live),
    nextAppointment: pickNextAppointment(
      appointmentItems(profileId, { shared: true }).filter(live)
    ),
  };
}

// A currently-suppressed item plus why it's hidden — powers the Upcoming page's
// "Snoozed & dismissed" section, where each entry offers a Restore.
export interface SuppressedUpcoming {
  item: UpcomingItem;
  signalKey: string;
  snoozeUntil: string | null;
  dismissedAt: string | null;
}

// The items that ARE currently snoozed/dismissed for this profile (the complement
// of collectUpcoming over the same raw set). Profile-scoped; used by the restore
// UI. A snooze that has since expired is NOT included (its item is live again).
export function collectSuppressedUpcoming(
  profileId: number,
  today: string,
  units: UpcomingDisplayUnits = CANONICAL_DISPLAY_UNITS
): SuppressedUpcoming[] {
  const map = getFindingSuppressions(profileId);
  const out: SuppressedUpcoming[] = [];
  for (const item of rawUpcoming(
    profileId,
    today,
    units.temperatureUnit,
    units.distanceUnit
  )) {
    const rec = map.get(signalKey(item));
    // Same persistence-aware decision as the live filter, so a care-persistent
    // follow-up whose only suppression is a resisted dismiss is NOT listed here as
    // "dismissed" (it's live); a snoozed one still is (restorable).
    if (rec && isItemHiddenBySuppression(item, rec, today)) {
      out.push({
        item,
        signalKey: signalKey(item),
        snoozeUntil: rec.snooze_until,
        dismissedAt: rec.dismissed_at,
      });
    }
  }
  return out;
}
