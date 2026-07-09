import RelativeTime from "@/components/RelativeTime";

// Shared provenance footer for an activity (issue #11): a small source chip
// ("Manual" / "Strava" / "Google Health Connect" / "Document", or "<Source> ·
// edited" for a hand-edited import) plus "added <when>" and, when the row has
// been edited since creation, "edited <when>". Rendered on the Journal card and
// the training activity views so provenance reads identically everywhere; the
// label is computed by activityProvenanceLabel (lib/journal-format).
export default function ActivityProvenance({
  label,
  createdAt,
  updatedAt,
  className,
}: {
  label: string;
  createdAt: string;
  // NULL until the row has been edited since creation.
  updatedAt: string | null;
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
        className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
        data-testid="activity-provenance-source"
      >
        {label}
      </span>
      <span>
        added <RelativeTime value={createdAt} />
      </span>
      {wasEdited && (
        <span>
          · edited <RelativeTime value={updatedAt} />
        </span>
      )}
    </div>
  );
}
