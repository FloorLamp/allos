"use client";

import ConditionForm from "./ConditionForm";
import { updateCondition, deleteCondition } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import StatusBadge from "@/components/StatusBadge";
import NotesText from "@/components/NotesText";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import type { Condition } from "@/lib/types";

function buildColumns(
  fmt: DisplayFormatPrefs,
  treatedWith: Record<number, string[]>
): RecordColumn<Condition>[] {
  return [
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
          {/* Med → indication inverse view (#1052): the medications recorded as
              treating this condition. A formatter over the ONE link, no inference. */}
          {treatedWith[c.id]?.length ? (
            <div
              className="mt-0.5 text-xs font-normal text-slate-500 dark:text-slate-400"
              data-testid="condition-treated-with"
            >
              Treated with: {treatedWith[c.id].join(", ")}
            </div>
          ) : null}
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
              <span className="ml-1 text-xs text-slate-400">
                {c.code_system}
              </span>
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
      cell: (c) => formatRecordDate(c.onset_date, "—", fmt),
    },
    {
      header: "Source",
      headerClassName: "hidden sm:table-cell",
      cellClassName: "hidden whitespace-nowrap sm:table-cell",
      cell: (c) => <RecordProvenance source={c.source} />,
    },
  ];
}

// Manage stored condition rows: edit in place or delete, on the shared RecordTable.
// `treatedWith` maps a condition id → the medications treating it (#1052), rendered as
// a "Treated with:" sub-line; empty/absent for conditions with no linked med.
export default function ConditionList({
  items,
  treatedWith = {},
}: {
  items: Condition[];
  treatedWith?: Record<number, string[]>;
}) {
  const columns = buildColumns(useFormatPrefs(), treatedWith);
  return (
    <RecordTable
      items={items}
      columns={columns}
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
