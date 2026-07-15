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
  getProviderNames,
} from "@/lib/queries";
import { activeByKey } from "@/lib/findings";
import { isSuppressed } from "@/lib/upcoming-suppress";
import { FOOD_TIMING_PREFIX } from "@/lib/food-drug-interactions";
import { type InteractionItem } from "@/lib/drug-interactions";
import { type PgxVariantInput } from "@/lib/pgx";
import {
  partitionMedications,
  type MedicationWithHistory,
} from "@/lib/medication-history";
import MedicationCard from "./MedicationCard";
import MedicationForm from "@/components/MedicationForm";
import IntakeWarnings from "@/components/IntakeWarnings";
import ProviderDatalist from "@/components/ProviderDatalist";
import { today } from "@/lib/db";
import { parseRxcuiIngredients } from "@/lib/rxnorm";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { lastNDates, zonedDateParts } from "@/lib/date";
import {
  getActiveSituations,
  getSituationEvents,
  getTimezone,
} from "@/lib/settings";
import { situationHistoryResolver } from "@/lib/trend-annotations";
import { isDueOn, isPostWorkoutReady } from "@/lib/supplement-schedule";
import type { Supplement } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/ui";
import {
  indexTakenByDose,
  supplementAdherenceStrip,
  STRIP_DAYS,
  type AdherenceDot,
} from "@/lib/supplement-adherence";
import { addSupplement } from "@/app/(app)/nutrition/supplement-actions";

export const dynamic = "force-dynamic";

// The Medications page (#746): the medication half of the former /medicine surface,
// now a standalone Medical-group page. One card per medication carrying its whole
// lifecycle (course history, side effects, stop/restart, PRN dose check-offs, the
// adherence strip + refill badge — #747 parity), plus the CROSS-KIND interaction
// (#144) + pharmacogenomics (#710) warnings that also render on the Supplements tab
// over the same dedupeKeys (dismiss once, silence both — #435), and a medication add
// form. Supplements live on the Nutrition → Supplements tab; /medicine redirects
// there. `intake_items` stays one table — this is a UI/route split only.
export default async function MedicationsPage() {
  const { profile } = await requireSession();
  const supplements = getSupplements(profile.id);
  const doses = getSupplementDoses(profile.id);
  const dosesBySupp = new Map<number, ReturnType<typeof getSupplementDoses>>();
  for (const d of doses) {
    const arr = dosesBySupp.get(d.item_id) ?? [];
    arr.push(d);
    dosesBySupp.set(d.item_id, arr);
  }

  const todayStr = today(profile.id);
  const taken = getTakenDoseIds(profile.id, todayStr);
  const skipped = getSkippedDoseIds(profile.id, todayStr);
  const activeSituations = new Set(getActiveSituations(profile.id));
  // Per-day situation resolver for the adherence strip (#654): a past day is scored
  // against the situations active THAT day, reconstructed from the change-log.
  const situationsOn = situationHistoryResolver(
    activeSituations,
    getSituationEvents(profile.id)
  );
  const todaysActivities = getActivitiesByDate(profile.id, todayStr);
  const isWorkoutDay = todaysActivities.length > 0;
  const predictedWorkoutDay = isPredictedWorkoutDay(profile.id, todayStr);
  const { hhmm } = zonedDateParts(getTimezone(profile.id), new Date());
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
  const trainingRestricted = isTrainingRestricted(profile.id);

  // Adherence strip inputs (shared with the supplement row via the pure
  // supplementAdherenceStrip — #313/#747 parity).
  const workoutDays = new Set(getActivityDates(profile.id));
  const dates = lastNDates(todayStr, STRIP_DAYS);
  const takenByDose = indexTakenByDose(
    getSupplementLogsInRange(profile.id, STRIP_DAYS)
  );
  const stripBySupp = new Map<number, AdherenceDot[]>();
  for (const s of supplements) {
    const doseIds = (dosesBySupp.get(s.id) ?? []).map((d) => d.id);
    stripBySupp.set(
      s.id,
      supplementAdherenceStrip(
        s,
        doseIds,
        dates,
        workoutDays,
        situationsOn,
        takenByDose
      )
    );
  }
  const stripFor = (s: Supplement): AdherenceDot[] =>
    stripBySupp.get(s.id) ?? [];

  const isMed = (s: Supplement) => s.kind === "medication";
  // A med is "loggable today" (check-offs shown) when it's active and either PRN or
  // due under today's context.
  const medDue = (s: Supplement) =>
    !!s.active && (s.as_needed === 1 || isDueOn(s, ctx));

  const allCourses = getMedicationCourses(profile.id);
  const allSideEffects = getMedicationSideEffects(profile.id);
  const coursesByItem = new Map<number, typeof allCourses>();
  for (const c of allCourses) {
    const arr = coursesByItem.get(c.item_id) ?? [];
    arr.push(c);
    coursesByItem.set(c.item_id, arr);
  }
  const sideEffectsByItem = new Map<number, typeof allSideEffects>();
  for (const se of allSideEffects) {
    const arr = sideEffectsByItem.get(se.item_id) ?? [];
    arr.push(se);
    sideEffectsByItem.set(se.item_id, arr);
  }
  const medsWithHistory: MedicationWithHistory[] = supplements
    .filter(isMed)
    .map((med) => ({
      med,
      courses: coursesByItem.get(med.id) ?? [],
      sideEffects: sideEffectsByItem.get(med.id) ?? [],
    }));
  const { current: currentMeds, past: pastMeds } =
    partitionMedications(medsWithHistory);

  const refillRates = getRefillRates(profile.id);
  const pairs = getSupplementPairs(profile.id);
  const pairsFor = (suppId: number) =>
    pairs.filter((p) => p.a_id === suppId || p.b_id === suppId);

  // Shared findings-suppression store (#435): the food-timing dismissals threaded to
  // each card's FoodGuidance, plus the bus filter for the cross-kind warnings below.
  const suppressions = getFindingSuppressions(profile.id);
  const suppressedFoodKeys = [...suppressions.entries()]
    .filter(
      ([k, rec]) =>
        k.startsWith(FOOD_TIMING_PREFIX) && isSuppressed(rec, todayStr)
    )
    .map(([k]) => k);

  // Cross-kind interaction (#144) + PGx (#710) warnings — the SAME gathers +
  // dedupeKeys the Supplements tab renders, filtered through the shared findings bus
  // so a dismiss on either surface (or Upcoming) silences every twin (#435/#746).
  const interactionWarnings = activeByKey(
    getInteractionWarnings(profile.id),
    (hit) => hit.dedupeKey,
    suppressions,
    todayStr
  );
  const pgxWarnings = activeByKey(
    getPgxWarnings(profile.id),
    (hit) => hit.dedupeKey,
    suppressions,
    todayStr
  );

  // The item stack + stored PGx variants threaded to the add form for its
  // client-side create/edit interaction + PGx notices (a supplement can interact
  // with a med, so the stack spans both kinds).
  const stackItems: InteractionItem[] = supplements.map((s) => ({
    id: s.id,
    name: s.name,
    rxcui: s.rxcui,
    rxcuiIngredients: parseRxcuiIngredients(s.rxcui_ingredients),
    active: !!s.active,
  }));
  const pgxVariants: PgxVariantInput[] = getGenomicVariants(profile.id)
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

  const medCount = currentMeds.length + pastMeds.length;

  return (
    <div>
      {/* Provider picker options for the medication add/edit forms. */}
      <ProviderDatalist names={getProviderNames()} />
      <PageHeader
        title="Medications"
        subtitle={
          medCount === 0
            ? "Prescription and OTC medications — courses, side effects, and dose check-offs."
            : `${currentMeds.length} current · ${pastMeds.length} past`
        }
      />

      {/* Cross-kind interaction + PGx warnings (also on Nutrition → Supplements). */}
      <IntakeWarnings
        interactionWarnings={interactionWarnings}
        pgxWarnings={pgxWarnings}
      />

      {medCount === 0 ? (
        <EmptyState message="No medications yet. Add one below. Supplements live on the Nutrition → Supplements tab." />
      ) : (
        <div className="space-y-6">
          {currentMeds.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 section-label text-rose-600 dark:text-rose-400">
                Current
              </h2>
              <div className="space-y-3">
                {currentMeds.map((m) => (
                  <MedicationCard
                    key={m.med.id}
                    supplement={m.med}
                    doses={dosesBySupp.get(m.med.id) ?? []}
                    allSupplements={supplements}
                    stackItems={stackItems}
                    pgxVariants={pgxVariants}
                    pairs={pairsFor(m.med.id)}
                    takenDoseIds={taken}
                    skippedDoseIds={skipped}
                    due={medDue(m.med)}
                    courses={m.courses}
                    sideEffects={m.sideEffects}
                    strip={stripFor(m.med)}
                    refillRate={refillRates.get(m.med.id) ?? null}
                    todayStr={todayStr}
                    trainingRestricted={trainingRestricted}
                    suppressedFoodKeys={suppressedFoodKeys}
                  />
                ))}
              </div>
            </section>
          )}

          {pastMeds.length > 0 && (
            <details>
              <summary className="cursor-pointer section-label">
                Past / discontinued ({pastMeds.length})
              </summary>
              <div className="mt-2 space-y-3">
                {pastMeds.map((m) => (
                  <MedicationCard
                    key={m.med.id}
                    supplement={m.med}
                    doses={dosesBySupp.get(m.med.id) ?? []}
                    allSupplements={supplements}
                    stackItems={stackItems}
                    pgxVariants={pgxVariants}
                    pairs={pairsFor(m.med.id)}
                    takenDoseIds={taken}
                    skippedDoseIds={skipped}
                    due={medDue(m.med)}
                    courses={m.courses}
                    sideEffects={m.sideEffects}
                    strip={stripFor(m.med)}
                    refillRate={refillRates.get(m.med.id) ?? null}
                    todayStr={todayStr}
                    trainingRestricted={trainingRestricted}
                    suppressedFoodKeys={suppressedFoodKeys}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Add medication — always expanded, like the other "Add entry" forms.
          Supplements are added on the Nutrition → Supplements tab. */}
      <div className="card mt-6">
        <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
          Add medication
        </h2>
        <MedicationForm
          action={addSupplement}
          allSupplements={supplements}
          stackItems={stackItems}
          pgxVariants={pgxVariants}
          trainingRestricted={trainingRestricted}
        />
      </div>
    </div>
  );
}
