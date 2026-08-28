"use client";

import ActivityIcon from "../ActivityIcon";
import ActivityProvenance from "@/components/ActivityProvenance";
import { activityProvenanceLabel } from "@/lib/training-log-format";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { IconMinus, IconPencil } from "@tabler/icons-react";
import type { ActivityType } from "@/lib/types";
import type { ActivityEditData } from "./model";
import SaveStatus from "@/components/SaveStatus";
import Button from "@/components/Button";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";

// The activity form's header section: the type icon + live title, the date
// subtitle, the stored-row provenance line, and the close control. Presentational
// only — extracted from ActivityForm so the parent stays composition (#319).
export default function ActivityFormHeader({
  headingType,
  headingTitle,
  headingComposite = false,
  effectiveTitle,
  title,
  date,
  editData,
  pending,
  savedAt,
  saveError,
  blocker,
  overlay,
  showMinimize = false,
  onTitleChange,
  onClose,
}: {
  headingType: ActivityType | null;
  headingTitle: string | undefined;
  headingComposite?: boolean;
  effectiveTitle: string;
  title: string;
  date: string;
  editData: ActivityEditData | null;
  pending: boolean;
  savedAt: number;
  saveError: boolean;
  blocker: string | null;
  overlay: boolean;
  showMinimize?: boolean;
  onTitleChange: (value: string) => void;
  onClose: () => void;
}) {
  const formatPrefs = useFormatPrefs();
  return (
    <div
      data-testid="activity-form-header"
      className={`relative flex items-start justify-between gap-3 border-b border-brand-100/80 bg-brand-50/95 pb-5 backdrop-blur-sm before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:bg-brand-50/95 before:content-[''] dark:border-white/10 dark:bg-ink-800/95 dark:before:bg-ink-800/95 md:sticky md:top-0 md:z-20 ${
        overlay
          ? "-mx-4 px-4 before:h-4 sm:-mx-8 sm:px-8 sm:pt-6 sm:before:hidden"
          : "-mx-5 rounded-t-xl px-5 pt-5 before:hidden"
      }`}
    >
      <div
        className="flex min-w-0 flex-1 items-start gap-3"
        data-testid="activity-form-identity"
      >
        {headingType ? (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-100/70 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
            <ActivityIcon
              type={headingType}
              title={headingTitle}
              composite={headingComposite}
              className="h-6 w-6"
              stroke={1.6}
            />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          {/* Preserve a stable dialog heading for assistive tech while making the
              one visible title directly editable — no second Name field below. */}
          <h2 className="sr-only">{effectiveTitle}</h2>
          <div className="group/title relative -mx-1 min-w-0 flex-1">
            {/* The control box (#3708/#3709, restated by #3938). This title is a
                HEADING that happens to be editable, so it wears none of `.input`'s
                paint and cannot take the box with it — it carries `--control-box`
                itself, at every width, rather than stepping at `sm`. */}
            <input
              aria-label="Activity name"
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder={effectiveTitle}
              className="h-(--control-box) w-full min-w-0 rounded-md border-0 bg-transparent py-0 pl-1 pr-8 text-xl leading-8 font-bold text-slate-900 outline-hidden placeholder:text-slate-400 hover:bg-white/45 focus:bg-white/65 focus:ring-2 focus:ring-brand-500/40 dark:text-slate-100 dark:placeholder:text-slate-600 dark:hover:bg-white/5 dark:focus:bg-white/5"
            />
            <IconPencil
              aria-hidden
              className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 transition-colors group-focus-within/title:text-brand-600 dark:text-slate-400 dark:group-focus-within/title:text-brand-400"
              stroke={1.75}
            />
          </div>
          {/* Date lives in a field below, but surfacing it in the header gives
              at-a-glance context for the row being edited. Reads live `date`
              state, so it tracks edits to the field. */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-slate-500 dark:text-slate-400">
            <span>{formatLongDate(date, formatPrefs)}</span>
            {/* Full provenance remains on the detail page. The sticky editor
                header keeps only source/edit state on this same metadata line. */}
            {editData?.created_at && (
              <>
                <span
                  aria-hidden
                  className="text-slate-300 dark:text-slate-600"
                >
                  ·
                </span>
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
                  variant="compact"
                />
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Desktop forms can be long and the footer may be well below the
            viewport, so keep autosave/validation feedback with the sticky
            header. Mobile retains its existing sticky footer. */}
        <div className="hidden h-8 items-center gap-1.5 text-xs md:flex">
          {blocker && (
            <span className="inline-flex items-center font-medium text-amber-600 dark:text-amber-400">
              Not saved
              <InfoTooltipIcon label={blocker} />
            </span>
          )}
          <SaveStatus pending={pending} savedAt={savedAt} error={saveError} />
        </div>
        {showMinimize ? (
          // The activity workspace's drag handle owns phone minimization. This
          // layout wrapper keeps the ordinary labelled action desktop-only.
          <span className="hidden sm:inline-flex">
            <Button
              type="button"
              onClick={() => void onClose()}
              aria-label="Minimize workout"
            >
              <IconMinus className="h-5 w-5" />
              Minimize
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
