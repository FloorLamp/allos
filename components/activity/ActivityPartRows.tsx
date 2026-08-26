"use client";

import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";
import Link from "next/link";
import type { Route } from "next";
import type { DisplayPart } from "@/lib/training-log-card";
import type { ProgressDelta } from "@/lib/progress-delta";
import type { ActivityStrengthRecord } from "@/lib/training-activity-detail";
import type { MuscleId } from "@/lib/lifts";
import { SET_STATUS_TITLES } from "@/lib/training-log-format";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";

function strengthRecordPresentation(record: ActivityStrengthRecord): {
  label: string;
  help: string;
  standing: "all-time" | "running";
} {
  const allTime = record.e1rm === "all-time" || record.weight === "all-time";
  const facts = [
    record.e1rm === "all-time"
      ? "Still your all-time estimated 1RM record."
      : record.e1rm === "running"
        ? "Set a new estimated 1RM record at the time; a later session surpassed it."
        : null,
    record.weight === "all-time"
      ? "Still your all-time heaviest-load record."
      : record.weight === "running"
        ? "Set a new heaviest-load record at the time; a later session surpassed it."
        : null,
  ].filter((fact): fact is string => fact != null);
  return {
    label: allTime ? "All-time PR" : "PR achieved",
    help: facts.join(" "),
    standing: allTime ? "all-time" : "running",
  };
}

// One renderer for the work inside an activity. `compact` changes only spacing
// and permits a stated remainder; it does not invent another typography,
// status, context, or reading order for the weekly overview.
export default function ActivityPartRows({
  parts,
  partDeltas = [],
  partRecords = [],
  remainingParts = 0,
  density = "full",
  className = "",
  exerciseHref,
  highlightMusclesByExercise = {},
  onFilterTag,
}: {
  parts: DisplayPart[];
  partDeltas?: (ProgressDelta | null)[];
  partRecords?: (ActivityStrengthRecord | null)[];
  remainingParts?: number;
  density?: "compact" | "full";
  className?: string;
  exerciseHref?: (exercise: string) => Route;
  highlightMusclesByExercise?: Record<string, MuscleId[]>;
  onFilterTag?: (kind: "muscle" | "region", value: string) => void;
}) {
  if (parts.length === 0 && remainingParts === 0) return null;

  return (
    <div
      data-testid="activity-parts"
      className={`sm:grid sm:grid-cols-[minmax(10rem,14rem)_minmax(12rem,18rem)_minmax(0,1fr)] sm:gap-x-3 ${className}`}
    >
      {parts.map((part, index) => {
        if (part.kind !== "strength") {
          return (
            <div
              key={index}
              data-testid="training-log-cardio-row"
              className={`flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 sm:col-span-3 sm:grid sm:grid-cols-subgrid ${
                density === "compact" ? "py-0.5" : "py-1"
              }`}
            >
              <span className="text-left font-medium text-slate-800 dark:text-slate-100">
                {part.name}
              </span>
              {part.detail && (
                <span className="min-w-0 text-left text-sm tabular-nums text-slate-600 dark:text-slate-300 sm:col-span-2">
                  {part.detail}
                </span>
              )}
            </div>
          );
        }

        const delta = partDeltas[index];
        const record = partRecords[index];
        const recordPresentation = record
          ? strengthRecordPresentation(record)
          : null;
        const rowHelp = [
          delta?.title,
          recordPresentation?.help,
          part.status ? SET_STATUS_TITLES[part.status] : null,
        ]
          .filter((help): help is string => Boolean(help))
          .join(" · ");
        const href = exerciseHref?.(part.name);
        const highlightMuscles =
          highlightMusclesByExercise[part.name.trim().toLowerCase()] ?? [];
        const highlightClass =
          highlightMuscles.length > 0
            ? "-mx-2 rounded-md px-2 transition-colors data-[highlighted=true]:bg-brand-50 data-[highlighted=true]:ring-1 data-[highlighted=true]:ring-brand-300 dark:data-[highlighted=true]:bg-brand-950/30 dark:data-[highlighted=true]:ring-brand-700"
            : "";
        return (
          <div
            key={index}
            data-testid="training-log-strength-row"
            data-activity-muscles={
              highlightMuscles.length > 0
                ? highlightMuscles.join(" ")
                : undefined
            }
            className={`group/muscle flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 py-0.5 sm:col-span-3 sm:grid sm:grid-cols-subgrid ${highlightClass}`}
          >
            {href ? (
              <Link
                href={href}
                className="text-left font-medium text-slate-800 hover:text-brand-600 dark:text-slate-100 dark:hover:text-brand-400"
              >
                {part.name}
              </Link>
            ) : (
              <span className="text-left font-medium text-slate-800 dark:text-slate-100">
                {part.name}
              </span>
            )}
            <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
              <span
                data-testid="exercise-set-summary"
                className="text-sm tabular-nums text-slate-600 dark:text-slate-300"
              >
                {part.text}
              </span>
              {delta && (
                <span
                  data-testid="exercise-vs-last"
                  className={`whitespace-nowrap text-xs tabular-nums ${
                    delta.direction === "up"
                      ? "text-brand-600 dark:text-brand-400"
                      : delta.direction === "down"
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-slate-500 dark:text-slate-400"
                  }`}
                >
                  {delta.direction === "up"
                    ? "▲ "
                    : delta.direction === "down"
                      ? "▼ "
                      : ""}
                  {delta.label}
                </span>
              )}
              {record && recordPresentation ? (
                <span className="inline-flex items-center whitespace-nowrap">
                  <Link
                    href={record.href}
                    data-testid="exercise-pr"
                    data-pr-standing={recordPresentation.standing}
                    aria-label={`${recordPresentation.label} for ${part.name} — view strength progression`}
                    className="badge bg-amber-100 text-amber-800 transition hover:bg-amber-200 hover:text-amber-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900"
                  >
                    {recordPresentation.label}
                  </Link>
                </span>
              ) : null}
            </span>
            {(part.status || rowHelp || part.muscle || part.equipment) && (
              <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
                {part.status === "met" && (
                  <span className="inline-flex items-center gap-1 text-xs text-brand-600 dark:text-brand-400">
                    <IconCheck className="h-4 w-4" stroke={2.5} />
                    Target met
                  </span>
                )}
                {part.status === "missed" && (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-500 dark:text-amber-400">
                    <IconAlertTriangle className="h-4 w-4" stroke={2} />
                    Target missed
                  </span>
                )}
                {rowHelp ? (
                  <InfoTooltipIcon
                    label={rowHelp}
                    data-testid="exercise-row-info"
                  />
                ) : null}
                {(part.muscle || part.equipment) && (
                  <span className="flex min-w-0 items-center gap-x-1 overflow-hidden whitespace-nowrap">
                    {part.muscle &&
                      (onFilterTag ? (
                        <button
                          type="button"
                          onClick={() => onFilterTag("muscle", part.muscle!)}
                          className="relative z-10 shrink-0 text-xs text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
                        >
                          {part.muscle}
                        </button>
                      ) : (
                        <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                          {part.muscle}
                        </span>
                      ))}
                    {part.muscle && part.equipment && (
                      <span
                        aria-hidden
                        className="shrink-0 text-xs text-slate-500 dark:text-slate-400"
                      >
                        ·
                      </span>
                    )}
                    {part.equipment && (
                      <span className="min-w-0 truncate text-xs text-slate-500 dark:text-slate-400">
                        {part.equipment}
                      </span>
                    )}
                  </span>
                )}
              </span>
            )}
          </div>
        );
      })}
      {remainingParts > 0 && (
        <div className="pt-0.5 text-xs text-slate-500 sm:col-span-3 dark:text-slate-400">
          +{remainingParts} more
        </div>
      )}
    </div>
  );
}
