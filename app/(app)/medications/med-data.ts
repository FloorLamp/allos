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
  getGenomicVariants,
  getFindingSuppressions,
  getAdministrationsForItemOnDate,
  getPediatricFormContext,
  getPrnMedicationsForQuickLog,
  getMedicalRecords,
} from "@/lib/queries";
import { redoseWindowStatus } from "@/lib/prn-redose";
import { redoseCardLabel } from "@/lib/redose-format";
import {
  administrationDayLabel,
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
import { today } from "@/lib/db";
import { parseRxcuiIngredients } from "@/lib/rxnorm";
import { isTrainingRestricted } from "@/lib/age-gate";
import { lastNDates, zonedDateParts, parseUtcSql } from "@/lib/date";
import {
  getActiveSituations,
  getSituationEvents,
  getTimezone,
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
  unmatchedPrescriptionRecords,
  medBridgeDismissalKey,
  type TrackedMedLike,
} from "@/lib/medication-record-match";

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
  prnTimes: string[];
  prnRedoseLine: string | null;
}

export interface MedicationsData {
  todayStr: string;
  tz: string;
  trainingRestricted: boolean;
  taken: Set<number>;
  skipped: Set<number>;
  allSupplements: Supplement[];
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  pediatric: PediatricFormContext;
  suppressedFoodKeys: string[];
  interactionWarnings: ReturnType<typeof getInteractionWarnings>;
  pgxWarnings: ReturnType<typeof getPgxWarnings>;
  current: MedCardData[];
  past: MedCardData[];
  // The recently-used active PRN meds for the Today panel, with pre-formatted
  // day-summary + redose-window lines (same read the dashboard widget uses).
  prnToday: {
    id: number;
    name: string;
    dayLabel: string;
    redoseLine: string | null;
  }[];
  bridge: BridgeSuggestion[];
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
  const { hhmm } = zonedDateParts(tz, new Date());
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
  const nowInstant = new Date();
  const prnInfoFor = (
    s: Supplement
  ): { label: string | null; times: string[]; redoseLine: string | null } => {
    if (s.as_needed !== 1) return { label: null, times: [], redoseLine: null };
    const admins = getAdministrationsForItemOnDate(profileId, s.id, todayStr);
    const times = admins.map((a) =>
      formatGivenAtClock(tz, a.given_at ?? a.taken_at)
    );
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
    return {
      label: administrationDayLabel(
        admins.length,
        formatGivenAtClock(tz, last)
      ),
      times,
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
      prnTimes: prn.times,
      prnRedoseLine: prn.redoseLine,
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
  const prnToday = getPrnMedicationsForQuickLog(profileId).map((m) => ({
    id: m.id,
    name: m.name,
    dayLabel: administrationDayLabel(
      m.count,
      formatGivenAtClock(tz, m.lastGivenAt)
    ),
    redoseLine:
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
        : null,
  }));

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
  const bridge: BridgeSuggestion[] = unmatchedPrescriptionRecords(
    prescriptionRecords,
    trackedMeds
  )
    .map((r) => {
      const dedupeKey = medBridgeDismissalKey(r);
      return {
        recordId: r.id,
        name: r.canonical_name?.trim() || r.name,
        detail: [r.value, r.unit].filter(Boolean).join(" ") || null,
        date: r.date,
        dedupeKey,
      };
    })
    .filter((s) => {
      const rec = suppressions.get(s.dedupeKey);
      return !(rec && isSuppressed(rec, todayStr));
    });

  return {
    todayStr,
    tz,
    trainingRestricted,
    taken,
    skipped,
    allSupplements: supplements,
    stackItems,
    pgxVariants,
    pediatric,
    suppressedFoodKeys,
    interactionWarnings,
    pgxWarnings,
    current: currentData,
    past: pastData,
    prnToday,
    bridge,
    byId,
  };
}
