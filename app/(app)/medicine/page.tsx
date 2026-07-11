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
} from "@/lib/queries";
import { ulWarningTitle, ulWarningDetail, ulWarningEvidence } from "@/lib/dri";
import {
  partitionMedications,
  type MedicationWithHistory,
} from "@/lib/medication-history";
import MedicationCard from "./MedicationCard";
import ProviderDatalist from "@/components/ProviderDatalist";
import { today } from "@/lib/db";
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
import type { Supplement, SupplementDose } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/ui";
import { IconAlertTriangle } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import EditableSupplementRow from "./EditableSupplementRow";
import DismissSuggestionButton from "./DismissSuggestionButton";
import {
  aggregateDoseDay,
  indexTakenByDose,
  type AdherenceDot,
} from "@/lib/supplement-adherence";
import SupplementForm from "./SupplementForm";
import SuggestionsForm from "./SuggestionsForm";
import { addSupplement, toggleSituation, acceptSuggestion } from "./actions";

export const dynamic = "force-dynamic";

const STRIP_DAYS = 14;

interface Item {
  supplement: Supplement;
  dose: SupplementDose;
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
  const stripBySupp = new Map<number, AdherenceDot[]>();
  for (const s of supplements) {
    const doseIds = (dosesBySupp.get(s.id) ?? []).map((d) => d.id);
    const total = doseIds.length;
    stripBySupp.set(
      s.id,
      dates.map((date) => {
        const applicable = isDueOn(s, {
          isWorkoutDay: workoutDays.has(date),
          activeSituations,
        });
        if (!applicable) return { date, state: "na" };
        const takenN = doseIds.reduce(
          (n, id) => n + (takenByDose.get(id)?.taken.has(date) ? 1 : 0),
          0
        );
        const skippedN = doseIds.reduce(
          (n, id) => n + (takenByDose.get(id)?.skipped.has(date) ? 1 : 0),
          0
        );
        return { date, state: aggregateDoseDay(total, takenN, skippedN) };
      })
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

  // Group due items by time bucket; sort by priority, then stack (clusters
  // stack members), then name.
  const byBucket = new Map<TimeBucket, Item[]>();
  for (const it of dueItems) {
    const b = timeBucket(it.dose.time_of_day);
    const arr = byBucket.get(b) ?? [];
    arr.push(it);
    byBucket.set(b, arr);
  }
  for (const arr of byBucket.values())
    arr.sort(
      (a, b) =>
        PRIORITY_ORDER[a.supplement.priority] -
          PRIORITY_ORDER[b.supplement.priority] ||
        (a.supplement.stack ?? "~").localeCompare(b.supplement.stack ?? "~") ||
        a.supplement.name.localeCompare(b.supplement.name)
    );

  // "Keep apart" warnings: a separate-pair whose both supplements have a due
  // dose in the same bucket.
  const pairs = getSupplementPairs(profile.id);
  function bucketWarnings(items: Item[]): string[] {
    const ids = new Set(items.map((it) => it.supplement.id));
    return pairs
      .filter(
        (p) => p.relation === "separate" && ids.has(p.a_id) && ids.has(p.b_id)
      )
      .map(
        (p) =>
          `Keep apart: ${p.a_name} and ${p.b_name}${p.note ? ` — ${p.note}` : ""}`
      );
  }

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

  // Stack-total UL warnings (issue #148): nutrients whose active-stack daily
  // supplemental intake exceeds the NIH Tolerable Upper Intake Level for this
  // profile's age/sex. Same computation the Upcoming finding uses; informational,
  // never prescriptive.
  const ulWarnings = getDietaryLimitWarnings(profile.id, todayStr);

  const renderRow = (it: Item, due: boolean) => (
    <EditableSupplementRow
      key={it.dose.id}
      supplement={it.supplement}
      dose={it.dose}
      doses={dosesBySupp.get(it.supplement.id) ?? []}
      allSupplements={supplements}
      pairs={pairsFor(it.supplement.id)}
      isTaken={taken.has(it.dose.id)}
      isSkipped={skipped.has(it.dose.id)}
      due={due}
      strip={stripFor(it.supplement)}
      trainingRestricted={trainingRestricted}
      refillRate={refillRates.get(it.supplement.id) ?? null}
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
            <form action={toggleSituation} key={sit}>
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
            </div>
          ))}
        </div>
      )}

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
                    pairs={pairsFor(m.med.id)}
                    takenDoseIds={taken}
                    skippedDoseIds={skipped}
                    due={medDue(m.med)}
                    courses={m.courses}
                    sideEffects={m.sideEffects}
                    todayStr={todayStr}
                    trainingRestricted={trainingRestricted}
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
                    pairs={pairsFor(m.med.id)}
                    takenDoseIds={taken}
                    skippedDoseIds={skipped}
                    due={medDue(m.med)}
                    courses={m.courses}
                    sideEffects={m.sideEffects}
                    todayStr={todayStr}
                    trainingRestricted={trainingRestricted}
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
                    key={w}
                    className="mb-2 flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
                  >
                    <IconAlertTriangle className="h-4 w-4" /> {w}
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
                    <form action={acceptSuggestion}>
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
          trainingRestricted={trainingRestricted}
        />
      </div>
    </div>
  );
}
