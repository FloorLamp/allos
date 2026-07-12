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
  getProviderNames,
  getMedicationCourses,
  getMedicationSideEffects,
  getDietaryLimitWarnings,
  getInteractionWarnings,
  getFindingSuppressions,
} from "@/lib/queries";
import { activeByKey } from "@/lib/findings";
import { isSuppressed } from "@/lib/upcoming-suppress";
import {
  ulWarningTitle,
  ulWarningDetail,
  ulWarningEvidence,
  dietaryLimitSignalKey,
} from "@/lib/dri";
import { FOOD_TIMING_PREFIX } from "@/lib/food-drug-interactions";
import {
  interactionTitle,
  SEVERITY_LABEL,
  type InteractionItem,
} from "@/lib/drug-interactions";
import {
  partitionMedications,
  type MedicationWithHistory,
} from "@/lib/medication-history";
import MedicationCard from "./MedicationCard";
import ProviderDatalist from "@/components/ProviderDatalist";
import { today } from "@/lib/db";
import { parseRxcuiIngredients } from "@/lib/rxnorm";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { lastNDates } from "@/lib/date";
import { getActiveSituations } from "@/lib/settings";
import {
  isDueOn,
  timeBucket,
  TIME_BUCKETS,
  PRIORITY_ORDER,
  PRIORITY_LABELS,
  CONDITION_LABELS,
  SUGGESTED_SITUATIONS,
  priorityClass,
  type TimeBucket,
} from "@/lib/supplement-schedule";
import { compareDoseDay, type DoseDayEntry } from "@/lib/dose-order";
import type { Supplement, SupplementDose } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/ui";
import { IconAlertTriangle, IconX } from "@tabler/icons-react";
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
import SupplementForm from "./SupplementForm";
import SuggestionsForm from "./SuggestionsForm";
import AdherenceFindings from "./AdherenceFindings";
import {
  addSupplement,
  toggleSituation,
  acceptSuggestion,
  dismissMedicineFinding,
} from "./actions";

export const dynamic = "force-dynamic";

interface Item {
  supplement: Supplement;
  dose: SupplementDose;
}

// Inline dismiss control for the page's stack-safety / keep-apart observation cards
// (#435): posts the finding's dedupeKey to the namespace-guarded dismissMedicineFinding
// action, which hides it through the shared findings-suppression bus. Kept as one
// helper so the three warning blocks dismiss identically.
function DismissFindingButton({
  dedupeKey,
  label,
}: {
  dedupeKey: string;
  label: string;
}) {
  return (
    <form
      action={async (fd) => {
        "use server";
        await dismissMedicineFinding(fd);
      }}
    >
      <input type="hidden" name="dedupe_key" value={dedupeKey} />
      <button
        type="submit"
        data-testid="medicine-finding-dismiss"
        aria-label={label}
        title="Dismiss"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-black/5 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-300"
      >
        <IconX className="h-4 w-4" stroke={2} />
      </button>
    </form>
  );
}

export default async function SupplementsPage() {
  const { profile } = await requireSession();
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
  const isWorkoutDay =
    getActivitiesByDate(profile.id, today(profile.id)).length > 0;
  const ctx = { isWorkoutDay, activeSituations };
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
        activeSituations,
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
  const dueItems = itemsFor((s) => !isMed(s) && !!s.active && isDueOn(s, ctx));
  const notScheduled = itemsFor(
    (s) => !isMed(s) && !!s.active && !isDueOn(s, ctx)
  );
  const paused = itemsFor((s) => !isMed(s) && !s.active);

  // Medications render one card per medication (not per dose), carrying
  // their course history + side effects. Group the profile's courses/side effects
  // by medication, then partition into Current (an open course) vs Past
  // (discontinued). A med is "loggable today" (check-offs shown) when it's active
  // and either PRN or due under today's context.
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
  const todayStr = today(profile.id);

  const takenCount = dueItems.filter((it) => taken.has(it.dose.id)).length;

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

  const situationChips = [
    ...new Set([
      ...supplements
        .filter((s) => s.condition === "situational" && s.situation)
        .map((s) => s.situation as string),
      ...SUGGESTED_SITUATIONS,
    ]),
  ];

  const suggestions = getPendingSuggestions(profile.id);
  const pairsFor = (suppId: number) =>
    pairs.filter((p) => p.a_id === suppId || p.b_id === suppId);

  // Refill "≈N days left" rate per item (#38): the actual taken-log rate when the
  // item has enough history, else the scheduled-dose-count estimate. Threaded to
  // each row so the badge reflects real consumption and can name its basis.
  const refillRates = getRefillRates(profile.id);

  // Shared findings-suppression store (#227/#435): the ONE snooze/dismiss ledger
  // behind both Upcoming and every findings surface. The stack-safety warnings and
  // food-drug guidance below are routed through it, keyed by the identical dedupeKey
  // their Upcoming twin carries, so a dismiss/snooze on either surface silences the
  // other ("dismiss once, silence everywhere", #227's page↔push applied page↔page).
  const suppressions = getFindingSuppressions(profile.id);
  // This profile's currently-active food-timing dismissals, threaded into each row's
  // FoodGuidance so a dismissed food note stays hidden (#435).
  const suppressedFoodKeys = [...suppressions.entries()]
    .filter(
      ([k, rec]) =>
        k.startsWith(FOOD_TIMING_PREFIX) && isSuppressed(rec, todayStr)
    )
    .map(([k]) => k);

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
      {/* Provider picker options for the medication add/edit forms. */}
      <ProviderDatalist names={getProviderNames()} />
      <PageHeader
        title="Supplements & Medications"
        subtitle={
          trainingRestricted
            ? `${takenCount}/${dueItems.length} taken.`
            : `${isWorkoutDay ? "Workout day" : "Rest day"} — ${takenCount}/${dueItems.length} taken.`
        }
      />

      {/* Situations bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Situations
        </span>
        {situationChips.map((sit) => {
          const on = activeSituations.has(sit);
          return (
            <form
              action={async (fd) => {
                "use server";
                await toggleSituation(fd);
              }}
              key={sit}
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
          );
        })}
      </div>

      {/* Stack-total UL warnings (issue #148) */}
      {ulWarnings.length > 0 && (
        <div className="mb-4 space-y-2" data-testid="ul-warnings">
          {ulWarnings.map((w) => (
            <div
              key={w.key}
              data-testid={`ul-warning-${w.key}`}
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-1.5">
                  <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-semibold">{ulWarningTitle(w)}</p>
                    <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                      {ulWarningDetail(w)}
                    </p>
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      From: {ulWarningEvidence(w)}
                    </p>
                  </div>
                </div>
                <DismissFindingButton
                  dedupeKey={dietaryLimitSignalKey(w.key)}
                  label={`Dismiss ${ulWarningTitle(w)}`}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Drug-/supplement-interaction warnings (issue #144) */}
      {interactionWarnings.length > 0 && (
        <div className="mb-4 space-y-2" data-testid="interaction-warnings">
          {interactionWarnings.map((hit) => (
            <div
              key={hit.dedupeKey}
              data-testid={`interaction-warning-${hit.dedupeKey}`}
              className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2.5 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-1.5">
                  <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-semibold">
                      <span className="uppercase">
                        {SEVERITY_LABEL[hit.severity]}
                      </span>{" "}
                      · {interactionTitle(hit)}
                    </p>
                    <p className="mt-0.5 text-rose-700 dark:text-rose-300">
                      {hit.mechanism}
                    </p>
                    <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                      Informational, not medical advice — discuss with your
                      prescriber or pharmacist. Source: {hit.source}
                    </p>
                  </div>
                </div>
                <DismissFindingButton
                  dedupeKey={hit.dedupeKey}
                  label={`Dismiss ${interactionTitle(hit)} interaction`}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Adherence-pattern observations (issue #45, domain 3) */}
      <div className="mb-4">
        <AdherenceFindings />
      </div>

      {supplements.length === 0 ? (
        <EmptyState message="Nothing here yet. Add a supplement or medication below." />
      ) : (
        <div className="space-y-6">
          {currentMeds.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-400">
                Medications — Current
              </h2>
              <div className="space-y-3">
                {currentMeds.map((m) => (
                  <MedicationCard
                    key={m.med.id}
                    supplement={m.med}
                    doses={dosesBySupp.get(m.med.id) ?? []}
                    allSupplements={supplements}
                    stackItems={stackItems}
                    pairs={pairsFor(m.med.id)}
                    takenDoseIds={taken}
                    skippedDoseIds={skipped}
                    due={medDue(m.med)}
                    courses={m.courses}
                    sideEffects={m.sideEffects}
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
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Medications — Past / discontinued ({pastMeds.length})
              </summary>
              <div className="mt-2 space-y-3">
                {pastMeds.map((m) => (
                  <MedicationCard
                    key={m.med.id}
                    supplement={m.med}
                    doses={dosesBySupp.get(m.med.id) ?? []}
                    allSupplements={supplements}
                    stackItems={stackItems}
                    pairs={pairsFor(m.med.id)}
                    takenDoseIds={taken}
                    skippedDoseIds={skipped}
                    due={medDue(m.med)}
                    courses={m.courses}
                    sideEffects={m.sideEffects}
                    todayStr={todayStr}
                    trainingRestricted={trainingRestricted}
                    suppressedFoodKeys={suppressedFoodKeys}
                  />
                ))}
              </div>
            </details>
          )}

          {TIME_BUCKETS.map((bucket) => {
            const items = byBucket.get(bucket);
            if (!items || items.length === 0) return null;
            const warnings = bucketWarnings(items);
            return (
              <section key={bucket}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {bucket}
                </h2>
                {warnings.map((w) => (
                  <div
                    key={w.key}
                    className="mb-2 flex items-center justify-between gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
                  >
                    <span className="flex items-center gap-1.5">
                      <IconAlertTriangle className="h-4 w-4 shrink-0" />{" "}
                      {w.text}
                    </span>
                    <DismissFindingButton
                      dedupeKey={w.key}
                      label={`Dismiss: ${w.text}`}
                    />
                  </div>
                ))}
                <div className="space-y-3">
                  {items.map((it) => renderRow(it, true))}
                </div>
              </section>
            );
          })}

          {notScheduled.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Not scheduled today ({notScheduled.length})
              </summary>
              <div className="mt-2 space-y-3">
                {notScheduled.map((it) => renderRow(it, false))}
              </div>
            </details>
          )}

          {paused.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
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
          <p className="mt-3 text-sm text-slate-400 dark:text-slate-500">
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
                      <span className="text-sm text-slate-400 dark:text-slate-500">
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
                    <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
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

      {/* Add supplement or medication — always expanded, like the other
          "Add entry" forms (e.g. Body Metrics). */}
      <div className="card mt-6">
        <h2 className="mb-4 font-semibold text-slate-800 dark:text-slate-100">
          Add supplement or medication
        </h2>
        <SupplementForm
          action={addSupplement}
          allSupplements={supplements}
          stackItems={stackItems}
          trainingRestricted={trainingRestricted}
        />
      </div>
    </div>
  );
}
