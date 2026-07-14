"use client";

import ActivityIcon from "../ActivityIcon";
import ActivityProvenance from "@/components/ActivityProvenance";
import { activityProvenanceLabel } from "@/lib/journal-format";
import { formatLongDate } from "@/lib/format-date";
import { IconX } from "@tabler/icons-react";
import type { ActivityType } from "@/lib/types";
import type { ActivityEditData } from "./model";
import SaveStatus from "@/components/SaveStatus";

// The activity form's header section: the type icon + live title, the date
// subtitle, the stored-row provenance line, and the close control. Presentational
// only — extracted from ActivityForm so the parent stays composition (#319).
export default function ActivityFormHeader({
  headingType,
  headingTitle,
  effectiveTitle,
  title,
  date,
  editData,
  pending,
  savedAt,
  saveError,
  blocker,
  overlay,
  onTitleChange,
  onClose,
}: {
  headingType: ActivityType | null;
  headingTitle: string | undefined;
  effectiveTitle: string;
  title: string;
  date: string;
  editData: ActivityEditData | null;
  pending: boolean;
  savedAt: number;
  saveError: boolean;
  blocker: string | null;
  overlay: boolean;
  onTitleChange: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="activity-form-header"
      className={`relative flex items-start justify-between gap-3 border-b border-brand-100/80 bg-brand-50/95 pb-5 backdrop-blur before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:bg-brand-50/95 before:content-[''] dark:border-white/10 dark:bg-ink-800/95 dark:before:bg-ink-800/95 md:sticky md:top-0 md:z-20 ${
        overlay
          ? "-mx-4 px-4 before:h-4 sm:-mx-6 sm:rounded-t-xl sm:px-6 sm:pt-6 sm:before:hidden"
          : "-mx-5 rounded-t-xl px-5 pt-5 before:hidden"
      }`}
    >
      <div className="min-w-0 flex-1">
        {/* Preserve a stable dialog heading for assistive tech while making the
            one visible title directly editable — no second Name field below. */}
        <h2 className="sr-only">{effectiveTitle}</h2>
        <div className="flex items-center gap-2">
          {headingType && (
            <ActivityIcon
              type={headingType}
              title={headingTitle}
              className="h-6 w-6 text-brand-600 dark:text-brand-400"
            />
          )}
          <input
            aria-label="Activity name"
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder={effectiveTitle}
            className="-mx-1 h-8 min-w-0 flex-1 rounded-md border-0 bg-transparent px-1 py-0 text-xl leading-8 font-bold text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500/40 dark:text-slate-100 dark:placeholder:text-slate-600"
          />
        </div>
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
            variant="quiet"
            className="mt-1"
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Desktop forms can be long and the footer may be well below the
            viewport, so keep autosave/validation feedback with the sticky
            header. Mobile retains its existing sticky footer. */}
        <div className="hidden items-center gap-1.5 text-xs md:flex">
          {blocker && (
            <span
              className="font-medium text-amber-600 dark:text-amber-400"
              title={blocker}
            >
              Not saved
            </span>
          )}
          <SaveStatus pending={pending} savedAt={savedAt} error={saveError} />
        </div>
        {/* Close control for both the centered modal and the docked editor; the
            docked form flushes any pending auto-save on unmount. */}
        <button
          type="button"
          onClick={onClose}
          className="-m-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-ink-800 dark:hover:text-slate-300"
          aria-label="Close"
        >
          <IconX className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
