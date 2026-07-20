// Upcoming-page aggregation. One profile-scoped entry
// point, collectUpcoming(), fans out across the EXISTING forward-looking
// due-signals — reusing each domain's own read + pure helper rather than
// reinventing the logic — and returns a flat UpcomingItem[] for the pure
// banding/sorting layer (lib/upcoming.ts). Every read here is profile-scoped:
// the functions it calls all filter profile_id (enforced by
// lib/__tests__/profile-scoping.test.ts), and the dynamic no-bleed guard lives
// in lib/__db_tests__/upcoming.scoping.test.ts.

import { db, today } from "../../db";
import { getRoutineCycleStatus } from "../../routines";
import { cache } from "../../request-cache";
import { shiftDateStr } from "../../date";
import { isTrainingRestricted } from "../../age-gate";
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
  MEDICATIONS_HREF,
  INSTRUMENTS_HREF,
} from "../../hrefs";
import { getInstrumentStates } from "../../instrument-records";
import { mentalHealthCrisisKey, severityBand } from "../../mental-health";
import { crisisFindingLine } from "../../crisis-resources";
import { getResolvedCrisisResources } from "../../settings";
import { refillSignalKey } from "../../refill-nudge";
import { trainingSignalKey } from "../../workout-nudge";
import { getActiveEndurancePlans } from "../../endurance-plans";
import { assessSchedule } from "../../immunization-status";
import { preventiveAssessmentToUpcomingItem } from "../../preventive-upcoming";
import { scheduledMatchForRule } from "../../preventive-appointment";
import { carePlanUpcomingItems } from "../../care-plan-upcoming";
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
import { biomarkerFamily } from "../../canonical-name";
import { biomarkerDismissalKey } from "../../dismissal-keys";
import { derivedInputCanonicalNamesFor } from "../../derived-biomarkers";
import { frequencyScopeLabel, isGoalLive } from "../../goals";
import {
  getUserSex,
  getUserAgeOn,
  profileAgeMonths,
  getActiveSituations,
  getMentalHealthShareFull,
} from "../../settings";
import { sharedSurfaceDetail } from "../../appointment-sensitivity";
import {
  CANONICAL_DISPLAY_UNITS,
  type UpcomingDisplayUnits,
  type UpcomingItem,
} from "../../upcoming";
import { fmtDistance } from "../../units";
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
import {
  getActivitiesByDate,
  isPredictedWorkoutDay,
  getGoals,
  getFrequencyTargetProgress,
} from "../training";
import {
  getMedicalRecords,
  getImmunizations,
  getImmunityTiters,
  getImmunizationOverrides,
} from "../medical";
import { getCarePlanItems } from "../clinical";
import { assessProfilePreventive } from "./preventive";
import { getFindingSuppressions } from "./suppressions";
import { illnessCareItems } from "../../illness-care-findings";
import { conditionReviewItems } from "../../condition-suggestion-findings";
import { tempRedFlagItems } from "../../temp-red-flag-findings";
import { followUpItems } from "../../followup-findings";

// Biomarker categories a retest nudge makes sense for. Vitals/scans/prescriptions
// aren't "labs to redraw", and genomics never go stale (handled by
// isBiomarkerStale). Kept narrow so the retest signal stays a labs signal. The
// cadence is per-analyte now (curated retest_days, default 365) rather than flat.
const RETEST_CATEGORIES = new Set(["lab", "biomarker"]);

// Doses pending TODAY across active supplements + medications (reuses the
// supplement schedule's isDueOn with today's workout/situation context, and the
// per-dose taken-log read). A PRN (as_needed) med is never scheduled-due, so
// isDueOn already drops it. Only NOT-yet-taken doses are surfaced.
function doseItems(profileId: number, today: string): UpcomingItem[] {
  const supplements = getSupplements(profileId);
  const doses = getSupplementDoses(profileId);
  const taken = getTakenDoseIds(profileId, today);
  const activeSituations = new Set(getActiveSituations(profileId));
  const isWorkoutDay = getActivitiesByDate(profileId, today).length > 0;
  // #558: a pre_workout dose is pending on a predicted training day, before a
  // session is logged; the logged signal is the fallback when no cadence is known.
  const predictedWorkoutDay = isPredictedWorkoutDay(profileId, today);
  const ctx = { isWorkoutDay, activeSituations, predictedWorkoutDay };

  const byId = new Map(supplements.map((s) => [s.id, s]));
  const items: UpcomingItem[] = [];
  for (const dose of doses) {
    if (taken.has(dose.id)) continue;
    const supp = byId.get(dose.item_id);
    if (!supp || !supp.active || !isDueOn(supp, ctx)) continue;
    const detail = [
      supp.kind === "medication" ? "Medication" : null,
      supp.kind === "medication"
        ? formatMedicationDoseProduct(dose.amount, supp.product)
        : dose.amount,
    ]
      .filter(Boolean)
      .join(" · ");
    // A situational item is due specifically BECAUSE its situation is active (the
    // gate isDueOn just applied) — carry that as a structured reason (issue #656
    // item 5) so the same "due because Illness is active" explanation the medicine
    // page shows as a bare tag can reach the digest / a reminder, not only the row.
    const reasons: Reason[] =
      supp.condition === "situational" && supp.situation
        ? [situationReason(supp.situation)]
        : [];
    items.push({
      key: `dose:${dose.id}`,
      domain: "dose",
      title: supp.name,
      detail: detail || null,
      reasons: reasons.length ? reasons : undefined,
      href: intakeHref(supp.kind),
      dueDate: null, // scheduled for today
      // Bucket label as the due-text ("Morning" / "Evening" / "Before sleep"…):
      // informative on its own and it explains the ordering to the user (#297).
      dueText: timeBucket(dose.time_of_day),
      // Shared dose-day sort key (bucket → priority → stack → name) so morning
      // and bedtime doses no longer interleave alphabetically within the band —
      // the SAME ordering /medicine's due-today section uses (#297).
      sortHint: doseSortKey({
        timeOfDay: dose.time_of_day,
        priority: supp.priority,
        stack: supp.stack,
        name: supp.name,
      }),
      doseId: dose.id,
    });
  }
  return items;
}

// Tracked meds/supplements running low on supply (reuses lib/refill's pure math;
// doses/day comes from the shared getRefillRates — the ACTUAL taken-log rate when
// history is thick enough, else the scheduled-dose-count estimate — matching the
// supplements page and refill notifier). The estimated run-out date (today +
// days-left) drives the band, so an item with 0 days left lands in Today and a
// week of runway lands in This week.
function refillItems(profileId: number, today: string): UpcomingItem[] {
  const tracked = getSupplements(profileId).filter(
    (s) => s.active && s.quantity_on_hand != null
  );
  if (tracked.length === 0) return [];
  const rates = getRefillRates(profileId);

  const items: UpcomingItem[] = [];
  for (const s of tracked) {
    const daysLeft = daysOfSupplyLeft(
      s.quantity_on_hand,
      s.qty_per_dose,
      rates.get(s.id)?.dosesPerDay ?? 0
    );
    if (!isLowSupply(daysLeft, DEFAULT_LOW_SUPPLY_DAYS) || daysLeft == null)
      continue;
    items.push({
      key: refillSignalKey(s.id),
      domain: "refill",
      title: s.name,
      detail:
        daysLeft <= 0 ? "Out of supply" : `≈${daysLeft} days of supply left`,
      href: intakeHref(s.kind),
      dueDate: shiftDateStr(today, daysLeft),
    });
  }
  return items;
}

// Supplement stack totals that exceed an NIH Tolerable Upper Intake Level (issue
// #148). Reuses the shared getDietaryLimitWarnings gather (same computation as the
// /medicine warning rows), so a nutrient over its UL surfaces as a dismissible
// finding keyed by `dietary-limit:<nutrient>` — it goes through getFindingSuppressions
// like every other finding, so a dismiss/snooze on Upcoming silences it. Standing
// informational findings (no due date): banded to Today, framed "discuss with your
// clinician", never prescriptive.
function dietaryLimitItems(profileId: number, today: string): UpcomingItem[] {
  return getDietaryLimitWarnings(profileId, today).map((w) => ({
    key: dietaryLimitSignalKey(w.key),
    domain: "dietary-limit" as const,
    title: ulWarningTitle(w),
    detail: ulWarningDetail(w, w.conditionCaveat),
    href: nutritionTabHref("supplements"),
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}

// PRN medications logged OVER their confirmed daily max today (issue #798) — the
// count-per-day analogue of the dietary-limit (UL) warning. When today's
// administrations exceed the user's own confirmed max_daily_count, surface a care-tier
// finding keyed `prn-max:<itemId>` (via prnMaxSignalKey) — dismissible through the
// SAME getFindingSuppressions bus as every other finding. Banded to Today (a
// standing, informational safety note framed "you've logged more than your confirmed
// daily max" — never prescriptive), and it clears itself at the next date rollover.
// FAMILY-AWARE (#1027): the count spans the ingredient family (OTC + Rx ibuprofen
// together) against the most conservative confirmed max; a multi-item family names
// every member (#531 — label by what the count spans) and stays keyed on the
// most-conservative member's id.
function prnMaxItems(profileId: number, today: string): UpcomingItem[] {
  return getPrnOverMaxItems(profileId, today).map((m) => ({
    key: prnMaxSignalKey(m.id),
    domain: "prn-max" as const,
    title: `${m.name} — over your daily max`,
    detail:
      (m.memberNames?.length
        ? `${m.count} logged today across ${m.memberNames.join(" + ")} vs the ` +
          `most conservative confirmed max of ${m.maxDailyCount}. `
        : `${m.count} logged today vs your confirmed max of ${m.maxDailyCount}. `) +
      `Informational — if this looks wrong, adjust the log; if you're in pain, ` +
      `contact your clinician.`,
    href: MEDICATIONS_HREF,
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}

// Known drug-/supplement-interactions among the profile's ACTIVE stack (issue #144).
// Reuses the shared getInteractionWarnings gather (same pure detectInteractions the
// /medicine warning rows format over), so each interacting PAIR surfaces as a
// dismissible finding keyed by `interaction:<lo>-<hi>` — it goes through
// getFindingSuppressions like every other finding, so a dismiss/snooze on Upcoming
// silences it ("dismiss once, silence everywhere"). Standing informational findings
// (no due date): banded to Today, framed "discuss with your prescriber", never
// prescriptive.
function interactionItems(profileId: number): UpcomingItem[] {
  return getInteractionWarnings(profileId).map((hit) => ({
    key: hit.dedupeKey,
    domain: "interaction" as const,
    title: interactionTitle(hit),
    detail: interactionDetail(hit),
    href: MEDICATIONS_HREF,
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}

// Pharmacogenomics cross-check (issue #710): a stored PGx result (a genomic_variants
// row, result_type='pharmacogenomic') affecting a medication in the active stack.
// Reuses the shared getPgxWarnings gather (same pure crossCheckPgx the /medicine row
// notice + the create/edit notice format over), so each affected med surfaces as a
// dismissible finding keyed by `pgx:<medId>:<gene>:<status>` — it goes through
// getFindingSuppressions like every other finding, so a dismiss/snooze on Upcoming
// silences it ("dismiss once, silence everywhere"). SAFETY / care-tier (per #449 —
// like the drug-interaction findings, and HLA-B*57:01 × abacavir leans care-tier):
// banded to Today so it surfaces on the dashboard "Needs attention" hero. Standing
// informational finding (no due date), framed "discuss with your prescriber", never
// prescriptive — the app never auto-changes a medication.
function pgxItems(profileId: number): UpcomingItem[] {
  return getPgxWarnings(profileId).map((hit) => ({
    key: hit.dedupeKey,
    domain: "pgx" as const,
    title: pgxTitle(hit),
    detail: pgxDetail(hit),
    href: MEDICATIONS_HREF,
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}

// Where a contrast-safety note links, by the planned study's source row.
const CONTRAST_SOURCE_HREF: Record<ContrastStudySource, AppRoute> = {
  careplan: "/records#care-plan",
  appointment: "/records#visits",
  imaging: "/results#imaging",
};

// Contrast-safety cross-check (issue #701): a PLANNED contrast imaging study (an
// ordered care-plan item, a scheduled appointment, or a future structured imaging
// study — #702) meeting a contrast/iodine/gadolinium ALLERGY or a renal (CKD)
// contraindication on file. Reuses the shared getContrastSafetyWarnings gather (same
// pure crossCheckContrast the care-plan inline notice formats over), so each note
// surfaces as a dismissible finding keyed by
// `contrast:<source>:<id>:<gate>:<class>` — it goes through getFindingSuppressions
// like every other finding, so a dismiss/snooze on Upcoming silences it ("dismiss
// once, silence everywhere"). SAFETY / care-tier (per #449 — a pre-procedure safety
// note, like the drug-interaction/PGx items): banded to Today so it surfaces on the
// dashboard "Needs attention" hero. Standing informational finding (no due date),
// never prescriptive — the app never blocks or advises for/against the study.
function contrastItems(profileId: number, today: string): UpcomingItem[] {
  return getContrastSafetyWarnings(profileId, today).map((hit) => ({
    key: hit.dedupeKey,
    domain: "contrast" as const,
    title: contrastTitle(hit),
    detail: contrastDetail(hit),
    href: CONTRAST_SOURCE_HREF[hit.source],
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}

// Dental-procedure safety cross-check (issue #704): a PLANNED INVASIVE dental
// procedure (a status='planned', bone-manipulating dental_procedures row — #705)
// meeting an antiresorptive (→ MRONJ), high-risk cardiac (→ antibiotic prophylaxis),
// or anticoagulant (→ bleeding) gate on the active stack / conditions. Reuses the
// shared getDentalSafetyWarnings gather (same pure crossCheckDentalSafety), so each
// note surfaces as a dismissible finding keyed by `dental-safety:<procId>:<gateKey>` —
// it goes through getFindingSuppressions like every other finding, so a dismiss/snooze
// silences it ("dismiss once, silence everywhere"). SAFETY / care-tier (per #449 — a
// pre-procedure safety note, like the contrast/interaction/PGx items): banded to Today
// so it surfaces on the dashboard "Needs attention" hero. A routine cleaning is
// non-invasive and produces nothing (the gate is in the gather). Standing
// informational finding (no due date), never prescriptive.
function dentalSafetyItems(profileId: number): UpcomingItem[] {
  return getDentalSafetyWarnings(profileId).map((hit) => ({
    key: hit.dedupeKey,
    domain: "dental-safety" as const,
    title: dentalSafetyTitle(hit),
    detail: dentalSafetyDetail(hit),
    href: "/dental" as AppRoute,
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}

// Ototoxic-medication awareness (issue #717): an active medication that is a
// well-established ototoxic agent (aminoglycoside, platinum chemo, high-dose loop
// diuretic, high-dose salicylate, vancomycin, quinine). Reuses the shared
// getOtotoxicWarnings gather (same pure crossCheckOtotoxic as the /medications +
// Supplements inline notices), so each note surfaces as a dismissible finding keyed by
// `ototoxic:<medId>:<entryKey>` — through getFindingSuppressions like every other
// finding, so a dismiss/snooze silences it everywhere ("dismiss once, silence
// everywhere"). SAFETY / care-tier (per #449 — a medication-safety note, like the
// interaction/PGx/dental items): banded to Today so it surfaces on the dashboard "Needs
// attention" hero. Standing informational finding (no due date), never prescriptive.
function ototoxicItems(profileId: number): UpcomingItem[] {
  return getOtotoxicWarnings(profileId).map((hit) => ({
    key: hit.dedupeKey,
    domain: "ototoxic" as const,
    title: ototoxicTitle(hit),
    detail: ototoxicDetail(hit),
    href: MEDICATIONS_HREF,
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}

// Drug-allergy × medication-stack cross-check (issue #1029): an active medication
// meeting a recorded non-resolved allergy — direct ingredient match, same curated
// class, or a documented cross-reactive class. Reuses the shared
// getDrugAllergyWarnings gather (same pure crossCheckDrugAllergies as the
// /medications + Supplements safety strips), so each (allergy, med) pair surfaces as
// a dismissible finding keyed by `allergy-med:<allergyId>-<itemId>` (id-keyed per
// #203 — it dies with either row) — through getFindingSuppressions like every other
// finding, so a dismiss/snooze silences it everywhere ("dismiss once, silence
// everywhere"; a clinician-reviewed, deliberately-continued med is the common case).
// SAFETY / care-tier (per #449 — a recorded-allergy match is exactly the
// interaction/PGx class of med-safety note): banded to Today so it surfaces on the
// dashboard "Needs attention" hero. Standing informational finding (no due date),
// framed "discuss with your prescriber/pharmacist", never prescriptive — the check
// runs at surface time and never blocks a med write (#1029 ask 4).
function drugAllergyItems(profileId: number): UpcomingItem[] {
  return getDrugAllergyWarnings(profileId).map((hit) => ({
    key: hit.dedupeKey,
    domain: "allergy-med" as const,
    title: drugAllergyTitle(hit),
    detail: drugAllergyFullDetail(hit),
    href: MEDICATIONS_HREF,
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}

// Medication → required-monitoring-lab bridge (issue #995): retest-shaped Upcoming items
// for an active med whose curated monitoring labs are DUE — a retest clock CREATED by
// taking the drug (lithium → serum level + TSH + renal, clozapine → ANC, warfarin → INR,
// …). Reuses the shared getMedMonitoringItems gather (same pure buildMedMonitoring the
// medications-row note formats over), so each (med, monitoring-entry) surfaces as a
// dismissible finding keyed `med-monitor:<medId>:<entryKey>` — it goes through
// getFindingSuppressions like every other finding, so a dismiss/snooze silences it
// ("dismiss once, silence everywhere"), MIRRORING the bus-gated biomarker retest lines.
//
// Per-entry reach tier (#449 / #995 decision 1): CARE entries (lithium/clozapine/warfarin/
// valproate/carbamazepine) carry a structured `medication-monitoring` reason + priority,
// so — banded by real dueness like any retest — they reach the Needs-attention hero and
// surface as a Telegram digest HIGHLIGHT (the push). COACHING entries (antipsychotic
// metabolic, amiodarone, methotrexate, ACEi/ARB, metformin) carry no reason/priority, so
// they stay calm — visible on Upcoming + the medications row note, never pushed. The
// `med-monitor` domain is deliberately absent from the digest DOMAIN_SEQ, so a coaching
// item is never even counted in the push; only the care highlight carries it there.
// Informational, never prescriptive; the absence of an entry is not clearance.
function medMonitoringItems(profileId: number, today: string): UpcomingItem[] {
  return getMedMonitoringItems(profileId, today).map((hit) => {
    const item: UpcomingItem = {
      key: hit.dedupeKey,
      domain: "med-monitor" as const,
      title: medMonitoringTitle(hit),
      detail: medMonitoringDetail(hit),
      href: MEDICATIONS_HREF,
      dueDate: hit.dueDate,
    };
    if (hit.tier === "care") {
      // Care-tier: rank up + carry the cited "why" so it reaches the hero + digest
      // highlight (the push). The reason leads with the drug the monitor is for.
      item.priority = 1;
      item.reasons = [medMonitoringReason(hit.entryLabel, hit.citation)];
    }
    return item;
  });
}

// Mental-health crisis findings (issue #716) — a CARE-tier, NON-DISMISSIBLE signal. When
// the latest PHQ-9/GAD-7 score sits in the SEVERE band, or a stored PHQ-9 item 9
// (suicidal-ideation) answer is positive, surface a crisis-resources + discuss-with-a-
// clinician finding banded `today` so it reaches Upcoming + the Needs-attention hero for
// the profile's OWN view. It is `suppressionPolicy: "safety-ungated"` + `suppressible:
// false`, so the dismissal bus can NEVER hide it and no snooze/dismiss control renders —
// the deliberate #716 exception, same standing as a safety dose reminder. It is
// domain "mental-health", which is NOT in the digest DOMAIN_SEQ and has no notify
// orchestrator, so it NEVER pushes on any channel (the decided harm case: crisis content
// on a shared/locked device). Informational, never diagnostic — it states the fact
// (severe band / a self-harm answer) and the resources, never a diagnosis.
function mentalHealthCrisisItems(profileId: number): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  // The configured crisis resources for THIS profile (override > global > neutral
  // fallback, #996). Read once; private to the profile — never crosses to another.
  const crisisLine = crisisFindingLine(getResolvedCrisisResources(profileId));
  for (const state of getInstrumentStates(profileId)) {
    if (!state.latest || !state.crisis?.escalate) continue;
    const { instrument, latest } = state;
    const band = severityBand(instrument, latest.total);
    const trigger = state.crisis.selfHarm
      ? `${instrument} item 9 was answered positively`
      : `${instrument} is ${band.label.toLowerCase()} (${latest.total})`;
    items.push({
      key: mentalHealthCrisisKey(instrument, latest.date),
      domain: "mental-health" as const,
      title: "Mental-health check-in",
      detail: `${trigger}. ${crisisLine}`,
      href: INSTRUMENTS_HREF,
      dueDate: null,
      band: "today" as const,
      dueText: "Support",
      suppressible: false,
      suppressionPolicy: "safety-ungated" as const,
    });
  }
  return items;
}

// Vaccines due/overdue on the tracked schedule (reuses assessSchedule + the same
// age/sex resolution the immunizations page uses). Status-driven, so each item
// carries an explicit band + due-text rather than a calendar date.
//
// Risk-stratified priority (issue #553 — the immunization arm of #517): a vaccine
// the profile's risk factors make more important (immunocompromised → pneumococcal/
// meningococcal, healthcare worker → HepB/flu/MMR/varicella, pregnancy → Tdap/flu)
// ranks up within its band and says why, in a calm line — the SAME shared
// RiskFactors gather + pure priority machinery the biomarker/preventive generators
// use, so the surfaces can't diverge on which vaccines matter.
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
        href: "/records#immunizations",
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
// Readings are grouped by the ONE #482 biomarker FAMILY identity (biomarkerFamily),
// the same grouping the dedup/series/starred surfaces use — so almost every analyte
// is its own family (keyed by canonical name), but the interchangeable-name families
// (the 25-hydroxy vitamin-D variants total/generic/D2/D3, and A1c ↔ eAG) collapse
// into one: a recent reading of ANY member supersedes an old sibling, so the stale
// variants don't each nag as overdue when a fresh family reading exists. Per family
// we keep the NEWEST reading; its name → the stable family `biomarker:<family>`
// dismissal key (via biomarkerDismissalKey), so a dismiss on any member silences the
// family and the key doesn't drift as which member is newest changes.
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
    const fam = biomarkerFamily(r.canonical_name?.trim() || r.name);
    const prev = latestDateByFamily.get(fam);
    if (!prev || r.date > prev) latestDateByFamily.set(fam, r.date);
  }
  const byFamily = new Map<string, MedicalRecord>();
  for (const r of latest) {
    if (!RETEST_CATEGORIES.has(r.category ?? "")) continue;
    const famKey = biomarkerFamily(r.canonical_name?.trim() || r.name);
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
    const retestDays = retestDaysForBiomarker(r.canonical_name?.trim() || null);
    // Fold in input freshness for a derived analyte (empty for everything else).
    let effectiveDate = r.date;
    for (const input of derivedInputCanonicalNamesFor(
      r.canonical_name?.trim() || ""
    )) {
      const inputDate = latestDateByFamily.get(biomarkerFamily(input));
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
        href: "/records#visits",
        dueDate,
      };
    }
    const parts = [a.provider_name, a.location].filter(Boolean);
    return {
      key: `appointment:${a.id}`,
      domain: "appointment" as const,
      title: a.title?.trim() || a.provider_name || "Appointment",
      detail: parts.length ? parts.join(" · ") : "Scheduled visit",
      href: "/records#visits",
      dueDate,
    };
  });
}

// Active goals with a target date (reuses getGoals). The deadline drives the
// band, so an overdue deadline reads as Overdue and an approaching one as
// Today/This week/Later. Goals live on the Training hub's Goals tab — the old
// standalone /goals route has no page (issue #283 found the dead link).
function goalItems(profileId: number): UpcomingItem[] {
  return getGoals(profileId)
    .filter((g) => isGoalLive(g) && g.target_date)
    .map((g) => ({
      key: `goal:${g.id}`,
      domain: "goal" as const,
      title: g.title,
      detail: g.category ? `${g.category} goal` : "Goal deadline",
      href: "/training?tab=goals",
      dueDate: g.target_date,
    }));
}

// Unmet weekly frequency targets (reuses getFrequencyTargetProgress). Hidden for
// age-restricted profiles, mirroring the Training surface. A weekly concern, so
// each unmet target sits in This week with a progress due-text.
function trainingItems(profileId: number): UpcomingItem[] {
  if (isTrainingRestricted(profileId)) return [];
  // Deload-week softening (#741): the mesocycle's deload week is SUPPOSED to be
  // lighter, so a region/group frequency target being "behind" isn't a real gap —
  // suppress those findings that week (decided in the ONE gather; type targets like
  // cardio still surface). Same flag every deload surface reads.
  const deload =
    getRoutineCycleStatus(profileId, today(profileId))?.isDeloadWeek ?? false;
  return getFrequencyTargetProgress(profileId)
    .filter((p) => !p.met)
    .filter(
      (p) =>
        !(
          deload &&
          (p.target.scope_kind === "region" || p.target.scope_kind === "group")
        )
    )
    .map((p) => ({
      key: trainingSignalKey(p.target.id),
      domain: "training" as const,
      title: frequencyScopeLabel(p.target.scope_kind, p.target.scope_value),
      detail: "Weekly training target",
      href: "/training",
      dueDate: null,
      band: "week" as const,
      dueText: `${p.count}/${p.per_week} this week`,
    }));
}

// Endurance event days (#839): each active plan's event as a dated forward-looking item,
// so the EVENT DAY rides the Upcoming page + the calendar feed (domain "training" is a
// FeedCategory). Hidden for age-restricted profiles, mirroring the Training surface. The
// key namespace is DISTINCT from the coaching long-session finding prefix ("endurance:"),
// so the event marker and the calm long-session nudge never collide. Not suppressible — a
// dated event is a hard commitment, not a dismissable nudge.
// `distanceUnit` is the viewer's display unit (#1019): the web boundary threads
// the login's pref; login-less callers — calendar feed, digest — default to
// canonical km. The `key` is unit-independent, so suppression identity never shifts.
function enduranceEventItems(
  profileId: number,
  today: string,
  distanceUnit: DistanceUnit = "km"
): UpcomingItem[] {
  if (isTrainingRestricted(profileId)) return [];
  return getActiveEndurancePlans(profileId)
    .filter((p) => p.eventDate >= today)
    .map((p) => {
      const disc =
        p.discipline === "run"
          ? "Run"
          : p.discipline === "ride"
            ? "Ride"
            : "Swim";
      const dist = fmtDistance(p.targetDistanceKm, distanceUnit);
      const name = p.eventName?.trim() || `${dist} ${disc}`;
      return {
        key: `endurance-event:${p.id}`,
        domain: "training" as const,
        title: `Event: ${name}`,
        detail: `${disc} · ${dist}`,
        href: "/training" as const,
        dueDate: p.eventDate,
        suppressible: false,
      };
    });
}

// Provider-ordered / manually-entered care-plan items with a planned date (issue
// #84). Reuses getCarePlanItems (profile-scoped read) and the pure adapter, which
// keeps only OPEN (non-completed/cancelled) DATED items and bands them by their
// real planned_date. Each carries its row id for the inline "Mark done" form.
// NOTE (v1): no dedup yet against the preventive-care engine — an ordered
// colonoscopy and a catalog "colorectal screening due" can both appear; the issue
// punts that to a follow-up.
function carePlanItems(profileId: number): UpcomingItem[] {
  // Exclude LINKED follow-ups (source_kind set, #700) — those are surfaced by the
  // dedicated care-tier followUpItems builder (legible + resolution-aware), so the
  // generic careplan generator handles only the plain planned-care lines. Without
  // this filter a tracked follow-up would double-surface (careplan + followup).
  return carePlanUpcomingItems(
    getCarePlanItems(profileId).filter((c) => c.source_kind == null)
  );
}

// Mark a care-plan item completed (issue #84) — the write behind the Upcoming
// "Mark done" fast path. Sets status = 'completed' so the pure adapter drops it
// from the due-list on the next read. Profile-scoped (WHERE id AND profile_id), so
// a tampered id for another profile is a no-op.
export function markCarePlanItemDone(profileId: number, id: number): void {
  db.prepare(
    "UPDATE care_plan_items SET status = 'completed' WHERE id = ? AND profile_id = ?"
  ).run(id, profileId);
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
    ...dietaryLimitItems(profileId, today),
    ...illnessCareItems(profileId, today),
    ...conditionReviewItems(profileId),
    ...mentalHealthCrisisItems(profileId),
    ...tempRedFlagItems(profileId, today, temperatureUnit),
    ...drugAllergyItems(profileId),
    ...interactionItems(profileId),
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
    lowRefills: refillItems(profileId, today).filter(live),
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
