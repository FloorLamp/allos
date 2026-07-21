"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { IconCheck, IconAlertTriangle } from "@tabler/icons-react";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { ActivityTypeIcon } from "@/components/ui";
import ActivityProvenance from "@/components/ActivityProvenance";
import NotesText from "@/components/NotesText";
import RouteMap from "@/components/RouteMap";
import MuscleAnatomy from "@/components/MuscleAnatomy";
import type { ActivityEditData } from "@/components/ActivityForm";
import type { UnitPrefs } from "@/lib/settings";
import { musclesWorked } from "@/lib/muscle-coverage";
import { SET_STATUS_TITLES } from "@/lib/journal-format";
import { activityComponentSportNames } from "@/lib/activity-icon";
import { zonePresentation } from "@/lib/training-zones";
// DisplayPart moved to lib/journal-card.ts (issue #334); re-exported here so the
// existing `./JournalCard` import path keeps working.
import type { DisplayPart } from "@/lib/journal-card";
import ActivityCardMenu, { type MergeSibling } from "./ActivityCardMenu";

export type { DisplayPart };

const INTENSITY_DOT: Record<string, string> = {
  easy: "bg-emerald-500 dark:bg-emerald-400",
  moderate: "bg-amber-500 dark:bg-amber-400",
  hard: "bg-rose-500 dark:bg-rose-400",
};

interface SummaryItem {
  value: string | null;
  intensity?: string | null;
  heartRate?: boolean;
  color?: string;
  title?: string;
}

export default function JournalCard({
  activity,
  timeText,
  durationText,
  distanceText,
  speedText,
  heartRateText,
  calorieText,
  metrics = [],
  gear = null,
  parts,
  fault,
  provenance,
  routePolyline = null,
  mergeSiblings = [],
  keeperLabel,
  units,
  onSelectExercise,
  onSelectCardio,
  onSelectSport,
  onFilterTag,
}: {
  activity: ActivityEditData;
  timeText: string | null;
  durationText: string | null;
  distanceText: string | null;
  speedText: string | null;
  heartRateText: string | null;
  calorieText: string | null;
  // Compact values for richer imported metrics (HR, elevation, power, etc.).
  metrics?: string[];
  // Session-level gear name (issue #342), e.g. a ride's bike; null when unlinked.
  gear?: string | null;
  parts: DisplayPart[];
  // Why this row can't be re-saved by the editor as-is (imports, legacy
  // data), or null. Required so a new render site can't silently drop the
  // warning this exists to show.
  fault: string | null;
  // Provenance label ("Manual" / "Strava" / …) + created/updated timestamps.
  provenance: {
    label: string;
    createdAt: string;
    updatedAt: string | null;
    editLocked: boolean;
  };
  // The activity's encoded GPS route polyline (issue #569), or null — rendered as a
  // tile-free SVG route thumbnail. Default null so a render site without route data
  // simply shows no thumbnail.
  routePolyline?: string | null;
  // Same-day siblings this activity can be manually merged with (issue #64), each
  // carrying its per-field conflicts vs this card (issue #100). Empty (the default)
  // hides the merge affordance — a lone activity has nothing to fold.
  mergeSiblings?: MergeSibling[];
  // Provenance label for THIS card's values — the keeper side of a merge conflict.
  keeperLabel: string;
  units: UnitPrefs;
  // When provided, a strength exercise name becomes a button that opens its
  // detail (progression/benchmarks/goals) in the history right column.
  onSelectExercise?: (exercise: string) => void;
  // When provided, a cardio activity name becomes a button that opens its
  // trends/records in the history right column.
  onSelectCardio?: (name: string) => void;
  // Likewise for a sport activity name → its records/trend.
  onSelectSport?: (name: string) => void;
  // When provided, the muscle label filters the feed by that muscle.
  onFilterTag?: (kind: "muscle" | "region", value: string) => void;
}) {
  const { openEdit, open, editData } = useActivityEditor();
  const [notesExpanded, setNotesExpanded] = useState(false);
  // Highlight the card whose activity is open in the docked editor, so it's
  // clear which feed row the right-column form belongs to. (On mobile the
  // editor is a full-screen overlay, so the ring is only ever seen on desktop.)
  const selected = open && editData?.id === activity.id;
  const intensityKey = activity.intensity?.toLowerCase() ?? null;
  const heartRateZone = zonePresentation(activity.heart_rate_zone);
  const summaryItems: SummaryItem[] = [
    { value: timeText },
    { value: durationText },
    {
      value: heartRateText,
      heartRate: true,
      color: heartRateZone?.color,
      title: heartRateZone?.title,
    },
    { value: distanceText },
    { value: speedText },
    { value: calorieText },
    {
      value: activity.intensity
        ? activity.intensity.replace(/^\w/, (c) => c.toUpperCase())
        : null,
      intensity: intensityKey,
    },
  ];
  const summary = summaryItems.filter(
    (item): item is SummaryItem & { value: string } => Boolean(item.value)
  );
  const notesCanExpand = (activity.notes?.length ?? 0) > 120;
  const hasSupportingDetails = metrics.length > 0 || !!gear;
  const hasRouteCompanion = hasSupportingDetails || parts.length > 0;

  // Per-session muscle figure (#789): the union of muscles this session's sets
  // worked, keyed through the ONE `musclesWorked` attribution (#221/#482) over
  // this activity's own exercise_sets — never a second grouping. Custom/untagged
  // lifts contribute nothing, so a session of only those resolves to an empty set
  // and the whole block degrades to nothing (matching coverage behavior elsewhere).
  const workedMuscles = useMemo(() => {
    const sets = activity.sets ?? [];
    if (sets.length === 0) return [];
    return [
      ...musclesWorked(
        sets.map((s) => ({ exercise: s.exercise, date: activity.date }))
      ),
    ];
  }, [activity.sets, activity.date]);
  const hasActivityVisuals = Boolean(routePolyline) || workedMuscles.length > 0;
  const hasBothActivityVisuals =
    Boolean(routePolyline) && workedMuscles.length > 0;
  return (
    <div
      id={`activity-${activity.id}`}
      className={`card scroll-mt-[calc(6rem+env(safe-area-inset-top))] transition ${
        selected ? "ring-2 ring-brand-500 dark:ring-brand-400" : ""
      }`}
    >
      <div
        data-testid="activity-card-body"
        className={
          hasActivityVisuals
            ? "grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_10rem] xl:grid-cols-[minmax(0,1fr)_6rem] 2xl:grid-cols-[minmax(0,1fr)_12rem]"
            : undefined
        }
      >
        <div className="min-w-0">
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
                {summary.length > 0 && (
                  <div
                    data-testid="activity-summary"
                    className="mt-0.5 flex flex-wrap items-center text-xs text-slate-600 dark:text-slate-300"
                  >
                    {summary.map((item, i) => (
                      <span
                        key={i}
                        data-testid={
                          item.intensity
                            ? "activity-intensity"
                            : item.heartRate
                              ? "activity-heart-rate"
                              : undefined
                        }
                        title={item.title}
                        className="inline-flex items-center whitespace-nowrap"
                      >
                        {i > 0 && (
                          <span
                            aria-hidden
                            className="mx-1.5 text-slate-500 dark:text-slate-400"
                          >
                            ·
                          </span>
                        )}
                        {item.intensity && INTENSITY_DOT[item.intensity] && (
                          <span
                            aria-hidden
                            data-testid="activity-intensity-dot"
                            className={`mr-1 h-1.5 w-1.5 rounded-full ${INTENSITY_DOT[item.intensity]}`}
                          />
                        )}
                        {item.heartRate ? (
                          <>
                            <span
                              aria-hidden
                              data-testid="activity-heart-rate-icon"
                              style={
                                item.color ? { color: item.color } : undefined
                              }
                            >
                              ♥
                            </span>
                            <span className="ml-1">
                              {item.value.replace(/^♥\s*/, "")}
                            </span>
                          </>
                        ) : (
                          item.value
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center">
              <ActivityCardMenu
                activity={activity}
                siblings={mergeSiblings}
                keeperLabel={keeperLabel}
                editLocked={provenance.editLocked}
                units={units}
              />
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
          {hasRouteCompanion && (
            <div data-testid="activity-details" className="mt-3">
              <div className="min-w-0">
                {hasSupportingDetails && (
                  <ul
                    data-testid="activity-metrics"
                    aria-label="Activity details"
                    className="flex flex-wrap text-xs tabular-nums text-slate-500 dark:text-slate-400"
                  >
                    {metrics.map((metric, i) => (
                      <li key={metric} className="whitespace-nowrap">
                        {i > 0 && (
                          <span
                            aria-hidden
                            className="mx-2 text-slate-500 dark:text-slate-400"
                          >
                            ·
                          </span>
                        )}
                        {metric}
                      </li>
                    ))}
                    {gear && (
                      <li className="whitespace-nowrap">
                        {metrics.length > 0 && (
                          <span
                            aria-hidden
                            className="mx-2 text-slate-500 dark:text-slate-400"
                          >
                            ·
                          </span>
                        )}
                        {activity.equipment_id != null ? (
                          <Link
                            href={`/equipment/${activity.equipment_id}`}
                            data-testid="activity-gear"
                            className="text-slate-500 hover:text-slate-600 hover:underline dark:text-slate-400 dark:hover:text-slate-300"
                            title={`Equipment: ${gear}`}
                          >
                            {gear}
                          </Link>
                        ) : (
                          <span data-testid="activity-gear" title="Equipment">
                            {gear}
                          </span>
                        )}
                      </li>
                    )}
                  </ul>
                )}

                {parts.length > 0 && (
                  <div
                    data-testid="activity-parts"
                    className={`${hasSupportingDetails ? "mt-3" : ""} border-t border-black/5 pt-2 dark:border-white/10`}
                  >
                    {parts.map((p, i) => {
                      if (p.kind !== "strength") {
                        const onSelect =
                          p.kind === "sport" ? onSelectSport : onSelectCardio;
                        const verb = p.kind === "sport" ? "records" : "trends";
                        return (
                          // Match strength's left-to-right reading order: activity name,
                          // then its compact description. Wrap only when space runs out.
                          <div
                            key={i}
                            data-testid="journal-cardio-row"
                            className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1"
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
                            {p.detail && (
                              <span className="min-w-0 text-left text-sm tabular-nums text-slate-600 dark:text-slate-300">
                                {p.detail}
                              </span>
                            )}
                          </div>
                        );
                      }
                      return (
                        // One compact reading order: exercise → sets → status → context.
                        // flex-wrap is only an overflow escape hatch for genuinely narrow
                        // cards; no field is deliberately pushed onto a second line.
                        <div
                          key={i}
                          data-testid="journal-strength-row"
                          className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 py-0.5"
                        >
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
                          <span
                            data-testid="exercise-set-summary"
                            className="text-sm tabular-nums text-slate-600 dark:text-slate-300"
                          >
                            {p.text}
                          </span>
                          {p.status === "met" && (
                            <span
                              role="img"
                              aria-label={SET_STATUS_TITLES.met}
                              className="text-brand-600 dark:text-brand-400"
                              title={SET_STATUS_TITLES.met}
                            >
                              <IconCheck className="h-4 w-4" stroke={2.5} />
                            </span>
                          )}
                          {p.status === "missed" && (
                            <span
                              role="img"
                              aria-label={SET_STATUS_TITLES.missed}
                              className="text-amber-500 dark:text-amber-400"
                              title={SET_STATUS_TITLES.missed}
                            >
                              <IconAlertTriangle
                                className="h-4 w-4"
                                stroke={2}
                              />
                            </span>
                          )}
                          {p.muscle &&
                            (onFilterTag ? (
                              <button
                                type="button"
                                onClick={() => onFilterTag("muscle", p.muscle!)}
                                title={`Show ${p.muscle} activities`}
                                className="text-xs text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
                              >
                                {p.muscle}
                              </button>
                            ) : (
                              <span className="text-xs text-slate-500 dark:text-slate-400">
                                {p.muscle}
                              </span>
                            ))}
                          {p.muscle && p.equipment && (
                            <span
                              aria-hidden
                              className="text-xs text-slate-500 dark:text-slate-400"
                            >
                              ·
                            </span>
                          )}
                          {p.equipment && (
                            <span className="text-xs text-slate-500 dark:text-slate-400">
                              {p.equipment}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Route and muscle diagrams share one compact visual box in the
            card's right column. On narrow screens it follows the details. */}
        {hasActivityVisuals && (
          <div
            data-testid="activity-visuals"
            className={`h-32 self-start overflow-hidden rounded-lg border border-black/10 bg-slate-50/70 p-2 sm:col-start-2 sm:row-start-1 dark:border-white/10 dark:bg-white/5 ${
              hasBothActivityVisuals ? "grid grid-cols-2 gap-2" : ""
            }`}
          >
            {routePolyline && (
              <div
                data-testid="activity-route"
                className={
                  workedMuscles.length > 0
                    ? "h-full border-r border-black/5 pr-2 dark:border-white/10"
                    : "h-full"
                }
              >
                <RouteMap
                  polyline={routePolyline}
                  width={240}
                  height={96}
                  className="block h-full w-full text-brand-600 dark:text-brand-400"
                />
              </div>
            )}

            {/* Per-session muscle figure (#789): only when the session resolves
                  to ≥1 tagged catalog lift. The SVG names its state and muscles. */}
            {workedMuscles.length > 0 && (
              <div data-testid="session-muscles" className="h-full">
                <MuscleAnatomy
                  mode="session"
                  worked={workedMuscles}
                  showCaptions={false}
                  className="block h-full w-full"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {activity.notes && (
        <div className="mt-3">
          <NotesText
            as="p"
            data-testid="activity-notes"
            notes={activity.notes}
            className={`text-sm leading-relaxed text-slate-600 dark:text-slate-300 ${
              notesCanExpand && !notesExpanded ? "line-clamp-2" : ""
            }`}
          />
          {notesCanExpand && (
            <button
              type="button"
              aria-expanded={notesExpanded}
              onClick={() => setNotesExpanded((value) => !value)}
              className="mt-0.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              {notesExpanded ? "Less" : "More"}
            </button>
          )}
        </div>
      )}

      <ActivityProvenance
        label={provenance.label}
        createdAt={provenance.createdAt}
        updatedAt={provenance.updatedAt}
        editLockId={provenance.editLocked ? activity.id : undefined}
        variant="quiet"
        className="mt-3"
      />
    </div>
  );
}
