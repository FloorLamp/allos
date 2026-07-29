import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getSupplementLogsInRange,
  getSupplementPairs,
  getRefillRates,
  getPoolChips,
  getPendingSuggestions,
  getActivitiesByDate,
  getActivityDates,
  isPredictedWorkoutDay,
  getConditions,
  getDietaryLimitWarnings,
  getDietaryAdequacy,
  getInteractionWarnings,
  getSafetyScreeningCoverage,
  getGenomicVariants,
  getFindingSuppressions,
  getEffectiveActiveSituations,
  getDerivedSituationLines,
  getNavRelevance,
  countVisiblePools,
} from "@/lib/queries";
import { activeByKey, activeFindings } from "@/lib/findings";
import {
  buildAdherencePatternFindings,
  buildDemotionSuggestionFindings,
} from "@/lib/rule-findings";
import { intakeWarningsForSurface } from "@/lib/intake-warning-surface";
import { isSuppressed } from "@/lib/upcoming-suppress";
import {
  ulWarningTitle,
  ulWarningDetail,
  ulWarningEvidence,
  dietaryLimitSignalKey,
  rdaAdequacyTitle,
  rdaAdequacyDetail,
  rdaAdequacyEvidence,
  rdaAdequacySignalKey,
} from "@/lib/dri";
import { foodSourcesForDriNutrient } from "@/lib/food-suggest";
import { FOOD_TIMING_PREFIX } from "@/lib/food-drug-interactions";
import { type InteractionItem } from "@/lib/drug-interactions";
import { type PgxVariantInput } from "@/lib/pgx";
import { FindingCard, DismissFindingButton } from "@/components/FindingCard";
import { Notice } from "@/components/Notice";
import IntakeWarnings, { IntakeSafetyScope } from "@/components/IntakeWarnings";
import { today } from "@/lib/db";
import { parseRxcuiIngredients } from "@/lib/rxnorm";
import { requireSession } from "@/lib/auth";
import { requireScope } from "@/lib/scope";
import SharedSuppliesLink from "@/components/intake/SharedSuppliesLink";
import { isTrainingRestricted } from "@/lib/age-gate";
import { lastNDates, zonedDateParts } from "@/lib/date";
import {
  getActiveSituations,
  getDisplayFormatPrefs,
  getSituationEvents,
  getSituations,
  getTimezone,
  getExcludedFoodGroups,
  getWeekMode,
  getWeekStart,
} from "@/lib/settings";
import { formatWeekdayDate } from "@/lib/format-date";
import { weekWindow } from "@/lib/week-window";
import type { SupplementAdherenceDayInput } from "@/lib/supplement-weekly-adherence";
import { situationHistoryResolver } from "@/lib/trend-annotations";
import {
  suggestedSituationsFromConditions,
  situationActivationLine,
  mergedSituationOptions,
} from "@/lib/situations";
import { withPeriodOption } from "@/lib/derived-situations";
import {
  countSituationalDue,
  isDueOn,
  isPostWorkoutReady,
  timeBucket,
  TIME_BUCKETS,
  TIME_BUCKET_LABELS,
  PRIORITY_ORDER,
  PRIORITY_LABELS,
  CONDITION_LABELS,
  priorityClass,
  workoutDaySubtitleLabel,
  heldBySituation,
  type TimeBucket,
} from "@/lib/supplement-schedule";
import { compareDoseDay, type DoseDayEntry } from "@/lib/dose-order";
import type { Supplement, SupplementDose } from "@/lib/types";
import { EmptyState } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";
import { SituationOptionsProvider } from "@/components/SituationOptionsContext";
import EditableSupplementRow from "./EditableSupplementRow";
import DismissSuggestionButton from "./DismissSuggestionButton";
import {
  indexTakenByDose,
  doseWindowSince,
  supplementAdherenceStrip,
  STRIP_DAYS,
  type AdherenceDot,
} from "@/lib/supplement-adherence";
import {
  separatePairWarnings,
  type KeepApartWarning,
} from "@/lib/intake-pairs";
import SuggestionsForm from "./SuggestionsForm";
import AdherenceFindings from "./AdherenceFindings";
import DemotionSuggestions from "./DemotionSuggestions";
import SupplementSchedule from "./SupplementSchedule";
import SupplementInsightBadges from "./SupplementInsightBadges";
import AddSupplementModal from "./AddSupplementModal";
import SupplementWeeklyAdherence from "@/components/SupplementWeeklyAdherence";
import {
  toggleSituation,
  acceptSuggestion,
  activateSurgerySituation,
  clearSurgerySituation,
  dismissSurgeryBridge,
  dismissDerivedPoorSleep,
} from "./supplement-actions";
import { getSurgeryBridgeSuggestions } from "@/lib/queries";
import { BUILTIN_PRESURGERY_SITUATION } from "@/lib/surgery-bridge";

export const dynamic = "force-dynamic";

interface Item {
  supplement: Supplement;
  dose: SupplementDose;
}

// The Supplements tab of the Nutrition umbrella (#746): the former /medicine
// supplement surface — context-aware scheduling, stack UL/RDA + cross-kind interaction/PGx
// warnings, a slot-filterable schedule, compact coaching disclosures, and modal
// add/edit flows. A self-contained async server component rendered by the tabbed
// nutrition page.
export default async function SupplementsTab() {
  const { login, profile } = await requireSession();
  // The medicine-cabinet door (#1522) counts over the caller's WHOLE accessible set,
  // not the acting profile: a shared bottle is household-scoped and has no kind of
  // its own, so this tab and Medications show the same number and land on the same
  // list. Everything else on this tab stays single-profile.
  const cabinetCount = countVisiblePools((await requireScope()).ids);
  const todayStr = today(profile.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);
  // Dietary preferences (#975): the RDA-adequacy food-source lines filter/substitute
  // excluded groups the same way the #577 suggestions do.
  const excludedGroups = getExcludedFoodGroups(profile.id);
  const supplements = getSupplements(profile.id);
  const suppById = new Map(supplements.map((s) => [s.id, s]));
  const doses = getSupplementDoses(profile.id);
  const dosesBySupp = new Map<number, SupplementDose[]>();
  for (const d of doses) {
    const arr = dosesBySupp.get(d.item_id) ?? [];
    arr.push(d);
    dosesBySupp.set(d.item_id, arr);
  }

  const taken = getTakenDoseIds(profile.id, todayStr);
  const skipped = getSkippedDoseIds(profile.id, todayStr);
  const activeSituations = new Set(getActiveSituations(profile.id));
  // Per-day situation resolver for the adherence strip: a past day is scored against
  // the situations active THAT day (#654), reconstructed from the change-log, not the
  // current toggle applied retroactively.
  const situationsOn = situationHistoryResolver(
    activeSituations,
    getSituationEvents(profile.id)
  );
  const todaysActivities = getActivitiesByDate(profile.id, todayStr);
  const isWorkoutDay = todaysActivities.length > 0;
  // #558: a pre_workout supplement should surface on a PREDICTED training day
  // (from the inferred cadence), not only once a session is logged; post_workout
  // stays gated on a logged session, held until the earliest session's end time.
  const predictedWorkoutDay = isPredictedWorkoutDay(profile.id, todayStr);
  const tz = getTimezone(profile.id);
  const { hhmm } = zonedDateParts(tz, new Date());
  const nowMinutes = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const postWorkoutReady = isPostWorkoutReady(
    todaysActivities.map((a) => a.end_time ?? a.start_time),
    nowMinutes
  );
  // Derived context (#1292/#1298) widens the active set for TODAY's dueness only (a
  // surfacing path) — the `situationsOn` history resolver above stays declared-only so
  // it can't apply derived names to past days. A Poor sleep / Period item goes due
  // exactly while its derived context holds.
  const effectiveSituations = getEffectiveActiveSituations(
    profile.id,
    todayStr
  );
  const ctx = {
    isWorkoutDay,
    activeSituations: effectiveSituations,
    predictedWorkoutDay,
    postWorkoutReady,
  };
  // The visible derived-context state lines (shared with the check-in + digest, #221)
  // and whether the poor-sleep line carries the one-tap "Not today" override (only when
  // DERIVED — a declared toggle is cleared by its chip, never the override, #1292).
  const derivedLines = getDerivedSituationLines(profile.id, todayStr);
  const showPoorSleepOverride = derivedLines.poorSleepOverridable;
  // When fitness tracking is restricted for this profile the workout/rest-day
  // concept is meaningless, so we drop the subtitle prefix and the workout/
  // rest-day schedule options (see lib/age-gate.ts).
  const trainingRestricted = isTrainingRestricted(profile.id);

  // Adherence strip inputs.
  const workoutDays = new Set(getActivityDates(profile.id));
  const dates = lastNDates(todayStr, STRIP_DAYS);
  // The schedule control mirrors Food's bounded recent-day lens: today first,
  // followed by the previous six days. Adherence keeps its wider 14-day window.
  const scheduleDates = dates
    .slice(-7)
    .reverse()
    .map((date, index) => ({
      date,
      label:
        index === 0
          ? "Today"
          : index === 1
            ? "Yesterday"
            : formatWeekdayDate(date, formatPrefs),
    }));
  const takenByDose = indexTakenByDose(
    getSupplementLogsInRange(profile.id, STRIP_DAYS)
  );
  // Per-supplement adherence strip, aggregated across the supplement's doses:
  // a day is "taken" when all its due doses were logged, "partial" when some
  // were, "skipped" when every due dose was deliberately skipped (#232),
  // "missed" when none were resolved (but it was due), and "na" when not due.
  // Policy lives in the shared supplementAdherenceStrip (issue #313).
  const stripBySupp = new Map<number, AdherenceDot[]>();
  for (const s of supplements) {
    stripBySupp.set(
      s.id,
      supplementAdherenceStrip(
        s,
        dosesBySupp.get(s.id) ?? [],
        dates,
        workoutDays,
        situationsOn,
        takenByDose,
        tz
      )
    );
  }
  const stripFor = (s: Supplement): AdherenceDot[] =>
    stripBySupp.get(s.id) ?? [];

  // Build dose-level items, partitioned by today's context.
  const itemsFor = (preds: (s: Supplement) => boolean): Item[] =>
    supplements
      .filter(preds)
      .flatMap((s) =>
        (dosesBySupp.get(s.id) ?? []).map((dose) => ({ supplement: s, dose }))
      );
  const existedOn = (item: Item, date: string) => {
    const since = doseWindowSince(
      item.supplement.created_at,
      item.dose.created_at,
      takenByDose.get(item.dose.id),
      tz
    );
    return since == null || date >= since;
  };

  // Medications render in their own section; the buckets/paused
  // lists below are supplements only, so the two kinds never intermix.
  const isMed = (s: Supplement) => s.kind === "medication";
  // Supplement-kind items only — this tab's empty state keys on these, not the
  // full intake list (a profile with only medications is empty HERE, #746).
  const supplementItems = supplements.filter((s) => !isMed(s));
  const currentWeek = weekWindow(
    todayStr,
    getWeekMode(profile.id),
    getWeekStart(profile.id)
  );
  const weeklyDates = dates.filter(
    (date) => date >= currentWeek.start && date <= currentWeek.end
  );
  const weeklyAdherenceDays: SupplementAdherenceDayInput[] = weeklyDates.map(
    (date) => {
      const dateContext =
        date === todayStr
          ? ctx
          : {
              isWorkoutDay: workoutDays.has(date),
              activeSituations: situationsOn(date),
            };
      const dueDoseIds = itemsFor(
        (supplement) =>
          !isMed(supplement) &&
          !!supplement.active &&
          isDueOn(supplement, dateContext)
      )
        .filter((item) => existedOn(item, date))
        .map((item) => item.dose.id);
      return {
        date,
        due: dueDoseIds.length,
        taken: dueDoseIds.filter((doseId) =>
          takenByDose.get(doseId)?.taken.has(date)
        ).length,
        skipped: dueDoseIds.filter((doseId) =>
          takenByDose.get(doseId)?.skipped.has(date)
        ).length,
        isToday: date === todayStr,
      };
    }
  );
  const weeklyAdherenceLabels = Object.fromEntries(
    weeklyDates.map((date) => [date, formatWeekdayDate(date, formatPrefs)])
  );
  // A situational HOLD (#1296): the item is active but its pause_situation is on, so
  // it's suppressed from every due path (isDueOn returns false). Split it OUT of the
  // "not scheduled today" bucket into its own visible Held section — a held item is a
  // deliberate, discoverable suppression ("Held — Pre-surgery active"), never a silent
  // absence, so a forgotten-active pause situation stays findable. It consults the SAME
  // effectiveSituations (declared ∪ derived, #1292/#1360) `isDueOn` reads, so the
  // held/due/not-scheduled split stays consistent: a pause link naming a derived context
  // (e.g. "Poor sleep") holds exactly while that context is active, and a declared
  // surgery hold and a derived poor-sleep flow through the one union together.
  const isHeld = (s: Supplement) => !!heldBySituation(s, effectiveSituations);
  const dueItems = itemsFor((s) => !isMed(s) && !!s.active && isDueOn(s, ctx));
  const heldItems = itemsFor((s) => !isMed(s) && !!s.active && isHeld(s));
  const notScheduled = itemsFor(
    (s) => !isMed(s) && !!s.active && !isDueOn(s, ctx) && !isHeld(s)
  );
  const paused = itemsFor((s) => !isMed(s) && !s.active);

  // Medications render on their own page (#746); this tab is supplements only, so
  // the `isMed` predicate below simply excludes them from every list here.

  // Shared findings-suppression store (#227/#435): the ONE snooze/dismiss ledger
  // behind both Upcoming and every findings surface. The stack-safety warnings and
  // food-drug guidance below are routed through it, keyed by the identical dedupeKey
  // their Upcoming twin carries, so a dismiss/snooze on either surface silences the
  // other ("dismiss once, silence everywhere", #227's page↔push applied page↔page).
  // Declared here — BEFORE bucketWarnings and every other warning derivation that
  // captures it — so no closure references it in its temporal dead zone (#747).
  const suppressions = getFindingSuppressions(profile.id);
  // This profile's currently-active food-timing dismissals, threaded into each row's
  // FoodGuidance so a dismissed food note stays hidden (#435).
  const suppressedFoodKeys = [...suppressions.entries()]
    .filter(
      ([k, rec]) =>
        k.startsWith(FOOD_TIMING_PREFIX) && isSuppressed(rec, todayStr)
    )
    .map(([k]) => k);

  // Group due items by time bucket; within a bucket use the SHARED dose-day
  // comparator (priority → stack → name) so this section and the Upcoming /
  // needs-attention surfaces order a dose day identically (issue #297). The
  // buckets already partition by time-of-day, so the comparator's leading bucket
  // key is a constant within each group and the residual order is priority → …
  const doseEntry = (it: Item): DoseDayEntry => ({
    timeOfDay: it.dose.time_of_day,
    priority: it.supplement.priority,
    stack: it.supplement.stack,
    name: it.supplement.name,
  });
  const byBucketFor = (items: Item[]) => {
    const grouped = new Map<TimeBucket, Item[]>();
    for (const item of items) {
      const bucket = timeBucket(item.dose.time_of_day);
      const rows = grouped.get(bucket) ?? [];
      rows.push(item);
      grouped.set(bucket, rows);
    }
    for (const rows of grouped.values())
      rows.sort((a, b) => compareDoseDay(doseEntry(a), doseEntry(b)));
    return grouped;
  };
  const byBucket = byBucketFor(dueItems);

  // "Keep apart" warnings: a separate-pair whose both supplements have a due
  // dose in the same bucket. Policy lives in the shared separatePairWarnings
  // (issue #313); this surface just supplies the bucket's supplement ids.
  const pairs = getSupplementPairs(profile.id);
  // Filtered through the findings bus (#435): a keep-apart warning the profile has
  // dismissed (on this page or Upcoming) is held out, keyed by its keep-apart:<lo>-<hi>
  // dedupeKey. `suppressions`/`todayStr` are resolved above.
  const bucketWarnings = (items: Item[]): KeepApartWarning[] =>
    activeByKey(
      separatePairWarnings(
        items.map((it) => it.supplement.id),
        pairs
      ),
      (w) => w.key,
      suppressions,
      todayStr
    );

  // Item forms use the id-keyed vocabulary (#560): every situation row for this
  // profile, plus the built-in suggestions — the ONE shared merged option
  // set (mergedSituationOptions: vocabulary ∪ SUGGESTED_SITUATIONS, NOCASE-deduped so a
  // stored "illness" doesn't double up with the suggested "Illness"), so the dashboard
  // check-in and item-form option source can never disagree about the vocabulary
  // (#221/#1177). Each option carries its #799
  // illness-type flag (`illnessType`) and whether it's a saved row (`inVocabulary`).
  const situationRows = getSituations(profile.id);
  // The built-in "Period" derived situation (#1298) joins the option set ONLY when cycle
  // tracking is relevant (the #1042 nav bit), so a profile can key iron/magnesium to it.
  const situationChips = withPeriodOption(
    mergedSituationOptions(situationRows),
    getNavRelevance(profile.id).cycle
  );
  // The item-form situation picker reads that same merged option set (#1177), passed
  // through the SituationOptionsProvider below.
  const situationOptionNames = situationChips.map((o) => o.name);

  // One-way condition bridge (#560 part 2): an ACTIVE acute illness/injury condition
  // suggests its matching clinical situation, so a sick user doesn't flip two toggles
  // (log the condition AND activate the situation). Suggest-only — the user confirms.
  const bridgeSuggestions = suggestedSituationsFromConditions(
    getConditions(profile.id, { status: "active" }).map((c) => c.name),
    [...activeSituations]
  );

  // Pre-surgery / Post-op bridge (#1299): a scheduled surgical visit inside its lead
  // window suggests activating Pre-surgery (the producer for the #1296 pause capability),
  // and after the date passes, clearing it / activating Post-op. Suggest-only, dismissed
  // per-procedure. The chip carries the actual held-count from the #1296 links.
  const surgeryBridge = getSurgeryBridgeSuggestions(profile.id);

  const suggestions = getPendingSuggestions(profile.id);
  const adherenceFindings = activeFindings(
    buildAdherencePatternFindings(profile.id, todayStr),
    suppressions,
    todayStr
  );
  // Priority demotion suggestions (#1505 part 2) — the same coaching-tier engine the
  // dashboard rollup and the coaching tab read, filtered through the SAME suppression
  // bus, so dismissing here silences it everywhere.
  const demotionFindings = activeFindings(
    buildDemotionSuggestionFindings(profile.id, todayStr),
    suppressions,
    todayStr
  );
  const pairsFor = (suppId: number) =>
    pairs.filter((p) => p.a_id === suppId || p.b_id === suppId);

  // Refill "≈N days left" rate per item (#38): the actual taken-log rate when the
  // item has enough history, else the scheduled-dose-count estimate. Threaded to
  // each row so the badge reflects real consumption and can name its basis.
  const refillRates = getRefillRates(profile.id);
  const poolChips = getPoolChips(profile.id);

  // Stack-total UL warnings (issue #148): nutrients whose active-stack daily
  // supplemental intake exceeds the NIH Tolerable Upper Intake Level for this
  // profile's age/sex. Same computation the Upcoming finding uses; informational,
  // never prescriptive. Routed through the findings bus (#435) so a dismiss from
  // Upcoming (or here) silences it everywhere, keyed by dietaryLimitSignalKey.
  const ulWarnings = activeByKey(
    getDietaryLimitWarnings(profile.id, todayStr),
    (w) => dietaryLimitSignalKey(w.key),
    suppressions,
    todayStr
  );

  // Stack RDA-adequacy (issue #578): nutrients the active stack supplements at BELOW
  // the NIH RDA for this profile's age/sex — the inverse of the UL check, over the
  // previously-unused RDA half of dri.json. Wording is "supplements provide X% of the
  // RDA", never "deficient" (food intake is unknown). Same findings bus (#435), keyed
  // distinctly by rdaAdequacySignalKey so it can't collide with a UL dismissal.
  const rdaAdequacy = activeByKey(
    getDietaryAdequacy(profile.id, todayStr),
    (a) => rdaAdequacySignalKey(a.key),
    suppressions,
    todayStr
  );

  // Known drug-/supplement-interactions among the ACTIVE stack (issue #148's drug
  // twin, issue #144). Severity-ranked; the create/edit inline check + the
  // dismissible Upcoming finding format over the SAME detectInteractions. Routed
  // through the findings bus (#435) — the /medicine list used to render UNFILTERED,
  // so an Upcoming dismissal left its identical twin standing here; now they agree.
  const allInteractionWarnings = activeByKey(
    getInteractionWarnings(profile.id),
    (hit) => hit.dedupeKey,
    suppressions,
    todayStr
  );

  // PGx findings always target a medication, so they have no Supplements twin.
  const { interactionWarnings, pgxWarnings } = intakeWarningsForSurface(
    "supplement",
    supplements,
    allInteractionWarnings,
    []
  );
  const safetyCoverage = getSafetyScreeningCoverage(profile.id);
  // The profile's stored PGx variants, threaded to every form for the client-side
  // create/edit PGx notice (a lean projection — enough for phenotype resolution + the
  // marker match, no report prose beyond interpretation/notes the page already holds).
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
  // The item stack (name + cached RxCUI(s) + active) threaded to every form for
  // the client-side create/edit interaction notice. Cached ingredient CUIs (issue
  // #279) keep a combination product matchable against ingredient-keyed concepts.
  const stackItems: InteractionItem[] = supplements.map((s) => ({
    id: s.id,
    name: s.name,
    rxcui: s.rxcui,
    rxcuiIngredients: parseRxcuiIngredients(s.rxcui_ingredients),
    active: !!s.active,
  }));

  const renderRow = (it: Item, due: boolean, date = todayStr) => {
    const doseHistory = takenByDose.get(it.dose.id);
    const isTaken =
      date === todayStr
        ? taken.has(it.dose.id)
        : !!doseHistory?.taken.has(date);
    const isSkipped =
      date === todayStr
        ? skipped.has(it.dose.id)
        : !!doseHistory?.skipped.has(date);
    const historicalStatus =
      date === todayStr
        ? null
        : isTaken
          ? ("taken" as const)
          : isSkipped
            ? ("skipped" as const)
            : ("missed" as const);

    return (
      <EditableSupplementRow
        key={it.dose.id}
        supplement={it.supplement}
        dose={it.dose}
        doses={dosesBySupp.get(it.supplement.id) ?? []}
        allSupplements={supplements}
        stackItems={stackItems}
        pgxVariants={pgxVariants}
        pairs={pairsFor(it.supplement.id)}
        isTaken={isTaken}
        isSkipped={isSkipped}
        due={due && date === todayStr}
        strip={stripFor(it.supplement)}
        trainingRestricted={trainingRestricted}
        refillRate={refillRates.get(it.supplement.id) ?? null}
        poolChip={poolChips.get(it.supplement.id) ?? null}
        historicalStatus={historicalStatus}
        suppressedFoodKeys={suppressedFoodKeys}
      />
    );
  };

  const dayContext = trainingRestricted
    ? null
    : workoutDaySubtitleLabel(predictedWorkoutDay, isWorkoutDay);
  const scheduleBucketsFor = (date: string, dayItems: Item[]) => {
    const grouped = date === todayStr ? byBucket : byBucketFor(dayItems);
    return TIME_BUCKETS.map((bucket) => {
      const bucketItems = grouped.get(bucket) ?? [];
      // Keep-apart warnings are current safety guidance, not historical claims.
      const warnings =
        date === todayStr
          ? bucketWarnings(bucketItems)
          : ([] as KeepApartWarning[]);
      return {
        slot: bucket,
        count: bucketItems.length,
        content: (
          <section
            key={`${date}-${bucket}`}
            data-testid={`supplement-bucket-${bucket
              .toLowerCase()
              .replaceAll(" ", "-")}`}
          >
            <h3 className="mb-2 section-label">{TIME_BUCKET_LABELS[bucket]}</h3>
            {warnings.map((warning) => (
              <Notice
                key={warning.key}
                tone="amber"
                icon
                className="mb-2"
                action={
                  <DismissFindingButton
                    dedupeKey={warning.key}
                    label={`Dismiss: ${warning.text}`}
                  />
                }
              >
                {warning.text}
              </Notice>
            ))}
            {bucketItems.length > 0 && (
              <div className="space-y-3">
                {bucketItems.map((item) => renderRow(item, true, date))}
              </div>
            )}
          </section>
        ),
      };
    });
  };
  const scheduleDays = scheduleDates.map(({ date, label }) => {
    const dayItems =
      date === todayStr
        ? dueItems
        : itemsFor(
            (supplement) =>
              !isMed(supplement) &&
              !!supplement.active &&
              isDueOn(supplement, {
                isWorkoutDay: workoutDays.has(date),
                activeSituations: situationsOn(date),
              })
          ).filter((item) => existedOn(item, date));
    const takenCountForDay = dayItems.filter((item) =>
      takenByDose.get(item.dose.id)?.taken.has(date)
    ).length;
    return {
      date,
      label,
      totalCount: dayItems.length,
      takenCount: takenCountForDay,
      buckets: scheduleBucketsFor(date, dayItems),
    };
  });
  const secondarySchedule = (
    <>
      {heldItems.length > 0 && (
        <section data-testid="held-section">
          <h3 className="section-label">Held ({heldItems.length})</h3>
          <div className="mt-2 space-y-3">
            {heldItems.map((item) => (
              <div
                key={item.dose.id}
                data-testid={`held-item-${item.supplement.id}`}
              >
                <span className="badge mb-1 inline-block bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  Held — {item.supplement.pause_situation} active
                </span>
                {renderRow(item, false)}
              </div>
            ))}
          </div>
        </section>
      )}

      {notScheduled.length > 0 && (
        <details>
          <summary className="cursor-pointer section-label">
            Not scheduled today ({notScheduled.length})
          </summary>
          <div className="mt-2 space-y-3">
            {notScheduled.map((item) => renderRow(item, false))}
          </div>
        </details>
      )}

      {paused.length > 0 && (
        <details>
          <summary className="cursor-pointer section-label">
            Paused ({paused.length})
          </summary>
          <div className="mt-2 space-y-3">
            {paused.map((item) => renderRow(item, false))}
          </div>
        </details>
      )}
    </>
  );
  const suggestionPanel = (
    <>
      <SuggestionsForm />
      {suggestions.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          Generate optional ideas from recent labs or add context about how
          you&rsquo;re feeling. Suggestions appear here for review before
          anything is added to your schedule.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {[...suggestions]
            .sort(
              (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
            )
            .map((suggestion) => (
              <div
                key={suggestion.id}
                className="rounded-lg border border-black/10 p-3 dark:border-white/10"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {suggestion.name}
                  </span>
                  {suggestion.dosage && (
                    <span className="text-sm text-slate-500 dark:text-slate-400">
                      · {suggestion.dosage}
                    </span>
                  )}
                  <span
                    className={`badge ${priorityClass(suggestion.priority)}`}
                  >
                    {PRIORITY_LABELS[suggestion.priority]}
                  </span>
                  {suggestion.condition !== "daily" && (
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                      {CONDITION_LABELS[suggestion.condition]}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  {suggestion.rationale}
                </p>
                {suggestion.source_detail && (
                  <p
                    data-testid="supplement-suggestion-source"
                    className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400"
                  >
                    {suggestion.source_detail}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-3 text-xs">
                  <form
                    action={async (formData) => {
                      "use server";
                      await acceptSuggestion(formData);
                    }}
                  >
                    <input type="hidden" name="id" value={suggestion.id} />
                    <SubmitButton
                      pendingLabel="Adding…"
                      className="font-medium text-brand-700 hover:underline disabled:opacity-60 dark:text-brand-400"
                    >
                      Add to schedule
                    </SubmitButton>
                  </form>
                  <DismissSuggestionButton
                    id={suggestion.id}
                    name={suggestion.name}
                  />
                </div>
              </div>
            ))}
        </div>
      )}
    </>
  );

  return (
    <SituationOptionsProvider options={situationOptionNames}>
      <div>
        {/* The medicine-cabinet door (#1522). It lives in the TAB body, not in the
          page header's `action` slot: that slot is `hidden md:block` on TabFirstPage
          and is shared with the Food tab, so a header door would be desktop-only AND
          would advertise shared bottles from a page about breakfast. One component,
          both viewports. */}
        <div className="mb-3 flex justify-end">
          <SharedSuppliesLink count={cabinetCount} />
        </div>

        {/* Derived-context state lines (#1292 Poor sleep, #1298 Period): computed from
          the profile's own data, NOT a manual toggle — rendered distinctly and NON-
          toggleable. The poor-sleep line carries a one-tap "Not today" that suppresses
          only the DERIVED contribution for today. The same lines appear on the
          check-in disclosure + digest. */}
        {(derivedLines.poorSleep || derivedLines.period) && (
          <div
            className="-mt-2 mb-4 space-y-1"
            data-testid="derived-situations"
          >
            {derivedLines.poorSleep && (
              <div
                className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
                data-testid="derived-poor-sleep"
              >
                <span className="badge bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                  Auto
                </span>
                <span>{derivedLines.poorSleep}</span>
                {showPoorSleepOverride && (
                  <form
                    action={async () => {
                      "use server";
                      await dismissDerivedPoorSleep();
                    }}
                  >
                    <SubmitButton
                      data-testid="derived-poor-sleep-override"
                      className="badge cursor-pointer border border-slate-300 bg-transparent text-slate-500 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-ink-800"
                    >
                      Not today
                    </SubmitButton>
                  </form>
                )}
              </div>
            )}
            {derivedLines.period && (
              <div
                className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
                data-testid="derived-period"
              >
                <span className="badge bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                  Auto
                </span>
                <span>{derivedLines.period}</span>
              </div>
            )}
          </div>
        )}

        {/* Situation-activation acknowledgment (#662 item 1): a one-line confirmation
          that toggling a situation changed the shape of the due dose list, counted
          from the SAME dueness computation the list uses (never a second count). */}
        {situationActivationLine(countSituationalDue(supplements, ctx)) && (
          <p
            className="-mt-2 mb-4 text-xs text-slate-500 dark:text-slate-400"
            data-testid="situation-activation"
          >
            {situationActivationLine(countSituationalDue(supplements, ctx))}
          </p>
        )}

        {/* Condition bridge (#560 part 2): suggest a clinical situation implied by an
          active illness/injury condition, so it isn't a second manual toggle. */}
        {bridgeSuggestions.length > 0 && (
          <div
            className="mb-4 flex flex-wrap items-center gap-2"
            data-testid="situation-bridge"
          >
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Suggested from your conditions:
            </span>
            {bridgeSuggestions.map((sit) => (
              <form
                action={async (fd) => {
                  "use server";
                  await toggleSituation(fd);
                }}
                key={sit}
              >
                <input type="hidden" name="situation" value={sit} />
                <SubmitButton
                  data-testid={`situation-bridge-${sit}`}
                  className="badge cursor-pointer border border-dashed border-brand-400 bg-transparent text-brand-700 hover:bg-brand-50 disabled:opacity-60 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950"
                >
                  + {sit}
                </SubmitButton>
              </form>
            ))}
          </div>
        )}

        {/* Pre-surgery / Post-op bridge (#1299): a scheduled surgical visit inside its
          lead window suggests activating Pre-surgery — the consented producer for the
          #1296 pause. The chip carries what it will do ("Surgery scheduled … — activate
          Pre-surgery? N items will be held"). Dismissible per-procedure. */}
        {surgeryBridge.map((card) => {
          const { suggestion: sug, activateSituation, heldCount } = card;
          const dateLabel = sug.scheduledDate;
          const isPre = sug.phase === "pre";
          const copy = isPre
            ? `Surgery scheduled ${dateLabel} — activate ${activateSituation}?${
                heldCount > 0
                  ? ` ${heldCount} item${heldCount === 1 ? "" : "s"} will be held.`
                  : ""
              }`
            : `Surgery date ${dateLabel} passed — ${
                sug.presurgeryActive
                  ? `clear ${BUILTIN_PRESURGERY_SITUATION}${
                      heldCount > 0
                        ? ` (${heldCount} item${heldCount === 1 ? "" : "s"} resume)`
                        : ""
                    }? `
                  : ""
              }Activate ${activateSituation}?`;
          return (
            <div
              key={card.dismissKey}
              className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-brand-400 p-2 dark:border-brand-700"
              data-testid={`surgery-bridge-${sug.phase}-${sug.visitId}`}
            >
              <span className="text-xs text-slate-600 dark:text-slate-300">
                {copy}
              </span>
              <form
                action={async (fd) => {
                  "use server";
                  await activateSurgerySituation(fd);
                }}
              >
                <input
                  type="hidden"
                  name="situation"
                  value={activateSituation}
                />
                <SubmitButton
                  data-testid={`surgery-bridge-activate-${sug.visitId}`}
                  className="badge cursor-pointer bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  Activate {activateSituation}
                </SubmitButton>
              </form>
              {!isPre && sug.presurgeryActive && (
                <form
                  action={async (fd) => {
                    "use server";
                    await clearSurgerySituation(fd);
                  }}
                >
                  <input
                    type="hidden"
                    name="situation"
                    value={BUILTIN_PRESURGERY_SITUATION}
                  />
                  <SubmitButton
                    data-testid={`surgery-bridge-clear-${sug.visitId}`}
                    className="badge cursor-pointer border border-slate-300 bg-transparent text-slate-600 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:text-slate-300"
                  >
                    Clear {BUILTIN_PRESURGERY_SITUATION}
                  </SubmitButton>
                </form>
              )}
              <form
                action={async (fd) => {
                  "use server";
                  await dismissSurgeryBridge(fd);
                }}
              >
                <input type="hidden" name="key" value={card.dismissKey} />
                <SubmitButton
                  data-testid={`surgery-bridge-dismiss-${sug.visitId}`}
                  className="badge cursor-pointer bg-transparent text-slate-500 hover:text-slate-700 disabled:opacity-60 dark:text-slate-400"
                >
                  Dismiss
                </SubmitButton>
              </form>
            </div>
          );
        })}

        {/* Stack-total UL warnings (issue #148) */}
        {ulWarnings.length > 0 && (
          <div className="mb-4 space-y-2" data-testid="ul-warnings">
            {ulWarnings.map((w) => (
              <FindingCard
                key={w.key}
                testid={`ul-warning-${w.key}`}
                tone="amber"
                title={ulWarningTitle(w)}
                detail={ulWarningDetail(w, w.conditionCaveat)}
                evidence={`From: ${ulWarningEvidence(w)}`}
                dismissKey={dietaryLimitSignalKey(w.key)}
                dismissLabel={`Dismiss ${ulWarningTitle(w)}`}
              />
            ))}
          </div>
        )}

        {/* Stack RDA-adequacy (issue #578) — calm, informational; distinct from the
          amber UL hazard blocks (slate, not a warning). Links to food-first sources. */}
        {rdaAdequacy.length > 0 && (
          <div className="mb-4 space-y-2" data-testid="rda-adequacy">
            {rdaAdequacy.map((a) => {
              const foods = foodSourcesForDriNutrient(a.key, excludedGroups);
              return (
                <FindingCard
                  key={a.key}
                  testid={`rda-adequacy-${a.key}`}
                  tone="slate"
                  icon={false}
                  title={rdaAdequacyTitle(a)}
                  detail={rdaAdequacyDetail(a)}
                  evidence={`From: ${rdaAdequacyEvidence(a)}`}
                  dismissKey={rdaAdequacySignalKey(a.key)}
                  dismissLabel={`Dismiss ${rdaAdequacyTitle(a)}`}
                >
                  {foods.length > 0 && (
                    <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
                      Food sources: {foods.join("; ")}.
                    </p>
                  )}
                </FindingCard>
              );
            })}
          </div>
        )}

        {/* Priority demotion suggestions (#1505): high/mandatory supplements that have
          gone sustainedly untaken, offered for the `low` tag. Calm and hideable —
          accepting is the user's own priority write, never the system's. */}
        {demotionFindings.length > 0 && (
          <div className="mb-4">
            <DemotionSuggestions findings={demotionFindings} />
          </div>
        )}

        {/* Supplement-related interaction warnings. Cross-kind findings also render on
          Medications with the same dedupeKey, so dismissing either twin silences both.
          Medication-only interaction and PGx findings stay on Medications. */}
        <IntakeWarnings
          interactionWarnings={interactionWarnings}
          pgxWarnings={pgxWarnings}
          coverage={safetyCoverage}
        />
        {interactionWarnings.length === 0 && pgxWarnings.length === 0 ? (
          <IntakeSafetyScope coverage={safetyCoverage} className="mt-6" />
        ) : null}

        {supplementItems.length === 0 ? (
          <div
            data-testid="supplement-workspace"
            className="grid gap-6 lg:grid-cols-[1fr_320px]"
          >
            <EmptyState message="No supplements yet. Add one when you're ready. Medications live on their own page." />
            <aside
              data-testid="supplement-sidebar"
              className="min-w-0 self-start"
            >
              <div
                data-testid="supplement-sidebar-surface"
                className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/10 bg-white/60 shadow-sm dark:divide-white/5 dark:border-white/10 dark:bg-ink-850/70"
              >
                <section className="p-4">
                  <h2 className="mb-3 section-label">Insights</h2>
                  <SupplementInsightBadges
                    patternCount={adherenceFindings.length}
                    suggestionCount={suggestions.length}
                    patterns={
                      <AdherenceFindings findings={adherenceFindings} />
                    }
                    suggestions={suggestionPanel}
                  />
                </section>
                <section className="p-4">
                  <h2 className="mb-3 section-label">Manage</h2>
                  <AddSupplementModal
                    allSupplements={supplements}
                    stackItems={stackItems}
                    pgxVariants={pgxVariants}
                    trainingRestricted={trainingRestricted}
                  />
                </section>
              </div>
            </aside>
          </div>
        ) : (
          <div
            data-testid="supplement-workspace"
            className="grid gap-6 lg:grid-cols-[1fr_320px]"
          >
            <div className="min-w-0">
              <SupplementSchedule
                today={todayStr}
                days={scheduleDays}
                secondary={secondarySchedule}
                context={dayContext}
                action={
                  <AddSupplementModal
                    key="add-supplement"
                    allSupplements={supplements}
                    stackItems={stackItems}
                    pgxVariants={pgxVariants}
                    trainingRestricted={trainingRestricted}
                  />
                }
              />
            </div>
            <aside
              data-testid="supplement-sidebar"
              className="min-w-0 self-start"
            >
              <div
                data-testid="supplement-sidebar-surface"
                className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/10 bg-white/60 shadow-sm dark:divide-white/5 dark:border-white/10 dark:bg-ink-850/70"
              >
                <SupplementWeeklyAdherence
                  days={weeklyAdherenceDays}
                  labels={weeklyAdherenceLabels}
                />
                <section className="p-4">
                  <h2 className="mb-3 section-label">Insights</h2>
                  <SupplementInsightBadges
                    patternCount={adherenceFindings.length}
                    suggestionCount={suggestions.length}
                    patterns={
                      <AdherenceFindings findings={adherenceFindings} />
                    }
                    suggestions={suggestionPanel}
                  />
                </section>
              </div>
            </aside>
          </div>
        )}
      </div>
    </SituationOptionsProvider>
  );
}
