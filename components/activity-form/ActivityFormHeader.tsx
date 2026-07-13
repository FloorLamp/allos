"use client";

import ActivityIcon from "../ActivityIcon";
import ActivityProvenance from "@/components/ActivityProvenance";
import { activityProvenanceLabel } from "@/lib/journal-format";
import { formatLongDate } from "@/lib/format-date";
import { IconX } from "@tabler/icons-react";
import type { ActivityType } from "@/lib/types";
import type { ActivityEditData } from "./model";

// The activity form's header section: the type icon + live title, the date
// subtitle, the stored-row provenance line, and the close control. Presentational
// only — extracted from ActivityForm so the parent stays composition (#319).
export default function ActivityFormHeader({
  headingType,
  headingTitle,
  effectiveTitle,
  date,
  editData,
  onClose,
}: {
  headingType: ActivityType | null;
  headingTitle: string | undefined;
  effectiveTitle: string;
  date: string;
  editData: ActivityEditData | null;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-slate-100">
          {headingType && (
            <ActivityIcon
              type={headingType}
              title={headingTitle}
              className="h-6 w-6 text-brand-600 dark:text-brand-400"
            />
          )}
          {effectiveTitle}
        </h2>
        {/* Date lives in a field below, but surfacing it in the header gives
            at-a-glance context for the row being edited. Reads live `date`
            state, so it tracks edits to the field. */}
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          {formatLongDate(date)}
        </p>
        {/* Provenance + created/updated timestamps for a stored row (issue
            #11). Omitted while creating a new activity (no created_at yet). */}
        {editData?.created_at && (
          <ActivityProvenance
            label={activityProvenanceLabel(
              editData.source ?? null,
              editData.edited
            )}
            createdAt={editData.created_at}
            updatedAt={editData.updated_at ?? null}
            editLockId={
              editData.edited &&
              editData.source &&
              editData.source !== "manual" &&
              !editData.source.startsWith("document:")
                ? editData.id
                : undefined
            }
            className="mt-1"
          />
        )}
      </div>
      {/* Close control for both the centered modal and the docked editor; the
          docked form flushes any pending auto-save on unmount. */}
      {/* Negative margin keeps the icon in place while the hit area grows to
          finger size (same trick on the small controls below). */}
      <button
        type="button"
        onClick={onClose}
        className="-m-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-ink-800 dark:hover:text-slate-300"
        aria-label="Close"
      >
        <IconX className="h-5 w-5" />
      </button>
    </div>
  );
}
