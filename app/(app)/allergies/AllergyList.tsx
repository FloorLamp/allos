"use client";

import AllergyForm from "./AllergyForm";
import { updateAllergy, deleteAllergy } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import type { Allergy } from "@/lib/types";

const STATUS_BADGE: Record<string, string> = {
  active: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  inactive: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
  resolved:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

const COLUMNS: RecordColumn<Allergy>[] = [
  {
    header: "Substance",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (a) => (
      <>
        {a.substance}
        {a.notes ? (
          <span className="ml-2 text-xs font-normal text-slate-400">
            {a.notes}
          </span>
        ) : null}
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
    cell: (a) => (
      <span className={`badge capitalize ${STATUS_BADGE[a.status] ?? ""}`}>
        {a.status}
      </span>
    ),
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
export default function AllergyList({ items }: { items: Allergy[] }) {
  return (
    <RecordTable
      items={items}
      columns={COLUMNS}
      emptyMessage="No allergies recorded. Add one, or import a MyChart export."
      renderEditForm={(a, done) => (
        <AllergyForm action={updateAllergy} allergy={a} onDone={done} />
      )}
      confirmDelete={(a) => ({
        title: "Delete allergy",
        message: `Delete the ${a.substance} allergy? This can’t be undone.`,
      })}
      onDelete={async (a) => {
        const fd = new FormData();
        fd.set("id", String(a.id));
        await deleteAllergy(fd);
      }}
    />
  );
}
