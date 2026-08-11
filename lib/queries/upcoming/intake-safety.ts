import { cache } from "../../request-cache";
import { shiftDateStr } from "../../date";
import {
  signalKey,
  isItemHiddenBySuppression,
  type SuppressionRecord,
} from "../../upcoming-suppress";
import {
  doseDueOn,
  isDueOn,
  isOfferedOn,
  isPushedIntake,
  slotHintBucket,
  timeBucket,
  TIME_BUCKET_LABELS,
} from "../../supplement-schedule";
import { cadenceLabel } from "../../intake-cadence";
import { doseSortKey } from "../../dose-order";
import { formatMedicationDoseProduct } from "../../medication-dose-format";
import {
  daysOfSupplyLeft,
  isLowSupply,
  DEFAULT_LOW_SUPPLY_DAYS,
} from "../../refill";
import {
  readingDetailHref,
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
import {
  refillSignalKey,
  poolRefillSignalKey,
  offeredSignalKey,
} from "../../refill-nudge";
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
  getProfileSex,
  getProfileAgeOn,
  profileAgeMonths,
  getMentalHealthShareFull,
} from "../../settings";
import { getEffectiveActiveSituations } from "../derived-situations";
import { getWeatherDay, weatherSituationHolds } from "../weather-situations";
import { getWeatherMedWarnings } from "../intake/warnings";
import {
  decideHeatRiskNote,
  decidePhotosensitizerNote,
  enrichUvDetail,
} from "../../weather-med-safety";
import {
  BUILTIN_HEATWAVE_SITUATION,
  fmtAmbientTemp,
} from "../../weather-situations";
import { sharedSurfaceDetail } from "../../appointment-sensitivity";
import {
  CANONICAL_DISPLAY_UNITS,
  type UpcomingDisplayUnits,
  type UpcomingItem,
} from "../../upcoming";
import type { DoseDayProgress } from "../../upcoming-aggregate";
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
import { prnOverMaxDetail } from "../../redose-format";
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
// This is the DUE list — must + should only. A `may` item never reaches it, because
// isDueOn short-circuits on `may` (#1505): with no obligation there is no dueness, so
// there is nothing here to be late for. That single short-circuit is what keeps the
// Upcoming rows, the #1504 aggregate count, the dashboard hero, the calendar feed and
// the digest's Today section agreeing, instead of five surface-local filters (#221).
//
// `may` items are NOT dropped from the page — they are COLLAPSED. `offeredItems`
// below gathers them as "available" for Upcoming's disclosure, so demotion reads as a
// visible MOVE into a quieter section rather than a disappearance. Obligation, not
// kind, decides: a medication is here because it is `must`/`should`, not because it
// is a medication.
export function doseItems(profileId: number, today: string): UpcomingItem[] {
  return scheduledDoseRows(profileId, today)
    .filter((row) => !row.taken)
    .map((row) => doseRowToItem(row));
}

// One dose the day's schedule asks for, plus whether it is already logged taken.
// The DUE gate is applied identically for both halves, which is the point: the rows
// the page shows and the denominator it prints come from ONE evaluation, so
// "9 of 14 taken" can never disagree with the rows behind the disclosure (#1504).
interface ScheduledDoseRow {
  supp: ReturnType<typeof getSupplements>[number];
  dose: ReturnType<typeof getSupplementDoses>[number];
  taken: boolean;
}

// Today's scheduled dose set — must/should only, cadence- and context-gated — with
// the taken ones INCLUDED (they are what the day asked for, and a progress fraction
// that dropped them would have no denominator).
function scheduledDoseRows(
  profileId: number,
  today: string
): ScheduledDoseRow[] {
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
  const ctx = {
    date: today,
    isWorkoutDay,
    activeSituations,
    predictedWorkoutDay,
  };

  const byId = new Map(supplements.map((s) => [s.id, s]));
  const rows: ScheduledDoseRow[] = [];
  for (const dose of doses) {
    const supp = byId.get(dose.item_id);
    // doseDueOn (#1602) folds the CALENDAR into the same gate: the item's cadence
    // (weekly / every-N-days) plus this ROW's own weekday subset and validity window.
    // A weekly methotrexate is simply absent from the due list on its six off-days —
    // which is what lets it stay `must` instead of being demoted to silence it.
    if (!supp || !supp.active || !doseDueOn(supp, dose, ctx)) continue;
    rows.push({ supp, dose, taken: taken.has(dose.id) });
  }
  return rows;
}

// Today's dose progress for the Upcoming aggregate's always-visible fraction
// (#1504): how many doses the schedule asked for, and how many are logged taken.
// Same gate, same set as the rows — see scheduledDoseRows.
export function doseDayProgress(
  profileId: number,
  today: string
): DoseDayProgress {
  const rows = scheduledDoseRows(profileId, today);
  return {
    scheduled: rows.length,
    taken: rows.reduce((n, r) => n + (r.taken ? 1 : 0), 0),
  };
}

function doseRowToItem({ supp, dose }: ScheduledDoseRow): UpcomingItem {
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
  return {
    key: `dose:${dose.id}`,
    domain: "dose",
    title: supp.name,
    detail: detail || null,
    reasons: reasons.length ? reasons : undefined,
    href: intakeHref(supp.kind),
    dueDate: null, // scheduled for today
    // Bucket label as the due-text ("Morning" / "Evening" / "Before sleep"…):
    // informative on its own and it explains the ordering to the user (#297).
    // The bucket, qualified by the cadence when there is one ("Morning · Mondays"):
    // a row that appears one day in seven must SAY so, or it reads as an ordinary
    // daily dose the user is somehow only now seeing (#1602). One formatter
    // (cadenceLabel) so the row, the digest and the reminder phrase it identically.
    dueText: [timeBucket(dose.time_of_day), cadenceLabel(supp)]
      .filter(Boolean)
      .join(" · "),
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
  };
}

// `may` items ON OFFER today (issue #1505) — the collapsed-not-removed half of the
// Upcoming model. These are NOT due, carry no date, and must never be banded with the
// due rows or counted in the hero/aggregate headline: they are an availability list,
// rendered behind a disclosure the way food suggestions are.
//
// Scoped by `isOfferedOn` (the item's day condition, obligation `may`) and labelled
// with its slot HINT so the row reads "available · bedtime" rather than implying a
// time it is owed at. A hint-less item reads plainly "available".
//
// Returned as UpcomingItem for one reason only: the suppression bus and the row
// renderer already speak that shape. The `band` is deliberately absent and `dueDate`
// null so nothing downstream can mistake one of these for work.
export function offeredItems(profileId: number, today: string): UpcomingItem[] {
  const supplements = getSupplements(profileId);
  const doses = getSupplementDoses(profileId);
  const activeSituations = getEffectiveActiveSituations(profileId, today);
  const isWorkoutDay = getActivitiesByDate(profileId, today).length > 0;
  const predictedWorkoutDay = isPredictedWorkoutDay(profileId, today);
  const ctx = {
    date: today,
    isWorkoutDay,
    activeSituations,
    predictedWorkoutDay,
  };

  const dosesByItem = new Map<number, typeof doses>();
  for (const d of doses) {
    const list = dosesByItem.get(d.item_id);
    if (list) list.push(d);
    else dosesByItem.set(d.item_id, [d]);
  }

  const items: UpcomingItem[] = [];
  for (const supp of supplements) {
    if (!supp.active || !isOfferedOn(supp, ctx)) continue;
    // ONE row per ITEM, not per dose: a may item's doses are amount shapes, not
    // occurrences, so listing three of them would invent three things to do.
    const firstDose = dosesByItem.get(supp.id)?.[0] ?? null;
    const hint = slotHintBucket(firstDose?.time_of_day ?? null);
    items.push({
      key: offeredSignalKey(supp.id),
      domain: "available",
      title: supp.name,
      detail:
        supp.kind === "medication" ? "Medication · as needed" : "As needed",
      href: intakeHref(supp.kind),
      dueDate: null,
      // Cadence on a `may` item is a LABEL, never a gate (#1602): the item stays
      // offered every day (guaranteed access — a collapsed item must never become
      // indistinguishable from a deleted one), and the phrase only tells the user
      // which days it was meant for.
      dueText: [
        "Available",
        hint ? TIME_BUCKET_LABELS[hint] : null,
        cadenceLabel(supp),
      ]
        .filter(Boolean)
        .join(" · "),
      // The item's FIRST active dose (#2419), so the row can carry the same one-tap
      // "Mark taken" the due rows already render. Dueness gates NUDGING, never
      // LOGGING: an offered item is by definition not due, and the doctrine still
      // promises it is always one tap away — the web was the surface that hadn't
      // caught up, so an offered row was look-but-don't-log and taking a
      // situation-bound item meant flipping its situation on just to make a button
      // exist. Still ONE row per item (collapse is presentation, not data loss): a
      // multi-dose item supplies its first active dose and the ledger records the
      // item and that amount. Carrying the id does NOT make the row due — it has no
      // band and no dueDate, it is excluded from the page total, and nothing here
      // reaches a send.
      ...(firstDose ? { doseId: firstDose.id } : {}),
    });
  }
  return items.sort((a, b) => a.title.localeCompare(b.title));
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
// FAMILY-AWARE (#1027): the exposure spans the ingredient family (OTC + Rx
// ibuprofen together) against the most conservative confirmed ceiling; a
// multi-item family names every member (#531 — label by what the count spans) and
// stays keyed on the binding member's id. AMOUNT-AWARE (#1854): when a mg/day max
// is confirmed and every administration's snapshotted amount parses, the verdict
// is summed MILLIGRAMS ("2400 mg … max of 1200 mg per day"); the administration
// count is the fallback basis, and prnOverMaxDetail states whichever was used.
export function prnMaxItems(profileId: number, today: string): UpcomingItem[] {
  return getPrnOverMaxItems(profileId, today).map((m) => ({
    key: prnMaxSignalKey(m.id),
    domain: "prn-max" as const,
    title: `${m.name} — over your daily max`,
    detail: prnOverMaxDetail(m),
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
  // #1727 composition 1: when a photosensitizer is active, the med fact is folded into
  // THIS line as one clause — never raised as a second warning about the same
  // afternoon. The dedupeKey is unchanged, so a dismissal still silences the day's UV
  // warning as a whole.
  const detail = enrichUvDetail(
    obs.detail,
    getWeatherMedWarnings(profileId, "photosensitizing")
  );
  return [
    {
      key: obs.dedupeKey,
      domain: "uv-exposure" as const,
      title: obs.title,
      detail,
      href: timelineDayHref(today),
      dueDate: null,
      band: "today" as const,
      dueText: "Review",
    },
  ];
}

// Medication/supplement × WEATHER safety notes (issue #1727) — the STANDALONE half of
// the composition, and the one genuinely new reach the issue grants:
//
//   • a photosensitizer active on a HIGH-UV day where the overexposure warning is NOT
//     firing (nothing logged outdoors yet, so there is no dose to warn about) — the
//     fact is still worth knowing BEFORE going out, and it disappears the moment the
//     overexposure line takes over, so the two never both speak about one afternoon;
//   • a heat-risk med while the HEATWAVE situation holds — requiring BOTH facts, so a
//     merely warm day says nothing however many diuretics are in the stack.
//
// Care-tier (#449), like the interaction/PGx/ototoxic/allergy notes it sits beside: it
// reaches Upcoming + the dashboard hero and rides the digest that already fires. NO
// dedicated send is created — the #1727 boundary. Dismissible per the care-tier norms
// (these inform, they don't escalate), keyed per (item, entry, DATE) so a dismissal
// silences that day and a new qualifying day surfaces fresh.
//
// OBLIGATION-BLIND (#1505, pinned) all the way down: the gather applies no obligation
// filter, so a `may` photosensitizer triggers exactly like a `must` one.
export function weatherMedItems(
  profileId: number,
  today: string,
  temperatureUnit: TemperatureUnit = "C"
): UpcomingItem[] {
  const items: UpcomingItem[] = [];

  const dose = getUvDoseForDay(profileId, today);
  const overexposureFiring =
    dose != null && decideUvOverexposure(today, dose) != null;
  const day = getWeatherDay(profileId, today);
  const photo = decidePhotosensitizerNote(today, {
    peakUvIndex: day?.uvIndexMax ?? null,
    hits: getWeatherMedWarnings(profileId, "photosensitizing"),
    overexposureFiring,
  });
  if (photo) {
    items.push({
      key: photo.dedupeKey,
      domain: "weather-med" as const,
      title: photo.title,
      detail: photo.detail,
      href: MEDICATIONS_HREF,
      dueDate: null,
      band: "today" as const,
      dueText: "Review",
    });
  }

  const heat = decideHeatRiskNote(today, {
    heatwaveActive: weatherSituationHolds(
      profileId,
      BUILTIN_HEATWAVE_SITUATION,
      today
    ),
    hits: getWeatherMedWarnings(profileId, "heat-risk"),
    tempLabel: fmtAmbientTemp(day?.tempMaxC ?? null, temperatureUnit),
  });
  if (heat) {
    items.push({
      key: heat.dedupeKey,
      domain: "weather-med" as const,
      title: heat.title,
      detail: heat.detail,
      href: MEDICATIONS_HREF,
      dueDate: null,
      band: "today" as const,
      dueText: "Review",
    });
  }

  return items;
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
