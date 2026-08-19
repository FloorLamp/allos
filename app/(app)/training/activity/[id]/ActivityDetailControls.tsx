"use client";

import { createContext, useContext, useState } from "react";
import Link from "next/link";
import {
  IconArrowsShuffle,
  IconBolt,
  IconChevronRight,
  IconPencil,
} from "@tabler/icons-react";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import type { ActivityEditData } from "@/lib/activity-form-model";
import type { UnitPrefs } from "@/lib/settings";
import { trainingActivityPageHref } from "@/lib/hrefs";
import ActivityCardMenu, { type MergeSibling } from "../../ActivityCardMenu";

const MergeSignalContext = createContext<{
  signal: number;
  openMerge: () => void;
} | null>(null);

export function ActivityDetailControlsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [signal, setSignal] = useState(0);
  return (
    <MergeSignalContext.Provider
      value={{ signal, openMerge: () => setSignal((value) => value + 1) }}
    >
      {children}
    </MergeSignalContext.Provider>
  );
}

function useMergeSignal() {
  const value = useContext(MergeSignalContext);
  if (!value) {
    throw new Error(
      "Activity detail controls must be inside ActivityDetailControlsProvider"
    );
  }
  return value;
}

export function ActivityInProgressBanner() {
  const { openLive, workoutOffer } = useActivityEditor();
  return (
    <button
      type="button"
      onClick={openLive}
      data-testid="session-in-progress"
      data-workout-offer={workoutOffer.kind}
      className="mb-4 flex w-full items-center gap-3 rounded-lg bg-emerald-50 px-3 py-2 text-left text-sm text-emerald-800 transition hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900"
    >
      <IconBolt className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">Workout in progress</span>
      <span className="inline-flex shrink-0 items-center gap-1 font-medium">
        Resume
        <IconChevronRight className="h-4 w-4" aria-hidden />
      </span>
    </button>
  );
}

export function ActivityDetailActions({
  activity,
  mergeCandidates,
  keeperLabel,
  foldValues,
  editLocked,
  units,
  canWrite,
  trainingRelevant,
}: {
  activity: ActivityEditData;
  mergeCandidates: MergeSibling[];
  keeperLabel: string;
  foldValues: Record<string, unknown>;
  editLocked: boolean;
  units: UnitPrefs;
  canWrite: boolean;
  trainingRelevant: boolean;
}) {
  const { openEdit } = useActivityEditor();
  const { signal } = useMergeSignal();

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {canWrite ? (
        <button
          type="button"
          data-testid="activity-page-edit"
          className="btn btn-sm inline-flex items-center gap-1.5"
          onClick={() => openEdit(activity)}
        >
          <IconPencil className="h-4 w-4" aria-hidden />
          Edit
        </button>
      ) : null}
      <ActivityCardMenu
        activity={activity}
        siblings={mergeCandidates}
        keeperLabel={keeperLabel}
        foldValues={foldValues}
        editLocked={editLocked}
        units={units}
        detailHref={
          null
        } /* detail-none: this menu already lives on the activity's canonical detail page. */
        canWrite={canWrite}
        openMergeSignal={signal}
        deleteReturnHref={trainingRelevant ? "/training?tab=log" : "/timeline"}
        mergeAwayHref={(keeperId) =>
          trainingActivityPageHref(
            keeperId,
            activity.subjectProfileId ?? undefined
          )
        }
      />
    </div>
  );
}

export function ActivityOverlapBanner({
  overlapping,
  canWrite,
  subjectProfileId,
}: {
  overlapping: MergeSibling[];
  canWrite: boolean;
  subjectProfileId?: number;
}) {
  const { openMerge } = useMergeSignal();
  if (!canWrite || overlapping.length === 0) return null;

  return (
    <div
      data-testid="activity-overlap-banner"
      className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <p>
        {overlapping.length === 1 ? (
          <>
            <span className="font-medium">{overlapping[0].sourceLabel}</span>{" "}
            also logged{" "}
            <span className="font-medium">{overlapping[0].title}</span> over the
            same clock time. The same session twice?
          </>
        ) : (
          <>
            {overlapping.length} other sessions cover the same clock time. One
            session logged more than once?
          </>
        )}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        {overlapping.map((sibling) => (
          <Link
            key={sibling.id}
            href={trainingActivityPageHref(sibling.id, subjectProfileId)}
            data-testid={`activity-overlap-compare-${sibling.id}`}
            className="font-medium underline underline-offset-2"
          >
            Compare {sibling.title}
          </Link>
        ))}
        <button
          type="button"
          data-testid="activity-overlap-merge"
          onClick={openMerge}
          className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
        >
          <IconArrowsShuffle className="h-4 w-4" aria-hidden /> Merge…
        </button>
      </div>
    </div>
  );
}
