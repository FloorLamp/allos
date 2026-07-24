"use client";

import AllergyForm from "./AllergyForm";
import { updateAllergy, deleteAllergy } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import StatusBadge from "@/components/StatusBadge";
import NotesText from "@/components/NotesText";
import type { Allergy } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

const COLUMNS: RecordColumn<Allergy>[] = [
  {
    header: "Substance",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (a) => (
      <>
        {a.substance}
        <NotesText
          notes={a.notes}
          className="ml-2 text-xs font-normal text-slate-400"
        />
      </>
    ),
  },
  {
    header: "Reaction",
    cellClassName: "text-slate-600 dark:text-slate-300",
    cell: (a) => a.reaction ?? "—",
  },
  {
    header: "Severity",
    cellClassName: "text-slate-600 dark:text-slate-300",
    cell: (a) => a.severity ?? "—",
  },
  {
    header: "Status",
    cell: (a) => <StatusBadge status={a.status} />,
  },
  {
    header: "Source",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (a) => <RecordProvenance source={a.source} />,
  },
];

// Manage stored allergy rows: edit in place or delete, on the shared RecordTable.
// (The merged known-allergies view — documented + lab-derived — is rendered
// read-only above by the page.)
export default function AllergyList({
  items,
  multiView,
}: {
  items: Stamped<Allergy>[];
  multiView?: ListMultiView;
}) {
  return (
    <RecordTable
      items={items}
      columns={COLUMNS}
      emptyMessage="No allergies recorded. Add one, or import a MyChart export."
      multiView={
        multiView
          ? {
              actingProfileId: multiView.actingProfileId,
              subjectOf: (a) => a.subject,
            }
          : undefined
      }
      renderEditForm={(a, done) => (
        <AllergyForm
          action={updateAllergy}
          allergy={a}
          profileId={multiView ? a.subject.profileId : undefined}
          onDone={done}
        />
      )}
      confirmDelete={(a) => ({
        title: "Delete allergy",
        message: `Delete the ${a.substance} allergy? This can’t be undone.`,
      })}
      onDelete={async (a) => {
        const fd = new FormData();
        fd.set("id", String(a.id));
        if (multiView) fd.set("profile_id", String(a.subject.profileId));
        await deleteAllergy(fd);
      }}
    />
  );
}
