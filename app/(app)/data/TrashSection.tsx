import { EmptyState } from "@/components/ui";
import { listTrash } from "@/lib/queries/trash";
import TrashList from "./TrashList";

// Data → Trash (issue #2013). Every destructive row delete has captured a fully
// restorable copy into `deleted_rows` since #30; until now the ONLY affordance over
// that capture was a toast that disappeared in 15 seconds, after which the row sat on
// disk restorable, invisible, and eventually purged without ever having been offerable
// again. This is that view.
//
// It belongs under Data because a deleted row is a data-management concern and this
// page is already the home for "what came in, what's wrong with it, what to do about
// it" — beside Review, Coverage, and Manage & export.
//
// The list renders PHI (a capture's title/date/note, read out of the payload — the
// label column alone is enough to COUNT a trash but not to CHOOSE from one), so it
// sits behind the same session gate as every other (app) surface and free text goes
// through <NotesText>.
export default function TrashSection({
  profileId,
  retentionDays,
}: {
  profileId: number;
  retentionDays: number;
}) {
  const entries = listTrash(profileId, retentionDays);

  return (
    <div data-testid="data-trash" className="space-y-4">
      <div className="card">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Recently deleted
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Deleted rows are kept here for {retentionDays}{" "}
          {retentionDays === 1 ? "day" : "days"}, then purged for good — along
          with any video clips they captured. Restoring puts a row back with its
          children (an activity brings its sets, a medication its doses and
          adherence history) under a new id. An admin sets the window in Settings
          → Server.
        </p>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          testId="trash-empty"
          message="Nothing in the trash — deleted rows will appear here until their retention window runs out."
        />
      ) : (
        <TrashList entries={entries} />
      )}
    </div>
  );
}
