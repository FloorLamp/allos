// Shared server-side gathering for the Medications surfaces (issue #817). The list
// page (rows + Today panel), the /medications/[id] detail card, and the records
// bridge all read from this ONE loader, so a med's adherence strip, refill estimate,
// PRN day-summary, and course/side-effect history are computed once and every
// surface is a formatter over the same result (no second engines — the
// "one question, one computation" rule). Server-only (reaches the DB + profile tz);
// the client components receive the pre-built values as props.

import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getSupplementLogsInRange,
  getSupplementPairs,
  getRefillRates,
  getActivitiesByDate,
  getActivityDates,
  isPredictedWorkoutDay,
  getMedicationCourses,
  getMedicationSideEffects,
  getInteractionWarnings,
  getPgxWarnings,
  getOtotoxicWarnings,
  getGenomicVariants,
  getFindingSuppressions,
  getAdministrationsForItemsOnDate,
  getPediatricFormContext,
  getPrnMedicationsForQuickLog,
  getMedicalRecords,
} from "@/lib/queries";
import { redoseWindowStatus } from "@/lib/prn-redose";
import { now as clockNow } from "@/lib/clock";
import { redoseCardLabel } from "@/lib/redose-format";
import {
  administrationDayLabel,
  administrationLastDoseLabel,
  formatGivenAtClock,
} from "@/lib/administration-format";
import { activeByKey } from "@/lib/findings";
import { isSuppressed } from "@/lib/upcoming-suppress";
import { FOOD_TIMING_PREFIX } from "@/lib/food-drug-interactions";
import { type InteractionItem } from "@/lib/drug-interactions";
import { type PgxVariantInput } from "@/lib/pgx";
import {
  partitionMedications,
  type MedicationWithHistory,
} from "@/lib/medication-history";
import { medicationStartDate } from "@/lib/profile-summary";
import { monitoringRowNoteText } from "@/lib/medication-monitoring";
import {
  buildMedicationList,
  type MedicationListRow,
} from "@/lib/medication-list";
import { today } from "@/lib/db";
import { parseRxcuiIngredients } from "@/lib/rxnorm";
import { isTrainingRestricted } from "@/lib/age-gate";
import { lastNDates, zonedDateParts, parseUtcSql } from "@/lib/date";
import {
  getActiveSituations,
  getSituationEvents,
  getTimezone,
  getUserAge,
} from "@/lib/settings";
import { situationHistoryResolver } from "@/lib/trend-annotations";
import { isDueOn, isPostWorkoutReady } from "@/lib/supplement-schedule";
import type { PediatricFormContext } from "@/lib/prn-dosing";
import type {
  MedicationCourse,
  MedicationSideEffect,
  Supplement,
  SupplementDose,
  SupplementPair,
} from "@/lib/types";
import {
  indexTakenByDose,
  supplementAdherenceStrip,
  STRIP_DAYS,
  type AdherenceDot,
} from "@/lib/supplement-adherence";
import type { DoseRate } from "@/lib/refill";
import {
  buildAdherenceCalendar,
  type AdherenceCalendarModel,
} from "@/lib/adherence-calendar";
import {
  unmatchedPrescriptionRecords,
  medBridgeDismissalKey,
  type TrackedMedLike,
} from "@/lib/medication-record-match";
import { getLastAdministrationDateByItem } from "@/lib/queries";
import {
  dormantPrnCandidates,
  type DormantPrnInput,
  type DormantPrnSuggestion,
} from "@/lib/dormant-prn";

// One imported prescription record with no matched tracked med, surfaced by the
// "From your records" bridge as a suggest-only "Track this" (#560/#817).
export interface BridgeSuggestion {
  recordId: number;
  name: string;
  detail: string | null;
  date: string;
  dedupeKey: string;
}

// The per-med derived context every card/row formats over. `prnRedoseLine` is the
// marker-agnostic next-window chip; `prnDayLabel`/`prnTimes` are the administration
// summary; `strip`/`refillRate` back the #747 parity adherence + refill widgets.
export interface MedCardData {
  med: Supplement;
  doses: SupplementDose[];
  courses: MedicationCourse[];
  sideEffects: MedicationSideEffect[];
  strip: AdherenceDot[];
  refillRate: DoseRate | null;
  due: boolean;
  pairs: SupplementPair[];
  prnDayLabel: string | null;
  // Today's PRN administrations with their ledger ids (#851 item 11), so each chip on
  // the card can offer remove-with-undo. Most recent first.
  prnAdministrations: { id: number; label: string }[];
  prnRedoseLine: string | null;
  // The "Requires monitoring: …" row note (issue #995) — the curated labs a clinician
  // typically watches while on this drug, listed on the row (independent of dueness).
  // Null for an unmonitored med or a discontinued one.
  monitoringNote: string | null;
}

export interface MedicationsData {
  todayStr: string;
  tz: string;
  // The profile's local wall clock (HH:MM) at load, so the Today panel can flag a
  // past-bucket unresolved dose in the profile's timezone (#852 item 1).
  nowHhmm: string;
  trainingRestricted: boolean;
  // The profile's age in whole years (issue #851 item 4), threaded to FoodGuidance so a
  // child never sees an age-gated food note (alcohol → adult). Null when unknown.
  age: number | null;
  taken: Set<number>;
  skipped: Set<number>;
  allSupplements: Supplement[];
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  pediatric: PediatricFormContext;
  suppressedFoodKeys: string[];
  interactionWarnings: ReturnType<typeof getInteractionWarnings>;
  pgxWarnings: ReturnType<typeof getPgxWarnings>;
  ototoxicWarnings: ReturnType<typeof getOtotoxicWarnings>;
  current: MedCardData[];
  past: MedCardData[];
  // The recently-used active PRN meds for the Today panel, with pre-formatted
  // day-summary + redose-window lines (same read the dashboard widget uses).
  prnToday: {
    id: number;
    name: string;
    amount: string | null;
    dayLabel: string;
    redoseLine: string | null;
  }[];
  bridge: BridgeSuggestion[];
  // Bridge suggestions the user has dismissed (#852 item 6): surfaced in a collapsed
  // "dismissed (N)" disclosure with restore, so a mis-tap is recoverable while the
  // suggest-only contract holds. Empty when nothing's been dismissed.
  dismissedBridge: BridgeSuggestion[];
  // Dormant-PRN sweep (issue #880 item 3): active PRN meds with no dose in 90+ days,
  // offered as suggest-only "move to past" — the existing-backlog cleanup episode-end only
  // catches going forward. `dismissedDormantPrn` mirrors the bridge's recoverable list.
  dormantPrn: DormantPrnSuggestion[];
  dismissedDormantPrn: DormantPrnSuggestion[];
  byId: Map<number, MedCardData>;
}

// Load everything the Medications surfaces render, computed once for the profile.
export function loadMedicationsData(profileId: number): MedicationsData {
  const supplements = getSupplements(profileId);
  const doses = getSupplementDoses(profileId);
  const dosesBySupp = new Map<number, SupplementDose[]>();
  for (const d of doses) {
    const arr = dosesBySupp.get(d.item_id) ?? [];
    arr.push(d);
    dosesBySupp.set(d.item_id, arr);
  }

  const todayStr = today(profileId);
  const tz = getTimezone(profileId);
  const taken = getTakenDoseIds(profileId, todayStr);
  const skipped = getSkippedDoseIds(profileId, todayStr);
  const activeSituations = new Set(getActiveSituations(profileId));
  const situationsOn = situationHistoryResolver(
    activeSituations,
    getSituationEvents(profileId)
  );
  const todaysActivities = getActivitiesByDate(profileId, todayStr);
  const isWorkoutDay = todaysActivities.length > 0;
  const predictedWorkoutDay = isPredictedWorkoutDay(profileId, todayStr);
  // Through the frozen-clock seam (#1005): a bare new Date() here diverges from
  // clock-stamped given_at/log times under ALLOS_TEST_NOW (a production no-op).
  const { hhmm } = zonedDateParts(tz, clockNow());
  const nowMinutes = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const postWorkoutReady = isPostWorkoutReady(
    todaysActivities.map((a) => a.end_time ?? a.start_time),
    nowMinutes
  );
  const ctx = {
    isWorkoutDay,
    activeSituations,
    predictedWorkoutDay,
    postWorkoutReady,
  };
  const trainingRestricted = isTrainingRestricted(profileId);

  // Adherence strip inputs (shared with the supplement row via the pure
  // supplementAdherenceStrip — #313/#747 parity).
  const workoutDays = new Set(getActivityDates(profileId));
  const dates = lastNDates(todayStr, STRIP_DAYS);
  const takenByDose = indexTakenByDose(
    getSupplementLogsInRange(profileId, STRIP_DAYS)
  );

  const allCourses = getMedicationCourses(profileId);
  const allSideEffects = getMedicationSideEffects(profileId);
  const coursesByItem = new Map<number, MedicationCourse[]>();
  for (const c of allCourses) {
    const arr = coursesByItem.get(c.item_id) ?? [];
    arr.push(c);
    coursesByItem.set(c.item_id, arr);
  }
  const sideEffectsByItem = new Map<number, MedicationSideEffect[]>();
  for (const se of allSideEffects) {
    const arr = sideEffectsByItem.get(se.item_id) ?? [];
    arr.push(se);
    sideEffectsByItem.set(se.item_id, arr);
  }

  const refillRates = getRefillRates(profileId);
  const pairs = getSupplementPairs(profileId);
  const pairsFor = (suppId: number) =>
    pairs.filter((p) => p.a_id === suppId || p.b_id === suppId);

  // Per-PRN-med day summary + redose-window line (#797/#798), profile-tz aware and
  // formatted by the SAME redoseCardLabel/administrationDayLabel the dashboard uses.
  // Batch the day's administrations for every PRN med in ONE query (#885) rather than
  // one query per PRN item inside the card-builder loop — an N+1 over the un-purged
  // intake_item_logs ledger. Per-item derivation stays in JS below.
  const nowInstant = clockNow();
  const prnMedIds = supplements
    .filter((s) => s.kind === "medication" && s.as_needed === 1)
    .map((s) => s.id);
  const adminsByItem = getAdministrationsForItemsOnDate(
    profileId,
    prnMedIds,
    todayStr
  );
  const prnInfoFor = (
    s: Supplement
  ): {
    label: string | null;
    administrations: { id: number; label: string }[];
    redoseLine: string | null;
  } => {
    if (s.as_needed !== 1)
      return { label: null, administrations: [], redoseLine: null };
    const admins = adminsByItem.get(s.id) ?? [];
    const administrations = admins.map((a) => ({
      id: a.id,
      label: formatGivenAtClock(tz, a.given_at ?? a.taken_at),
    }));
    const last = admins[0] ? (admins[0].given_at ?? admins[0].taken_at) : null;
    let redoseLine: string | null = null;
    if (s.min_interval_hours != null && s.max_daily_count != null && last) {
      redoseLine = redoseCardLabel(
        redoseWindowStatus({
          minIntervalHours: s.min_interval_hours,
          maxDailyCount: s.max_daily_count,
          latestGivenAt: parseUtcSql(last),
          countToday: admins.length,
          now: nowInstant,
        })
      );
    }
    const lastClock = formatGivenAtClock(tz, last);
    return {
      label: redoseLine
        ? administrationLastDoseLabel(admins.length, lastClock)
        : administrationDayLabel(admins.length, lastClock),
      administrations,
      redoseLine,
    };
  };

  // A med is "loggable today" (dose check-offs shown) when it's active and either
  // PRN or due under today's context.
  const medDue = (s: Supplement) =>
    !!s.active && (s.as_needed === 1 || isDueOn(s, ctx));

  const buildCardData = (med: Supplement): MedCardData => {
    const doseIds = (dosesBySupp.get(med.id) ?? []).map((d) => d.id);
    const prn = prnInfoFor(med);
    return {
      med,
      doses: dosesBySupp.get(med.id) ?? [],
      courses: coursesByItem.get(med.id) ?? [],
      sideEffects: sideEffectsByItem.get(med.id) ?? [],
      strip: supplementAdherenceStrip(
        med,
        doseIds,
        dates,
        workoutDays,
        situationsOn,
        takenByDose
      ),
      refillRate: refillRates.get(med.id) ?? null,
      due: medDue(med),
      pairs: pairsFor(med.id),
      prnDayLabel: prn.label,
      prnAdministrations: prn.administrations,
      prnRedoseLine: prn.redoseLine,
      monitoringNote: med.active
        ? monitoringRowNoteText({
            name: med.name,
            rxcui: med.rxcui,
            rxcuiIngredients: parseRxcuiIngredients(med.rxcui_ingredients),
          })
        : null,
    };
  };

  const medsWithHistory: MedicationWithHistory[] = supplements
    .filter((s) => s.kind === "medication")
    .map((med) => ({
      med,
      courses: coursesByItem.get(med.id) ?? [],
      sideEffects: sideEffectsByItem.get(med.id) ?? [],
    }));
  const { current, past } = partitionMedications(medsWithHistory);
  const currentData = current.map((m) => buildCardData(m.med));
  const pastData = past.map((m) => buildCardData(m.med));
  const byId = new Map<number, MedCardData>();
  for (const d of [...currentData, ...pastData]) byId.set(d.med.id, d);

  // Findings-suppression store (#435): food-timing dismissals for FoodGuidance, the
  // cross-kind interaction/PGx bus filter, and the med-bridge dismissals.
  const suppressions = getFindingSuppressions(profileId);
  const suppressedFoodKeys = [...suppressions.entries()]
    .filter(
      ([k, rec]) =>
        k.startsWith(FOOD_TIMING_PREFIX) && isSuppressed(rec, todayStr)
    )
    .map(([k]) => k);

  const interactionWarnings = activeByKey(
    getInteractionWarnings(profileId),
    (hit) => hit.dedupeKey,
    suppressions,
    todayStr
  );
  const pgxWarnings = activeByKey(
    getPgxWarnings(profileId),
    (hit) => hit.dedupeKey,
    suppressions,
    todayStr
  );
  const ototoxicWarnings = activeByKey(
    getOtotoxicWarnings(profileId),
    (hit) => hit.dedupeKey,
    suppressions,
    todayStr
  );

  const stackItems: InteractionItem[] = supplements.map((s) => ({
    id: s.id,
    name: s.name,
    rxcui: s.rxcui,
    rxcuiIngredients: parseRxcuiIngredients(s.rxcui_ingredients),
    active: !!s.active,
  }));
  const pgxVariants: PgxVariantInput[] = getGenomicVariants(profileId)
    .filter((v) => v.result_type === "pharmacogenomic")
    .map((v) => ({
      id: v.id,
      gene: v.gene,
      star_allele: v.star_allele,
      genotype: v.genotype,
      variant: v.variant,
      interpretation: v.interpretation,
      notes: v.notes,
    }));

  const pediatric: PediatricFormContext = getPediatricFormContext(profileId);

  // Today panel PRN rows — the recently-used ordering the dashboard quick-log uses,
  // with the same pre-formatted labels (one computation).
  const prnToday = getPrnMedicationsForQuickLog(profileId).map((m) => {
    const lastClock = formatGivenAtClock(tz, m.lastGivenAt);
    const redoseLine =
      m.minIntervalHours != null && m.maxDailyCount != null && m.lastGivenAt
        ? redoseCardLabel(
            redoseWindowStatus({
              minIntervalHours: m.minIntervalHours,
              maxDailyCount: m.maxDailyCount,
              latestGivenAt: parseUtcSql(m.lastGivenAt),
              countToday: m.count,
              now: nowInstant,
            })
          )
        : null;
    return {
      id: m.id,
      name: m.name,
      amount: m.amount,
      dayLabel: redoseLine
        ? administrationLastDoseLabel(m.count, lastClock)
        : administrationDayLabel(m.count, lastClock),
      redoseLine,
    };
  });

  // "From your records" bridge (#817): imported prescription records with no matched
  // tracked med, minus any the user dismissed (name-keyed #203 via the bus).
  const trackedMeds: TrackedMedLike[] = supplements
    .filter((s) => s.kind === "medication")
    .map((s) => ({
      name: s.name,
      brand: s.brand,
      rxcui: s.rxcui,
      rxcuiIngredients: parseRxcuiIngredients(s.rxcui_ingredients),
    }));
  const prescriptionRecords = getMedicalRecords(profileId, {
    category: "prescription",
    sort: "date",
    dir: "desc",
  });
  const allBridge: BridgeSuggestion[] = unmatchedPrescriptionRecords(
    prescriptionRecords,
    trackedMeds
  ).map((r) => {
    const dedupeKey = medBridgeDismissalKey(r);
    return {
      recordId: r.id,
      name: r.canonical_name?.trim() || r.name,
      detail: [r.value, r.unit].filter(Boolean).join(" ") || null,
      date: r.date,
      dedupeKey,
    };
  });
  const isDismissed = (s: BridgeSuggestion) => {
    const rec = suppressions.get(s.dedupeKey);
    return !!(rec && isSuppressed(rec, todayStr));
  };
  const bridge = allBridge.filter((s) => !isDismissed(s));
  // Dismissed suggestions surfaced (recoverable) in the #852 item 6 disclosure.
  const dismissedBridge = allBridge.filter(isDismissed);

  // Dormant-PRN sweep (#880 item 3): active PRN meds with no dose in 90+ days. Anchored on
  // the last 'taken' administration (or creation, if never dosed) via the ONE gather, then
  // filtered by the same #203 bus dismissals (id-keyed) as the bridge.
  const lastAdminByItem = getLastAdministrationDateByItem(profileId);
  const dormantInputs: DormantPrnInput[] = supplements
    .filter((s) => s.kind === "medication")
    .map((s) => ({
      itemId: s.id,
      name: s.name,
      asNeeded: s.as_needed === 1,
      active: !!s.active,
      lastAdministration: lastAdminByItem.get(s.id) ?? null,
      createdOn: s.created_at.slice(0, 10),
    }));
  const allDormant = dormantPrnCandidates(dormantInputs, todayStr);
  const isDormantDismissed = (d: DormantPrnSuggestion) => {
    const rec = suppressions.get(d.dedupeKey);
    return !!(rec && isSuppressed(rec, todayStr));
  };
  const dormantPrn = allDormant.filter((d) => !isDormantDismissed(d));
  const dismissedDormantPrn = allDormant.filter(isDormantDismissed);

  return {
    todayStr,
    tz,
    nowHhmm: hhmm,
    trainingRestricted,
    age: getUserAge(profileId),
    taken,
    skipped,
    allSupplements: supplements,
    stackItems,
    pgxVariants,
    pediatric,
    suppressedFoodKeys,
    interactionWarnings,
    pgxWarnings,
    ototoxicWarnings,
    current: currentData,
    past: pastData,
    prnToday,
    bridge,
    dismissedBridge,
    dormantPrn,
    dismissedDormantPrn,
    byId,
  };
}

// The current-medication list rows (#852 item 4) — the ONE assembly the printable list
// and the tokenized /share view both format over (buildMedicationList is the pure
// engine; this maps the already-gathered Current cards into its input). "Current" is
// the medications page's Current set (active, structured meds); prescriber + start date
// + schedule come straight off the card data, no second DB pass.
export function medicationListFromCards(
  cards: MedCardData[]
): MedicationListRow[] {
  return buildMedicationList(
    cards.map((c) => ({
      id: c.med.id,
      name: c.med.name,
      brand: c.med.brand,
      product: c.med.product,
      asNeeded: c.med.as_needed === 1,
      rx: c.med.rx === 1,
      prescriber: c.med.prescriber,
      doseAmounts: c.doses.map((d) => d.amount).filter((a): a is string => !!a),
      timesOfDay: c.doses.map((d) => d.time_of_day),
      startedOn: medicationStartDate(c.courses, c.med.created_at),
    }))
  );
}

// Load the current-medication list for a profile (print / share). Reuses the ONE
// loadMedicationsData gather so the artifact can't disagree with the medications page.
export function getCurrentMedicationList(
  profileId: number
): MedicationListRow[] {
  return medicationListFromCards(loadMedicationsData(profileId).current);
}

// The number of days the detail-page month adherence calendar spans (#852 item 5) — a
// five-week window so a full month is always visible.
export const ADHERENCE_MONTH_DAYS = 35;

// Month adherence calendar for one medication (#852 item 5) — the SAME
// supplementAdherenceStrip computation the 14-day strip uses, over a longer window,
// laid out on a Sun→Sat grid by the pure buildAdherenceCalendar. No new model. Returns
// an empty grid for an unknown/foreign id.
export function getMedicationAdherenceCalendar(
  profileId: number,
  itemId: number,
  days: number = ADHERENCE_MONTH_DAYS
): AdherenceCalendarModel {
  const med = getSupplements(profileId).find(
    (s) => s.id === itemId && s.kind === "medication"
  );
  if (!med) return buildAdherenceCalendar([]);
  const doseIds = getSupplementDoses(profileId)
    .filter((d) => d.item_id === itemId)
    .map((d) => d.id);
  const todayStr = today(profileId);
  const dates = lastNDates(todayStr, days);
  const workoutDays = new Set(getActivityDates(profileId));
  const situationsOn = situationHistoryResolver(
    new Set(getActiveSituations(profileId)),
    getSituationEvents(profileId)
  );
  const takenByDose = indexTakenByDose(
    getSupplementLogsInRange(profileId, days)
  );
  const strip = supplementAdherenceStrip(
    med,
    doseIds,
    dates,
    workoutDays,
    situationsOn,
    takenByDose
  );
  return buildAdherenceCalendar(strip);
}
