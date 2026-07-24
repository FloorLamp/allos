import Avatar from "@/components/Avatar";
import type { SubjectInfo } from "@/lib/scope";

// The shared cross-profile subject chip (#534/#900, extracted for the #1328 Tier-1
// fan-out from the Upcoming flagship). Rendered on a record-list row that belongs to a
// NON-acting member so a caregiver viewing several profiles can tell whose row it is;
// the acting profile's own rows are implied by the persistent view strip and get NO
// chip (subjectChipVisible in lib/multi-view.ts). On-element identity, never spatial
// (#531): the name truncates so the chip fits its slot, and a read-only-granted subject
// wears an "RO" badge so a member knows why the row shows no write buttons.
export default function SubjectChip({ subject }: { subject: SubjectInfo }) {
  return (
    <span
      data-testid={`subject-chip-${subject.profileId}`}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-black/10 bg-slate-50 py-0.5 pl-0.5 pr-2 text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300"
    >
      <Avatar
        profile={{
          id: subject.profileId,
          name: subject.name,
          photo_path: subject.photoPath,
          photo_version: subject.photoVersion,
        }}
        size="sm"
      />
      <span className="truncate">{subject.name}</span>
      {subject.access === "read" && (
        <span className="shrink-0 rounded-full bg-amber-100 px-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          RO
        </span>
      )}
    </span>
  );
}
