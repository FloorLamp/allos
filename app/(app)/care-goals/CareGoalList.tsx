"use client";

import CareGoalForm from "./CareGoalForm";
import { updateCareGoal, deleteCareGoal } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import { formatRecordDate, titleCase } from "@/lib/record-format";
import type { CareGoal } from "@/lib/types";

const COLUMNS: RecordColumn<CareGoal>[] = [
  {
    header: "Goal",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (g) => (
      <>
        {g.description}
        {g.notes ? (
          <span className="ml-2 text-xs font-normal text-slate-400">
            {g.notes}
          </span>
        ) : null}
      </>
    ),
  },
  {
    header: "Target date",
    cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
    cell: (g) => formatRecordDate(g.target_date),
  },
  {
    header: "Status",
    headerClassName: "hidden sm:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-500 sm:table-cell dark:text-slate-400",
    cell: (g) => (g.status ? titleCase(g.status) : "—"),
  },
  {
    header: "Source",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (g) => <RecordProvenance source={g.source} />,
  },
];

// Manage stored care-goal rows: edit in place or delete, on the shared RecordTable.
export default function CareGoalList({ items }: { items: CareGoal[] }) {
  return (
    <RecordTable
      items={items}
      columns={COLUMNS}
      emptyMessage="No health goals yet. Add one, or import a MyChart / CCD health record to populate goals set in your records."
      renderEditForm={(g, done) => (
        <CareGoalForm action={updateCareGoal} goal={g} onDone={done} />
      )}
      confirmDelete={(g) => ({
        title: "Delete health goal",
        message: `Delete “${g.description}”? This can’t be undone.`,
      })}
      onDelete={async (g) => {
        const fd = new FormData();
        fd.set("id", String(g.id));
        await deleteCareGoal(fd);
      }}
    />
  );
}
