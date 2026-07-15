import RelativeTime from "@/components/RelativeTime";
import EditLockNotice from "@/components/EditLockNotice";

// Shared provenance footer for an activity (issue #11): a source label
// ("Manual" / "Strava" / "Google Health Connect" / "Document", or "<Source> ·
// edited" for a hand-edited import) plus "added <when>" and, when the row has
// been edited since creation, "edited <when>". Rendered on the Journal card and
// the training activity views so provenance reads identically everywhere; the
// label is computed by activityProvenanceLabel (lib/journal-format).
//
// When the row is an edit-LOCKED integration import (#133/#659), `editLockId` is its
// id: the label gets a consequence tooltip and a short lock marker. Compact Journal
// cards and activity editor headers use the quiet icon treatment; "Resume sync
// updates" lives in the activity overflow menu rather than competing with metadata.
export default function ActivityProvenance({
  label,
  createdAt,
  updatedAt,
  editLockId,
  variant = "badge",
  className,
}: {
  label: string;
  createdAt: string;
  // NULL until the row has been edited since creation.
  updatedAt: string | null;
  // The activity id when this is a hand-edited integration row (the clearable lock),
  // else undefined.
  editLockId?: number;
  // Journal cards and editor headers use a quiet provenance line. Other record
  // surfaces can retain the badge treatment where provenance needs more weight.
  variant?: "badge" | "quiet";
  className?: string;
}) {
  // Only surface "edited" when the update is genuinely later than creation — the
  // update path stamps updated_at, so a row saved once (created_at === the first
  // edit) shouldn't read as edited.
  const wasEdited = !!updatedAt && updatedAt > createdAt;
  const sourceName = label.replace(/\s*·\s*edited$/, "");
  const hasEditedLabel = sourceName !== label;
  const showEdited = wasEdited || hasEditedLabel;
  // "Edited" is one canonical provenance item, never part of the source name.
  // Legacy rows whose update time equals creation still retain the state, just
  // without inventing a relative edit time.
  const displayLabel = showEdited ? sourceName : label;
  const activityLockConsequence = `You edited this activity, so ${sourceName} won’t update it.`;
  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400${
        className ? ` ${className}` : ""
      }`}
      data-testid="activity-provenance"
    >
      <span
        className={
          variant === "badge"
            ? "badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
            : "font-medium"
        }
        data-testid="activity-provenance-source"
      >
        {displayLabel}
        {editLockId != null && variant === "quiet" && !showEdited && (
          <EditLockNotice
            table="activities"
            id={editLockId}
            showResume={false}
            appearance="icon"
            consequence={activityLockConsequence}
            className="ml-1 align-[-0.1em]"
          />
        )}
      </span>
      <span>
        {variant === "quiet" && <span aria-hidden>· </span>}
        added <RelativeTime value={createdAt} />
      </span>
      {showEdited && (
        <span className="inline-flex items-center gap-1">
          <span>· edited</span>
          {wasEdited && <RelativeTime value={updatedAt} />}
          {editLockId != null && variant === "quiet" && (
            <EditLockNotice
              table="activities"
              id={editLockId}
              showResume={false}
              appearance="icon"
              consequence={activityLockConsequence}
            />
          )}
        </span>
      )}
      {editLockId != null && variant !== "quiet" && (
        <EditLockNotice
          table="activities"
          id={editLockId}
          consequence={activityLockConsequence}
        />
      )}
    </div>
  );
}
