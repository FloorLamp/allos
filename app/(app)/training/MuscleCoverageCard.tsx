import Link from "next/link";
import MuscleAnatomy from "@/components/MuscleAnatomy";
import {
  SECONDARY_CREDIT,
  type CoverageListRow,
  type MuscleCoverageContribution,
} from "@/lib/muscle-coverage";
import { bandPresentation, bandVerdict } from "@/lib/muscle-volume-bands";
import type { MuscleId } from "@/lib/lifts";
import { trainingActivityPageHref } from "@/lib/hrefs";

function fmtSets(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export default function MuscleCoverageCard({
  coverage,
  contributions,
  days,
  belowTargetCount,
}: {
  coverage: CoverageListRow[];
  contributions: Map<MuscleId, MuscleCoverageContribution[]>;
  days: number;
  belowTargetCount: number;
}) {
  const muscleHrefs = Object.fromEntries(
    coverage.map((row) => [row.muscle, `#coverage-${row.muscle}`])
  );
  return (
    <div className="card" id="muscle-coverage" data-testid="muscle-coverage">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Muscle coverage
        </h3>
        {belowTargetCount > 0 && (
          <span
            className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"
            data-testid="muscle-coverage-below-target"
          >
            {belowTargetCount} muscle group{belowTargetCount === 1 ? "" : "s"}{" "}
            under weekly target
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        Working sets over the last {days} days; warm-ups are excluded. Primary
        movers count 1 and assisting muscles count {SECONDARY_CREDIT}.
      </p>
      {coverage.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          No strength sets logged in the last {days} days.
        </p>
      ) : (
        <>
          <MuscleAnatomy
            mode="coverage"
            coverage={coverage.map((row) => ({
              muscle: row.muscle,
              sets: row.sets,
              color: bandPresentation(bandVerdict(row.muscle, row.sets)).color,
            }))}
            muscleHrefs={muscleHrefs}
            className="mx-auto mt-5 w-full max-w-sm"
          />
          <ul className="mt-5 grid gap-2 sm:grid-cols-2">
            {coverage.map((row) => {
              const presentation = bandPresentation(
                bandVerdict(row.muscle, row.sets)
              );
              const evidence = contributions.get(row.muscle) ?? [];
              return (
                <li key={row.muscle} id={`coverage-${row.muscle}`}>
                  <details
                    className="group rounded-lg border border-black/5 bg-slate-50/50 p-2.5 dark:border-white/10 dark:bg-white/3"
                    data-testid="muscle-coverage-row"
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: presentation.color }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 font-medium text-slate-700 dark:text-slate-200">
                        {row.label}
                      </span>
                      <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                        {fmtSets(row.sets)}
                      </span>
                      <span className="text-xs font-medium text-brand-600 group-open:hidden dark:text-brand-400">
                        What counts?
                      </span>
                      <span className="hidden text-xs text-slate-400 group-open:inline">
                        Hide
                      </span>
                    </summary>
                    <ul className="mt-2 space-y-1.5 border-t border-black/5 pt-2 dark:border-white/10">
                      {evidence.map((entry, index) => (
                        <li
                          key={`${entry.activityId}-${entry.exercise}-${entry.date}-${index}`}
                          className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500 dark:text-slate-400"
                          data-testid="muscle-coverage-contribution"
                        >
                          <Link
                            href={`/training?tab=analyze&kind=strength&item=${encodeURIComponent(entry.exercise)}`}
                            className="font-medium text-brand-700 hover:underline dark:text-brand-400"
                          >
                            {entry.exercise}
                          </Link>
                          <span>{entry.credit} credit</span>
                          {entry.activityId != null ? (
                            <Link
                              href={trainingActivityPageHref(entry.activityId)}
                              className="ml-auto hover:underline"
                            >
                              {entry.date}
                            </Link>
                          ) : (
                            <span className="ml-auto">{entry.date}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
