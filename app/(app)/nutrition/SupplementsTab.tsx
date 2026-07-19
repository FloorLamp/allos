import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getSupplementLogsInRange,
  getSupplementPairs,
  getRefillRates,
  getPendingSuggestions,
  getActivitiesByDate,
  getActivityDates,
  isPredictedWorkoutDay,
  getConditions,
  getDietaryLimitWarnings,
  getDietaryAdequacy,
  getInteractionWarnings,
  getPgxWarnings,
  getOtotoxicWarnings,
  getGenomicVariants,
  getFindingSuppressions,
} from "@/lib/queries";
import { activeByKey } from "@/lib/findings";
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
import IntakeWarnings from "@/components/IntakeWarnings";
import { today } from "@/lib/db";
import { parseRxcuiIngredients } from "@/lib/rxnorm";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { lastNDates, zonedDateParts } from "@/lib/date";
import {
  getActiveSituations,
  getSituationEvents,
  getSituations,
  getTimezone,
  getExcludedFoodGroups,
} from "@/lib/settings";
import { situationHistoryResolver } from "@/lib/trend-annotations";
import {
  suggestedSituationsFromConditions,
  situationActivationLine,
} from "@/lib/situations";
import {
  countSituationalDue,
  isDueOn,
  isPostWorkoutReady,
  timeBucket,
  TIME_BUCKETS,
  PRIORITY_ORDER,
  PRIORITY_LABELS,
  CONDITION_LABELS,
  SUGGESTED_SITUATIONS,
  priorityClass,
  workoutDaySubtitleLabel,
  type TimeBucket,
} from "@/lib/supplement-schedule";
import { compareDoseDay, type DoseDayEntry } from "@/lib/dose-order";
import type { Supplement, SupplementDose } from "@/lib/types";
import { EmptyState } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";
import EditableSupplementRow from "./EditableSupplementRow";
import DismissSuggestionButton from "./DismissSuggestionButton";
import {
  indexTakenByDose,
  supplementAdherenceStrip,
  STRIP_DAYS,
  type AdherenceDot,
} from "@/lib/supplement-adherence";
import {
  separatePairWarnings,
  type KeepApartWarning,
} from "@/lib/intake-pairs";
import SupplementForm from "@/components/SupplementForm";
import SuggestionsForm from "./SuggestionsForm";
import AdherenceFindings from "./AdherenceFindings";
import {
  addSupplement,
  toggleSituation,
  toggleSituationIllnessType,
  acceptSuggestion,
} from "./supplement-actions";

export const dynamic = "force-dynamic";

interface Item {
  supplement: Supplement;
  dose: SupplementDose;
}

// The Supplements tab of the Nutrition umbrella (#746): the former /medicine
// supplement surface — situations, stack UL/RDA + cross-kind interaction/PGx
// warnings, time-bucketed dose rows, AI suggestions, and the supplement add form.
// A self-contained async server component (it re-resolves the session like
// AdherenceFindings does) rendered by the tabbed nutrition page.
export default async function SupplementsTab() {
  const { profile } = await requireSession();
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

  const taken = getTakenDoseIds(profile.id, today(profile.id));
  const skipped = getSkippedDoseIds(profile.id, today(profile.id));
  const activeSituations = new Set(getActiveSituations(profile.id));
  // Per-day situation resolver for the adherence strip: a past day is scored against
  // the situations active THAT day (#654), reconstructed from the change-log, not the
  // current toggle applied retroactively.
  const situationsOn = situationHistoryResolver(
    activeSituations,
    getSituationEvents(profile.id)
  );
  const todaysActivities = getActivitiesByDate(profile.id, today(profile.id));
  const isWorkoutDay = todaysActivities.length > 0;
  // #558: a pre_workout supplement should surface on a PREDICTED training day
  // (from the inferred cadence), not only once a session is logged; post_workout
  // stays gated on a logged session, held until the earliest session's end time.
  const predictedWorkoutDay = isPredictedWorkoutDay(
    profile.id,
    today(profile.id)
  );
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
  // When fitness tracking is restricted for this profile the workout/rest-day
  // concept is meaningless, so we drop the subtitle prefix and the workout/
  // rest-day schedule options (see lib/age-gate.ts).
  const trainingRestricted = isTrainingRestricted(profile.id);

  // Adherence strip inputs.
  const workoutDays = new Set(getActivityDates(profile.id));
  const dates = lastNDates(today(profile.id), STRIP_DAYS);
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

  // Build dose-level items, partitioned by today's context.
  const itemsFor = (preds: (s: Supplement) => boolean): Item[] =>
    supplements
      .filter(preds)
      .flatMap((s) =>
        (dosesBySupp.get(s.id) ?? []).map((dose) => ({ supplement: s, dose }))
      );

  // Medications render in their own section; the buckets/paused
  // lists below are supplements only, so the two kinds never intermix.
  const isMed = (s: Supplement) => s.kind === "medication";
  // Supplement-kind items only — this tab's empty state keys on these, not the
  // full intake list (a profile with only medications is empty HERE, #746).
  const supplementItems = supplements.filter((s) => !isMed(s));
  const dueItems = itemsFor((s) => !isMed(s) && !!s.active && isDueOn(s, ctx));
  const notScheduled = itemsFor(
    (s) => !isMed(s) && !!s.active && !isDueOn(s, ctx)
  );
  const paused = itemsFor((s) => !isMed(s) && !s.active);

  // Medications render on their own page (#746); this tab is supplements only, so
  // the `isMed` predicate below simply excludes them from every list here.
  const todayStr = today(profile.id);

  const takenCount = dueItems.filter((it) => taken.has(it.dose.id)).length;

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
  const byBucket = new Map<TimeBucket, Item[]>();
  for (const it of dueItems) {
    const b = timeBucket(it.dose.time_of_day);
    const arr = byBucket.get(b) ?? [];
    arr.push(it);
    byBucket.set(b, arr);
  }
  const doseEntry = (it: Item): DoseDayEntry => ({
    timeOfDay: it.dose.time_of_day,
    priority: it.supplement.priority,
    stack: it.supplement.stack,
    name: it.supplement.name,
  });
  for (const arr of byBucket.values())
    arr.sort((a, b) => compareDoseDay(doseEntry(a), doseEntry(b)));

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

  // The situations bar is driven by the id-keyed vocabulary (#560): every situation
  // ROW for this profile, plus the built-in suggestions (NOCASE-deduped against the
  // vocabulary so a stored "illness" doesn't double up with the suggested "Illness").
  const situationRows = getSituations(profile.id);
  const vocabulary = situationRows.map((s) => s.name);
  // Which situations are illness-type-flagged (#799) — a symptom-log container. Keyed
  // NOCASE so a chip's label matches its row regardless of casing.
  const illnessTypeByName = new Map(
    situationRows.map((s) => [s.name.toLowerCase(), !!s.illness_type])
  );
  const situationChips = [
    ...new Map(
      [...vocabulary, ...SUGGESTED_SITUATIONS].map((n) => [n.toLowerCase(), n])
    ).values(),
  ];

  // One-way condition bridge (#560 part 2): an ACTIVE acute illness/injury condition
  // suggests its matching clinical situation, so a sick user doesn't flip two toggles
  // (log the condition AND activate the situation). Suggest-only — the user confirms.
  const bridgeSuggestions = suggestedSituationsFromConditions(
    getConditions(profile.id, { status: "active" }).map((c) => c.name),
    [...activeSituations]
  );

  const suggestions = getPendingSuggestions(profile.id);
  const pairsFor = (suppId: number) =>
    pairs.filter((p) => p.a_id === suppId || p.b_id === suppId);

  // Refill "≈N days left" rate per item (#38): the actual taken-log rate when the
  // item has enough history, else the scheduled-dose-count estimate. Threaded to
  // each row so the badge reflects real consumption and can name its basis.
  const refillRates = getRefillRates(profile.id);

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
  const interactionWarnings = activeByKey(
    getInteractionWarnings(profile.id),
    (hit) => hit.dedupeKey,
    suppressions,
    todayStr
  );

  // Pharmacogenomics cross-check (issue #710): a stored PGx result (a
  // genomic_variants row, result_type='pharmacogenomic') affecting a medication in
  // the active stack, with CPIC's guidance direction as INFORMATION. Same pure
  // crossCheckPgx the create/edit inline notice + the dismissible Upcoming finding
  // format over. Care-tier (per #449 — the safety cross-check twin of drug–drug
  // interactions), routed through the findings bus (#435) keyed by the identical
  // dedupeKey the Upcoming twin carries, so a dismiss on either surface silences the
  // other. Informational, never prescriptive; the app never auto-changes a med.
  const pgxWarnings = activeByKey(
    getPgxWarnings(profile.id),
    (hit) => hit.dedupeKey,
    suppressions,
    todayStr
  );
  // Ototoxic-medication awareness (issue #717): an active ototoxic medication → a calm,
  // cited hearing-safety note. Rendered here AND on the Medications page over the SAME
  // getOtotoxicWarnings gather + dedupeKey, so a dismiss on either silences both
  // (#435/#746). A supplement is never kind='medication', so this is normally empty on
  // the Supplements tab — but the shared component keeps the two surfaces from drifting.
  const ototoxicWarnings = activeByKey(
    getOtotoxicWarnings(profile.id),
    (hit) => hit.dedupeKey,
    suppressions,
    todayStr
  );
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

  const renderRow = (it: Item, due: boolean) => (
    <EditableSupplementRow
      key={it.dose.id}
      supplement={it.supplement}
      dose={it.dose}
      doses={dosesBySupp.get(it.supplement.id) ?? []}
      allSupplements={supplements}
      stackItems={stackItems}
      pgxVariants={pgxVariants}
      pairs={pairsFor(it.supplement.id)}
      isTaken={taken.has(it.dose.id)}
      isSkipped={skipped.has(it.dose.id)}
      due={due}
      strip={stripFor(it.supplement)}
      trainingRestricted={trainingRestricted}
      refillRate={refillRates.get(it.supplement.id) ?? null}
      suppressedFoodKeys={suppressedFoodKeys}
    />
  );

  return (
    <div>
      {/* This tab lives under the Nutrition page header, so it carries only a
          compact status line (workout-day label + taken count) rather than its
          own PageHeader. */}
      <p
        data-testid="supplements-status"
        className="mb-4 text-sm text-slate-500 dark:text-slate-400"
      >
        {trainingRestricted
          ? `${takenCount}/${dueItems.length} taken.`
          : `${workoutDaySubtitleLabel(predictedWorkoutDay, isWorkoutDay)} — ${takenCount}/${dueItems.length} taken.`}
      </p>

      {/* Situations bar */}
      <div
        className="mb-4 flex flex-wrap items-center gap-2"
        data-testid="situations-bar"
      >
        <span className="section-label">Situations</span>
        {situationChips.map((sit) => {
          const on = activeSituations.has(sit);
          // A real vocabulary row can opt into being an illness-type symptom container
          // (#799); a suggested-but-unsaved chip has no row yet, so no toggle.
          const isRow = illnessTypeByName.has(sit.toLowerCase());
          const illnessOn = illnessTypeByName.get(sit.toLowerCase()) ?? false;
          return (
            <div key={sit} className="flex items-center gap-1">
              <form
                action={async (fd) => {
                  "use server";
                  await toggleSituation(fd);
                }}
              >
                <input type="hidden" name="situation" value={sit} />
                <SubmitButton
                  aria-pressed={on}
                  className={`badge cursor-pointer disabled:opacity-60 ${
                    on
                      ? "bg-brand-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-700"
                  }`}
                >
                  {sit}
                </SubmitButton>
              </form>
              {isRow && (
                <form
                  action={async (fd) => {
                    "use server";
                    await toggleSituationIllnessType(fd);
                  }}
                >
                  <input type="hidden" name="situation" value={sit} />
                  <SubmitButton
                    aria-pressed={illnessOn}
                    title={
                      illnessOn
                        ? "Illness — symptom logging on"
                        : "Mark as illness (enables symptom logging)"
                    }
                    data-testid={`situation-illness-${sit}`}
                    className={`badge cursor-pointer px-1.5 disabled:opacity-60 ${
                      illnessOn
                        ? "bg-orange-500 text-white"
                        : "bg-transparent text-slate-400 hover:text-orange-500"
                    }`}
                  >
                    🤒
                  </SubmitButton>
                </form>
              )}
            </div>
          );
        })}
      </div>

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

      {/* Cross-kind interaction (#144) + pharmacogenomics (#710) warnings —
          rendered here AND on the Medications page over the same gathers +
          dedupeKeys, so a dismiss on either silences both (#435/#746). */}
      <IntakeWarnings
        interactionWarnings={interactionWarnings}
        pgxWarnings={pgxWarnings}
        ototoxicWarnings={ototoxicWarnings}
      />

      {/* Adherence-pattern observations (issue #45, domain 3) */}
      <div className="mb-4">
        <AdherenceFindings />
      </div>

      {supplementItems.length === 0 ? (
        <EmptyState message="No supplements yet. Add one below. Medications live on their own page." />
      ) : (
        <div className="space-y-6">
          {TIME_BUCKETS.map((bucket) => {
            const items = byBucket.get(bucket);
            if (!items || items.length === 0) return null;
            const warnings = bucketWarnings(items);
            return (
              <section key={bucket}>
                <h2 className="mb-2 section-label">{bucket}</h2>
                {warnings.map((w) => (
                  <Notice
                    key={w.key}
                    tone="amber"
                    icon
                    className="mb-2"
                    action={
                      <DismissFindingButton
                        dedupeKey={w.key}
                        label={`Dismiss: ${w.text}`}
                      />
                    }
                  >
                    {w.text}
                  </Notice>
                ))}
                <div className="space-y-3">
                  {items.map((it) => renderRow(it, true))}
                </div>
              </section>
            );
          })}

          {notScheduled.length > 0 && (
            <details>
              <summary className="cursor-pointer section-label">
                Not scheduled today ({notScheduled.length})
              </summary>
              <div className="mt-2 space-y-3">
                {notScheduled.map((it) => renderRow(it, false))}
              </div>
            </details>
          )}

          {paused.length > 0 && (
            <details>
              <summary className="cursor-pointer section-label">
                Paused ({paused.length})
              </summary>
              <div className="mt-2 space-y-3">
                {paused.map((it) => renderRow(it, false))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* AI suggestions */}
      <details className="card mb-4 mt-6" open={suggestions.length > 0}>
        <summary className="cursor-pointer font-semibold text-slate-800 dark:text-slate-100">
          AI suggestions{suggestions.length ? ` (${suggestions.length})` : ""}
        </summary>
        <SuggestionsForm />
        {suggestions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            No pending suggestions. Generate some from your recent labs or a
            note above. Requires AI to be configured (ANTHROPIC_API_KEY or
            AI_BASE_URL).
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {[...suggestions]
              .sort(
                (a, b) =>
                  PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
              )
              .map((sug) => (
                <div
                  key={sug.id}
                  className="rounded-lg border border-black/10 p-3 dark:border-white/10"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {sug.name}
                    </span>
                    {sug.dosage && (
                      <span className="text-sm text-slate-500 dark:text-slate-400">
                        · {sug.dosage}
                      </span>
                    )}
                    <span className={`badge ${priorityClass(sug.priority)}`}>
                      {PRIORITY_LABELS[sug.priority]}
                    </span>
                    {sug.condition !== "daily" && (
                      <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                        {CONDITION_LABELS[sug.condition]}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                    {sug.rationale}
                  </p>
                  {sug.source_detail && (
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {sug.source_detail}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-3 text-xs">
                    <form
                      action={async (fd) => {
                        "use server";
                        await acceptSuggestion(fd);
                      }}
                    >
                      <input type="hidden" name="id" value={sug.id} />
                      <SubmitButton
                        pendingLabel="Adding…"
                        className="font-medium text-brand-700 hover:underline disabled:opacity-60 dark:text-brand-400"
                      >
                        Add to schedule
                      </SubmitButton>
                    </form>
                    <DismissSuggestionButton id={sug.id} name={sug.name} />
                  </div>
                </div>
              ))}
          </div>
        )}
      </details>

      {/* Add supplement — always expanded, like the other "Add entry" forms
          (e.g. Body Metrics). Medications are added on the Medications page. */}
      <div className="card mt-6">
        <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
          Add supplement
        </h2>
        <SupplementForm
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
