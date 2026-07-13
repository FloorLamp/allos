"use client";

import FamilyHistoryForm from "./FamilyHistoryForm";
import { updateFamilyHistory, deleteFamilyHistory } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import type { FamilyHistory } from "@/lib/types";

const COLUMNS: RecordColumn<FamilyHistory>[] = [
  {
    header: "Relative",
    cellClassName:
      "whitespace-nowrap font-medium text-slate-800 dark:text-slate-100",
    cell: (f) => f.relation || "—",
  },
  {
    header: "Condition",
    cellClassName: "text-slate-700 dark:text-slate-200",
    cell: (f) => (
      <>
        {f.condition}
        {f.code ? (
          <span className="ml-1.5 text-xs text-slate-400">{f.code}</span>
        ) : null}
        {f.deceased === 1 ? (
          <span className="ml-2 badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
            Deceased
          </span>
        ) : null}
        {f.notes ? (
          <span className="ml-2 text-xs font-normal text-slate-400">
            {f.notes}
          </span>
        ) : null}
      </>
    ),
  },
  {
    header: "Onset age",
    headerClassName: "hidden sm:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-600 sm:table-cell dark:text-slate-300",
    cell: (f) => (f.onset_age != null ? `${f.onset_age} yrs` : "—"),
  },
  {
    header: "Source",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (f) => <RecordProvenance source={f.source} />,
  },
];

// Manage stored family-history rows (one condition per relative): edit in place or
// delete, on the shared RecordTable. Rows arrive grouped by relative (query order).
export default function FamilyHistoryList({
  items,
}: {
  items: FamilyHistory[];
}) {
  return (
    <RecordTable
      items={items}
      columns={COLUMNS}
      emptyMessage="No family history yet. Add an entry, or import a MyChart / CCD health record to populate it."
      renderEditForm={(f, done) => (
        <FamilyHistoryForm
          action={updateFamilyHistory}
          entry={f}
          onDone={done}
        />
      )}
      confirmDelete={(f) => ({
        title: "Delete family-history entry",
        message: `Delete “${f.condition}”${
          f.relation ? ` (${f.relation})` : ""
        }? This can’t be undone.`,
      })}
      onDelete={async (f) => {
        const fd = new FormData();
        fd.set("id", String(f.id));
        await deleteFamilyHistory(fd);
      }}
    />
  );
}
