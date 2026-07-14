"use client";

import SaveStatus from "@/components/SaveStatus";

// The activity form's action row: the (undoable) Delete control, the auto-save
// status indicator, and — in the sticky overlay variant — a Done button. The
// sticky variant re-spans the overlay panel padding so the bar runs edge to edge.
// Presentational only — extracted from ActivityForm so the parent stays
// composition (#319).
export default function ActivityFormFooter({
  stickyFooter,
  hasRow,
  saving,
  pending,
  error,
  savedAt,
  onDelete,
  onDone,
}: {
  stickyFooter: boolean;
  hasRow: boolean;
  saving: boolean;
  pending: boolean;
  error: boolean;
  savedAt: number;
  onDelete: () => void;
  onDone: () => void;
}) {
  return (
    <div
      data-testid="activity-form-footer"
      className={`flex items-center justify-between gap-2 ${
        stickyFooter
          ? "sticky bottom-0 -mx-4 -mb-4 border-t border-black/5 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-bottom-8 sm:-mx-6 sm:-mb-6 sm:rounded-b-xl sm:px-6 dark:border-white/10 dark:bg-ink-900"
          : "pt-2"
      }`}
    >
      <div>
        {hasRow && (
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950"
          >
            Delete
          </button>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="md:hidden">
          <SaveStatus pending={pending} savedAt={savedAt} error={error} />
        </span>
        {stickyFooter && (
          <button type="button" onClick={onDone} className="btn">
            Done
          </button>
        )}
      </div>
    </div>
  );
}
