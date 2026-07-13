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
// id: the label gets a consequence tooltip and a "Resume sync updates" affordance, so
// the lock says WHAT it does ("syncs won't update this row") and offers a way out —
// not just the bare "· edited" text.
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
  // Journal cards use a quiet footer; editor headers retain the stronger source
  // badge because provenance is part of the editing context there.
  variant?: "badge" | "quiet";
  className?: string;
}) {
  // Only surface "edited" when the update is genuinely later than creation — the
  // update path stamps updated_at, so a row saved once (created_at === the first
  // edit) shouldn't read as edited.
  const wasEdited = !!updatedAt && updatedAt > createdAt;
  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 dark:text-slate-500${
        className ? ` ${className}` : ""
      }`}
      data-testid="activity-provenance"
    >
      <span
        className={
          variant === "badge"
            ? "badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
            : "font-medium text-slate-500 dark:text-slate-400"
        }
        title={
          editLockId != null
            ? "Hand-edited — imports will no longer update this row."
            : undefined
        }
        data-testid="activity-provenance-source"
      >
        {label}
      </span>
      <span>
        {variant === "quiet" && <span aria-hidden>· </span>}
        added <RelativeTime value={createdAt} />
      </span>
      {wasEdited && (
        <span>
          · edited <RelativeTime value={updatedAt} />
        </span>
      )}
      {editLockId != null && (
        <EditLockNotice table="activities" id={editLockId} />
      )}
    </div>
  );
}
