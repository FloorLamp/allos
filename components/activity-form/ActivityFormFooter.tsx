"use client";

import SaveStatus from "@/components/SaveStatus";

// The activity form's action row: the (undoable) Delete control, auto-save
// status, and one completion cluster. An ordinary entry gets Done; a finishable
// workout gets an explicit Close / Finish workout decision in this same place.
// The sticky variant re-spans the overlay panel padding so the bar runs edge to edge.
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
  onFinish,
  showDone = true,
}: {
  stickyFooter: boolean;
  hasRow: boolean;
  saving: boolean;
  pending: boolean;
  error: boolean;
  savedAt: number;
  onDelete: () => void;
  onDone: () => void;
  onFinish?: () => void;
  showDone?: boolean;
}) {
  return (
    <div
      data-testid="activity-form-footer"
      className={`flex items-center justify-between gap-2 ${
        stickyFooter
          ? "sticky bottom-0 -mx-4 -mb-4 border-t border-black/5 bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-8 sm:-mb-8 sm:px-8 dark:border-white/10"
          : "pt-2"
      }`}
    >
      <div>
        {hasRow && (
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            className="rounded-lg px-2 py-2 text-sm font-medium text-slate-500 transition hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-rose-950/50 dark:hover:text-rose-300"
          >
            Delete
          </button>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="md:hidden">
          <SaveStatus pending={pending} savedAt={savedAt} error={error} />
        </span>
        {stickyFooter && onFinish ? (
          <button
            type="button"
            onClick={() => void onDone()}
            className="btn-ghost btn-sm"
          >
            Close
          </button>
        ) : null}
        {stickyFooter && showDone && (
          <button
            type="button"
            onClick={() => void (onFinish ?? onDone)()}
            className="btn"
            data-testid={onFinish ? "plain-finish-workout" : undefined}
          >
            {onFinish ? "Finish workout" : "Done"}
          </button>
        )}
      </div>
    </div>
  );
}
