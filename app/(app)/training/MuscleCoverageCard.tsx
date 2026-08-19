import Link from "next/link";
import { IconChevronDown } from "@tabler/icons-react";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import MuscleAnatomy from "@/components/MuscleAnatomy";
import {
  SECONDARY_CREDIT,
  type CoverageListRow,
  type MuscleCoverageContribution,
} from "@/lib/muscle-coverage";
import { bandPresentation, bandVerdict } from "@/lib/muscle-volume-bands";
import type { MuscleId } from "@/lib/lifts";
import { trainingActivityPageHref } from "@/lib/hrefs";
import MuscleCoverageDisclosure from "./MuscleCoverageDisclosure";

function fmtSets(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

type MuscleCoverageCardProps = {
  coverage: CoverageListRow[];
  contributions: Map<MuscleId, MuscleCoverageContribution[]>;
  drillInsVisible?: boolean;
} & (
  | {
      scope?: "window";
      days: number;
      belowTargetCount: number;
    }
  | {
      scope: "activity";
    }
);

export default function MuscleCoverageCard(props: MuscleCoverageCardProps) {
  const { coverage, contributions, drillInsVisible = true } = props;
  const activityScoped = props.scope === "activity";
  const helperText = activityScoped
    ? `Working sets from this workout. Primary muscles get 1 set of credit; assisting muscles get ${SECONDARY_CREDIT}.`
    : `Working sets from the past ${props.days} days. Primary muscles get 1 set of credit; assisting muscles get ${SECONDARY_CREDIT}.`;
  const muscleTargets = Object.fromEntries(
    coverage.map((row) => [row.muscle, `coverage-${row.muscle}`])
  );
  return (
    <div
      className="card"
      id={activityScoped ? "activity-muscle-coverage" : "muscle-coverage"}
      data-testid={
        activityScoped ? "activity-muscle-coverage" : "muscle-coverage"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1.5">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            {activityScoped ? "Muscles worked" : "Muscle coverage"}
          </h3>
          <InfoTooltipIcon
            label={helperText}
            data-testid="muscle-coverage-info"
          />
        </div>
        {!activityScoped && props.belowTargetCount > 0 && (
          <span
            className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"
            data-testid="muscle-coverage-below-target"
          >
            {props.belowTargetCount} muscle group
            {props.belowTargetCount === 1 ? "" : "s"} under weekly target
          </span>
        )}
      </div>
      {coverage.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          {activityScoped
            ? "No tagged strength sets in this workout."
            : `No strength sets logged in the last ${props.days} days.`}
        </p>
      ) : (
        <MuscleCoverageDisclosure>
          <MuscleAnatomy
            mode="coverage"
            ariaLabel={
              activityScoped
                ? "Muscle diagram (front and back): muscles worked in this workout"
                : undefined
            }
            coverage={coverage.map((row) => ({
              muscle: row.muscle,
              sets: row.sets,
              color: activityScoped
                ? undefined
                : bandPresentation(bandVerdict(row.muscle, row.sets)).color,
            }))}
            muscleTargets={muscleTargets}
            className="mx-auto mt-5 w-full max-w-sm"
          />
          <ul className="mt-5 grid gap-2 sm:grid-cols-2">
            {coverage.map((row) => {
              const presentation = activityScoped
                ? null
                : bandPresentation(bandVerdict(row.muscle, row.sets));
              const evidence = contributions.get(row.muscle) ?? [];
              return (
                <li key={row.muscle} id={`coverage-${row.muscle}`}>
                  <details
                    data-coverage-row-target={`coverage-${row.muscle}`}
                    className="group rounded-lg border border-black/5 bg-slate-50/50 p-2.5 transition-colors data-[highlighted=true]:border-brand-400 data-[highlighted=true]:bg-brand-50/70 dark:border-white/10 dark:bg-white/3 dark:data-[highlighted=true]:border-brand-500 dark:data-[highlighted=true]:bg-brand-950/20"
                    data-testid="muscle-coverage-row"
                  >
                    <summary
                      aria-label={`Show or hide what counts for ${row.label}`}
                      className="flex cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden"
                    >
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                          activityScoped ? "bg-emerald-500" : ""
                        }`}
                        style={
                          presentation
                            ? { backgroundColor: presentation.color }
                            : undefined
                        }
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 font-medium text-slate-700 dark:text-slate-200">
                        {row.label}
                      </span>
                      {presentation && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${presentation.badgeClass}`}
                          data-testid="muscle-coverage-verdict"
                          data-verdict={presentation.verdict}
                        >
                          {presentation.label}
                        </span>
                      )}
                      <span
                        className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400"
                        data-testid="muscle-coverage-count"
                      >
                        {fmtSets(row.sets)} {row.sets === 1 ? "set" : "sets"}
                      </span>
                      <span className="shrink-0 text-slate-400 group-open:[&_svg]:rotate-180 dark:text-slate-500">
                        <IconChevronDown
                          className="h-4 w-4 transition-transform"
                          aria-hidden
                        />
                      </span>
                    </summary>
                    <ul className="mt-2 space-y-1.5 border-t border-black/5 pt-2 dark:border-white/10">
                      {evidence.map((entry) => (
                        <li
                          key={`${entry.activityId}-${entry.exercise}-${entry.date}-${entry.role}-${entry.credit}`}
                          className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500 dark:text-slate-400"
                          data-testid="muscle-coverage-contribution"
                        >
                          {drillInsVisible ? (
                            <Link
                              href={`/training?tab=analyze&kind=strength&item=${encodeURIComponent(entry.exercise)}`}
                              className="font-medium text-brand-700 hover:underline dark:text-brand-400"
                            >
                              {entry.exercise}
                            </Link>
                          ) : (
                            <span className="font-medium text-slate-700 dark:text-slate-200">
                              {entry.exercise}
                            </span>
                          )}
                          <span>
                            {entry.role === "primary" ? "Primary" : "Assisting"}
                            {` · ${fmtSets(entry.credit)} credit × ${entry.count}`}
                          </span>
                          {!activityScoped && entry.activityId != null ? (
                            <Link
                              href={trainingActivityPageHref(entry.activityId)}
                              className="ml-auto hover:underline"
                            >
                              {entry.date}
                            </Link>
                          ) : !activityScoped ? (
                            <span className="ml-auto">{entry.date}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        </MuscleCoverageDisclosure>
      )}
    </div>
  );
}
