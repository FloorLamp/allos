import Link from "next/link";
import type { NextWorkout } from "@/lib/workout-recommendation";
import {
  excludedExerciseLabel,
  excludedRegionLabel,
  temperedExerciseLabel,
} from "@/lib/injury-model";
import { RECORDS_CONDITIONS_HREF } from "@/lib/hrefs";
import Disclosure from "@/components/Disclosure";

export default function TrainingContextChips({
  context,
}: {
  context: NextWorkout;
}) {
  const injuryLabels = [
    ...context.excludedRegions.map(excludedRegionLabel),
    ...context.temperedRegions,
    ...context.excludedExercises.map(excludedExerciseLabel),
    ...context.temperedExercises.map((row) => row.exercise),
  ];
  const uniqueInjuryLabels = [...new Set(injuryLabels)];
  const limitations = [
    ...new Set([
      ...context.excludedExercises.flatMap((row) => row.limitations),
      ...context.temperedExercises.flatMap((row) => row.limitations),
    ]),
  ];
  // Live niggles (#3211 part 3) — the third and weakest tier. Their chips are SEPARATE
  // from the injury chips (which deep-link to #injuries): a niggle is deliberately not an
  // injury, has no record to link to, and must not read as one.
  const niggleLabels = [...new Set(context.niggleTempers.map((t) => t.label))];
  const hasContext =
    uniqueInjuryLabels.length > 0 ||
    niggleLabels.length > 0 ||
    context.considerations.length > 0 ||
    context.substitutionSuggested;
  if (!hasContext) return null;

  return (
    <div
      className="mt-4 border-t border-black/10 pt-3 dark:border-white/10"
      data-testid="training-context-chips"
    >
      <div className="flex flex-wrap items-center gap-2">
        {uniqueInjuryLabels.map((label) => (
          <Link
            key={`injury-${label}`}
            href="#injuries"
            className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/25"
            data-testid="training-context-chip"
          >
            {label}
          </Link>
        ))}
        {niggleLabels.map((label) => (
          <span
            key={`niggle-${label}`}
            className="rounded-full bg-amber-100/70 px-2.5 py-1 text-xs font-medium text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
            data-testid="training-niggle-chip"
          >
            {label} niggle
          </span>
        ))}
        {context.considerations.map((consideration) => (
          <Link
            key={consideration.key}
            href={RECORDS_CONDITIONS_HREF}
            className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-900 hover:bg-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:bg-sky-500/25"
            data-testid="training-condition-chip"
          >
            {consideration.conditionLabel}
          </Link>
        ))}
        <Disclosure className="text-xs">
          <summary className="fold-control list-none font-medium text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400 [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">Why?</span>
            <span className="hidden group-open:inline">Hide context</span>
          </summary>
          <div
            className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300"
            data-testid="training-context-notes"
          >
            {context.substitutionSuggested && (
              <p>
                Today&rsquo;s routine day works only injured regions — consider
                a substitution day rather than pushing through.
              </p>
            )}
            {context.excludedRegions.length > 0 && (
              <p data-testid="injury-exclusion-note">
                Avoiding{" "}
                {context.excludedRegions.map(excludedRegionLabel).join(", ")}.
              </p>
            )}
            {context.temperedRegions.length > 0 && (
              <p>
                Easing back on {context.temperedRegions.join(", ")} — lighter
                targets while you recover.
              </p>
            )}
            {context.excludedExercises.length > 0 && (
              <p data-testid="injury-exercise-exclusion-note">
                Avoiding{" "}
                {context.excludedExercises
                  .map(excludedExerciseLabel)
                  .join(", ")}
                .
              </p>
            )}
            {context.temperedExercises.map((row) => (
              <p key={row.exercise} data-testid="injury-exercise-temper-note">
                {temperedExerciseLabel(row)}.
              </p>
            ))}
            {context.niggleTempers.map((t) => (
              <p
                key={`niggle-${t.region}-${t.label}`}
                data-testid="niggle-temper-note"
              >
                {t.note}.
              </p>
            ))}
            {limitations.map((limitation) => (
              <p key={limitation} data-testid="injury-laterality-note">
                {limitation}
              </p>
            ))}
            {context.considerations.map((consideration) => (
              <p
                key={consideration.key}
                data-testid="condition-consideration-note"
              >
                {consideration.note}
              </p>
            ))}
          </div>
        </Disclosure>
      </div>
    </div>
  );
}
