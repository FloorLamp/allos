import { cache } from "../../request-cache";
import { shiftDateStr } from "../../date";
import {
  signalKey,
  isItemHiddenBySuppression,
  type SuppressionRecord,
} from "../../upcoming-suppress";
import { isDueOn, isPushedIntake, timeBucket } from "../../supplement-schedule";
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
import {
  getPoolView,
  poolIdsForProfiles,
  poolPushes,
} from "../intake/supply-pool";
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
// Doses pending TODAY across active supplements + medications (reuses the
// supplement schedule's isDueOn with today's workout/situation context, and the
// per-dose taken-log read). A PRN (as_needed) med is never scheduled-due, so
// isDueOn already drops it. Only NOT-yet-taken doses are surfaced.
//
// Filtered by the ONE shared push predicate `isPushedIntake` (#1505): a LOW-priority
// SUPPLEMENT is tracked but never pushed, so it is absent here — and therefore absent
// from the Upcoming rows, the #1504 aggregate count, the dashboard Needs-attention
// hero, the calendar feed, and the digest's Today section, all through this single
// model rather than four surface-local filters (#221). It stays fully visible where
// it lives: the Supplements page due-today list, the quick-log overlays, and every
// adherence strip/fraction (which answer "what did I do", not "what needs me").
// A low MEDICATION is unaffected — kind, not priority, decides pushability for meds.
export function doseItems(profileId: number, today: string): UpcomingItem[] {
  const supplements = getSupplements(profileId);
  const doses = getSupplementDoses(profileId);
  const taken = getTakenDoseIds(profileId, today);
  // Derived context (#1292/#1298) widens the active set so a Poor sleep / Period
  // situational dose surfaces on Upcoming + the hero + the digest exactly while its
  // derived context holds — the SAME effective set the Supplements bar uses.
  const activeSituations = getEffectiveActiveSituations(profileId, today);
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
    // Tracked, never pushed (#1505) — the shared predicate, not a local check.
    if (!isPushedIntake(supp)) continue;
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
        obligation: supp.obligation,
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
export function refillItems(profileId: number, today: string): UpcomingItem[] {
  // Tracked, never pushed (#1505): a refill nudge IS a push, so the same shared
  // predicate the dose items use gates it here and in the notify tick's runRefills.
  // The Supplements page still shows the item's supply state — this drops only the
  // nudge, never the fact.
  const tracked = getSupplements(profileId).filter(
    (s) => s.active && s.quantity_on_hand != null && isPushedIntake(s)
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

// Shared supply pools running low (#1374) — the pooled twin of refillItems. A POOLED
// item never appears above: linking clears its private `quantity_on_hand`, so the
// per-item `tracked` filter skips it by construction and one bottle can never surface
// twice. The finding is keyed on the POOL (`pool-refill:<supplyId>`, the same key the
// notify tick dedupes on), so every linked member's Upcoming row names ONE subject;
// dismissing lands on the dismissing member's own suppression bus (the bus table is
// profile-scoped), while the PUSH treats any linked member's dismissal as freezing the
// whole episode. Days-left is the POOLED projection — the summed consumption of every
// linked member's item — not this member's share.
export function poolRefillItems(
  profileId: number,
  today: string
): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  for (const supplyId of poolIdsForProfiles([profileId])) {
    const pool = getPoolView(supplyId);
    if (!pool || !pool.low || pool.daysLeft == null) continue;
    // Tracked, never pushed (#1505), pooled edition: a bottle whose every ACTIVE
    // member is a low-priority supplement drops out of the nudge. Any pushable
    // member keeps the whole pool's signal alive — see poolPushes.
    if (!poolPushes(pool.members)) continue;
    items.push({
      key: poolRefillSignalKey(pool.id),
      domain: "refill",
      title: pool.name,
      detail:
        (pool.daysLeft <= 0
          ? "Shared bottle — out of supply"
          : `Shared bottle — ≈${pool.daysLeft} days left across everyone`) +
        (pool.members.length > 1 ? ` (${pool.members.length} people)` : ""),
      href: SUPPLIES_HREF,
      dueDate: shiftDateStr(today, pool.daysLeft),
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
export function dietaryLimitItems(
  profileId: number,
  today: string
): UpcomingItem[] {
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
export function prnMaxItems(profileId: number, today: string): UpcomingItem[] {
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
export function interactionItems(profileId: number): UpcomingItem[] {
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

// UV overexposure (issue #1172): the CARE half of the two-sided UV-dose sun model. It
// reads TODAY's UV dose (getUvDoseForDay — the ONE computation, degradation ladder and
// daylight intersection included) and, when the day's cumulative erythemal dose crosses
// the skin-type burn (MED) threshold, surfaces one dismissible finding keyed
// `uv-exposure:overexposure:<date>` — through getFindingSuppressions like every other
// finding, so a dismiss/snooze silences it. STAYS SILENT without a skin type (the
// decide returns null) and without a home location (getUvDoseForDay returns null).
// Standing informational care note (no due date): banded to Today, never prescriptive.
export function uvOverexposureItems(
  profileId: number,
  today: string
): UpcomingItem[] {
  const dose = getUvDoseForDay(profileId, today);
  if (!dose) return [];
  const obs = decideUvOverexposure(today, dose);
  if (!obs) return [];
  return [
    {
      key: obs.dedupeKey,
      domain: "uv-exposure" as const,
      title: obs.title,
      detail: obs.detail,
      href: timelineDayHref(today),
      dueDate: null,
      band: "today" as const,
      dueText: "Review",
    },
  ];
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
export function pgxItems(profileId: number): UpcomingItem[] {
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
  careplan: "/records/care/overview",
  appointment: "/records/history/visits",
  imaging: "/results/imaging",
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
export function contrastItems(
  profileId: number,
  today: string
): UpcomingItem[] {
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
export function dentalSafetyItems(profileId: number): UpcomingItem[] {
  return getDentalSafetyWarnings(profileId).map((hit) => ({
    key: hit.dedupeKey,
    domain: "dental-safety" as const,
    title: dentalSafetyTitle(hit),
    detail: dentalSafetyDetail(hit),
    href: "/records/specialty/dental" as AppRoute,
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
export function ototoxicItems(profileId: number): UpcomingItem[] {
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

// Drug-allergy × medication-stack cross-check (issues #1029, #1092): an active
// medication meeting a recorded non-resolved allergy — direct ingredient match, same
// curated class, or a documented cross-reactive class. Reuses the shared
// getDrugAllergyWarnings gather (same pure crossCheckDrugAllergies as the
// /medications + Supplements safety strips), so each (allergy, med) pair surfaces as
// the SAME finding keyed by `allergy-med:<allergyId>-<itemId>` (id-keyed per #203 —
// it dies with either row) through the shared bus ("one question, one computation").
// SAFETY / care-tier (per #449 — a recorded-allergy match is exactly the
// interaction/PGx class of med-safety note): banded to Today so it surfaces on the
// dashboard "Needs attention" hero and rides the Telegram digest. Standing
// informational finding (no due date), framed "discuss with your prescriber/
// pharmacist", never prescriptive — the check runs at surface time and never blocks a
// med write (#1029 ask 4).
//
// CARE-PERSISTENT (#1092, the #942/#553 safety stance): a live allergy↔med
// contraindication is a SAFETY signal, so — like the overdue follow-up (#700 ask 5) —
// a page dismissal must not PERMANENTLY silence it. `carePersistent: true` routes it
// through the "snooze-only" lifecycle policy (isItemHiddenBySuppression): an
// indefinite dismiss is RESISTED (the finding re-surfaces on the hero / Upcoming /
// digest while BOTH the med is active AND the allergy stands), while a deliberate
// time-boxed SNOOZE still defers it, and the surfaces render a snooze-only menu (no
// Dismiss). The both-stand gating is inherent in the builder: the finding vanishes
// the moment the med goes inactive or the allergy resolves (getDrugAllergyWarnings
// emits nothing), so there is nothing left to suppress. The calm per-page intake
// strip keeps its plain acknowledge-Dismiss; the persistence net lives on the care /
// push surfaces this generator feeds.
export function drugAllergyItems(profileId: number): UpcomingItem[] {
  return getDrugAllergyWarnings(profileId).map((hit) => ({
    key: hit.dedupeKey,
    domain: "allergy-med" as const,
    title: drugAllergyTitle(hit),
    detail: drugAllergyFullDetail(hit),
    href: MEDICATIONS_HREF,
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
    carePersistent: true,
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
export function medMonitoringItems(
  profileId: number,
  today: string
): UpcomingItem[] {
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
export function mentalHealthCrisisItems(profileId: number): UpcomingItem[] {
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
