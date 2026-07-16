"use client";

import ConditionForm from "./ConditionForm";
import { updateCondition, deleteCondition } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import StatusBadge from "@/components/StatusBadge";
import NotesText from "@/components/NotesText";
import { formatRecordDate } from "@/lib/record-format";
import type { Condition } from "@/lib/types";

const COLUMNS: RecordColumn<Condition>[] = [
  {
    header: "Condition",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (c) => (
      <>
        {c.name}
        <NotesText
          notes={c.notes}
          className="ml-2 text-xs font-normal text-slate-400"
        />
      </>
    ),
  },
  {
    header: "Code",
    headerClassName: "hidden sm:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-500 sm:table-cell dark:text-slate-400",
    cell: (c) =>
      c.code ? (
        <>
          {c.code}
          {c.code_system ? (
            <span className="ml-1 text-xs text-slate-400">{c.code_system}</span>
          ) : null}
        </>
      ) : (
        "—"
      ),
  },
  {
    header: "Status",
    cell: (c) => <StatusBadge status={c.status} />,
  },
  {
    header: "Onset",
    headerClassName: "hidden md:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-600 md:table-cell dark:text-slate-300",
    cell: (c) => formatRecordDate(c.onset_date),
  },
  {
    header: "Source",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (c) => <RecordProvenance source={c.source} />,
  },
];

// Manage stored condition rows: edit in place or delete, on the shared RecordTable.
export default function ConditionList({ items }: { items: Condition[] }) {
  return (
    <RecordTable
      items={items}
      columns={COLUMNS}
      emptyMessage="No conditions match this filter."
      renderEditForm={(c, done) => (
        <ConditionForm action={updateCondition} condition={c} onDone={done} />
      )}
      confirmDelete={(c) => ({
        title: "Delete condition",
        message: `Delete “${c.name}”? This can’t be undone.`,
      })}
      onDelete={async (c) => {
        const fd = new FormData();
        fd.set("id", String(c.id));
        await deleteCondition(fd);
      }}
    />
  );
}
