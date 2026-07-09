"use client";

import { IconCheck, IconAlertTriangle } from "@tabler/icons-react";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { ActivityTypeIcon, IntensityBadge } from "@/components/ui";
import ActivityProvenance from "@/components/ActivityProvenance";
import type { ActivityEditData } from "@/components/ActivityForm";
import { SET_STATUS_TITLES, type SetStatus } from "@/lib/journal-format";
import { activityComponentSportNames } from "@/lib/activity-icon";
import ActivityCardMenu from "./ActivityCardMenu";

export type DisplayPart =
  | {
      kind: "strength";
      name: string;
      muscle: string | null;
      text: string;
      status: SetStatus;
      // User-defined implement used for this exercise (e.g. "Trap Bar"), or null.
      equipment?: string | null;
    }
  | { kind: "cardio"; name: string; detail: string }
  | { kind: "sport"; name: string; detail: string };

export default function JournalCard({
  activity,
  durationText,
  distanceText,
  speedText,
  metrics = [],
  parts,
  fault,
  provenance,
  mergeSiblings = [],
  onSelectExercise,
  onSelectCardio,
  onSelectSport,
  onFilterTag,
}: {
  activity: ActivityEditData;
  durationText: string | null;
  distanceText: string | null;
  speedText: string | null;
  // Compact chips for richer imported metrics (HR, elevation, power, etc.).
  metrics?: string[];
  parts: DisplayPart[];
  // Why this row can't be re-saved by the editor as-is (imports, legacy
  // data), or null. Required so a new render site can't silently drop the
  // warning this exists to show.
  fault: string | null;
  // Provenance chip ("Manual" / "Strava" / …) + created/updated timestamps.
  provenance: {
    label: string;
    createdAt: string;
    updatedAt: string | null;
  };
  // Same-day siblings this activity can be manually merged with (issue #64). Empty
  // (the default) hides the merge affordance — a lone activity has nothing to fold.
  mergeSiblings?: { id: number; title: string }[];
  // When provided, a strength exercise name becomes a button that opens its
  // detail (progression/benchmarks/goals) in the history right column.
  onSelectExercise?: (exercise: string) => void;
  // When provided, a cardio activity name becomes a button that opens its
  // trends/records in the history right column.
  onSelectCardio?: (name: string) => void;
  // Likewise for a sport activity name → its records/trend.
  onSelectSport?: (name: string) => void;
  // When provided, the muscle badge filters the feed by that muscle.
  onFilterTag?: (kind: "muscle" | "region", value: string) => void;
}) {
  const { openEdit, open, editData } = useActivityEditor();
  // Highlight the card whose activity is open in the docked editor, so it's
  // clear which feed row the right-column form belongs to. (On mobile the
  // editor is a full-screen overlay, so the ring is only ever seen on desktop.)
  const selected = open && editData?.id === activity.id;

  return (
    <div
      id={`activity-${activity.id}`}
      className={`card scroll-mt-[calc(6rem+env(safe-area-inset-top))] transition ${
        selected ? "ring-2 ring-brand-500 dark:ring-brand-400" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <ActivityTypeIcon
            type={activity.type}
            title={activity.title}
            sportNames={activityComponentSportNames(activity.components)}
          />
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => openEdit(activity)}
              className="text-left font-semibold text-slate-800 hover:text-brand-600 dark:text-slate-100 dark:hover:text-brand-400"
            >
              {activity.title}
            </button>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-slate-500 dark:text-slate-400">
              {durationText && <span>{durationText}</span>}
              {distanceText && <span>{distanceText}</span>}
              {speedText && <span>{speedText}</span>}
            </div>
            {metrics.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {metrics.map((m, i) => (
                  <span
                    key={i}
                    className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
                  >
                    {m}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {activity.intensity && <IntensityBadge value={activity.intensity} />}
          <ActivityCardMenu activity={activity} siblings={mergeSiblings} />
        </div>
      </div>

      {/* Rows the editor can't re-save as-is (imports, legacy data): say why,
          and make the whole line open the editor where the same blocker and
          field highlights point at the fix. Rose, to stand apart from the
          amber missed-target markers. */}
      {fault && (
        <button
          type="button"
          onClick={() => openEdit(activity)}
          title="Open to fix"
          className="mt-2 flex items-center gap-1.5 text-left text-xs font-medium text-rose-600 hover:underline dark:text-rose-400"
        >
          <IconAlertTriangle className="h-4 w-4 shrink-0" stroke={2} />
          <span>Can’t be saved as-is — {fault}</span>
        </button>
      )}

      {activity.notes && (
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {activity.notes}
        </p>
      )}

      {parts.length > 0 && (
        <div className="mt-3 border-t border-black/5 pt-2 dark:border-white/10">
          {parts.map((p, i) => {
            if (p.kind !== "strength") {
              const onSelect =
                p.kind === "sport" ? onSelectSport : onSelectCardio;
              const verb = p.kind === "sport" ? "records" : "trends";
              return (
                // Baseline-aligned so a wrapped name or detail still reads as
                // one row; the detail right-aligns its wrapped lines.
                <div
                  key={i}
                  className="flex items-baseline justify-between gap-3 py-1"
                >
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={() => onSelect(p.name)}
                      className="text-left font-medium text-slate-800 hover:text-brand-600 dark:text-slate-100 dark:hover:text-brand-400"
                      title={`See ${p.name} ${verb}`}
                    >
                      {p.name}
                    </button>
                  ) : (
                    <span className="text-left font-medium text-slate-800 dark:text-slate-100">
                      {p.name}
                    </span>
                  )}
                  <span className="min-w-0 text-right text-sm tabular-nums text-slate-600 dark:text-slate-300">
                    {p.detail}
                  </span>
                </div>
              );
            }
            return (
              // items-start (not center) so the muscle badge hugs the first
              // line when the left side wraps on narrow screens; the left
              // group wraps as whole units — the name stays in one piece and
              // the sets text flows onto the next line, left-aligned.
              <div
                key={i}
                className="flex items-start justify-between gap-3 py-1"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  {onSelectExercise ? (
                    <button
                      type="button"
                      onClick={() => onSelectExercise(p.name)}
                      className="text-left font-medium text-slate-800 hover:text-brand-600 dark:text-slate-100 dark:hover:text-brand-400"
                      title={`See ${p.name} progression`}
                    >
                      {p.name}
                    </button>
                  ) : (
                    <span className="text-left font-medium text-slate-800 dark:text-slate-100">
                      {p.name}
                    </span>
                  )}
                  <span className="text-sm tabular-nums text-slate-600 dark:text-slate-300">
                    {p.text}
                  </span>
                  {p.equipment && (
                    <span
                      className="badge shrink-0 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                      title="Equipment used"
                    >
                      {p.equipment}
                    </span>
                  )}
                  {p.status === "met" && (
                    <span
                      className="text-brand-600 dark:text-brand-400"
                      title={SET_STATUS_TITLES.met}
                    >
                      <IconCheck className="h-4 w-4" stroke={2.5} />
                    </span>
                  )}
                  {p.status === "missed" && (
                    <span
                      className="text-amber-500 dark:text-amber-400"
                      title={SET_STATUS_TITLES.missed}
                    >
                      <IconAlertTriangle className="h-4 w-4" stroke={2} />
                    </span>
                  )}
                </div>
                {p.muscle &&
                  (onFilterTag ? (
                    <button
                      type="button"
                      onClick={() => onFilterTag("muscle", p.muscle!)}
                      title={`Show ${p.muscle} activities`}
                      className="badge mt-0.5 shrink-0 cursor-pointer bg-brand-50 text-brand-700 transition hover:ring-1 hover:ring-current dark:bg-brand-950 dark:text-brand-300"
                    >
                      {p.muscle}
                    </button>
                  ) : (
                    <span className="badge mt-0.5 shrink-0 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                      {p.muscle}
                    </span>
                  ))}
              </div>
            );
          })}
        </div>
      )}

      <ActivityProvenance
        label={provenance.label}
        createdAt={provenance.createdAt}
        updatedAt={provenance.updatedAt}
        className="mt-3"
      />
    </div>
  );
}
