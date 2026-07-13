"use client";

import CarePlanForm from "./CarePlanForm";
import { updateCarePlanItem, deleteCarePlanItem } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import StatusBadge from "@/components/StatusBadge";
import ProviderName from "@/components/ProviderName";
import { formatRecordDate, titleCase } from "@/lib/record-format";
import type { CarePlanItem } from "@/lib/types";

const COLUMNS: RecordColumn<CarePlanItem>[] = [
  {
    header: "Item",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (c) => (
      <>
        {c.description}
        {c.provider_name ? (
          <ProviderName
            name={c.provider_name}
            providerId={c.provider_id}
            size="sm"
            className="ml-2 text-xs font-normal text-slate-400"
          />
        ) : null}
        {c.notes ? (
          <span className="ml-2 text-xs font-normal text-slate-400">
            {c.notes}
          </span>
        ) : null}
      </>
    ),
  },
  {
    header: "Category",
    headerClassName: "hidden sm:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-500 sm:table-cell dark:text-slate-400",
    cell: (c) => (c.category ? titleCase(c.category) : "—"),
  },
  {
    header: "Planned",
    cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
    cell: (c) => formatRecordDate(c.planned_date),
  },
  {
    header: "Status",
    headerClassName: "hidden md:table-cell",
    cellClassName: "hidden whitespace-nowrap md:table-cell",
    cell: (c) => <StatusBadge status={c.status} />,
  },
  {
    header: "Source",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (c) => <RecordProvenance source={c.source} />,
  },
];

// Manage stored care-plan rows: edit in place or delete, on the shared RecordTable.
export default function CarePlanList({ items }: { items: CarePlanItem[] }) {
  return (
    <RecordTable
      items={items}
      columns={COLUMNS}
      emptyMessage="No care-plan items yet. Add one, or import a MyChart / CCD health record to populate your planned care."
      renderEditForm={(c, done) => (
        <CarePlanForm action={updateCarePlanItem} item={c} onDone={done} />
      )}
      confirmDelete={(c) => ({
        title: "Delete care-plan item",
        message: `Delete “${c.description}”? This can’t be undone.`,
      })}
      onDelete={async (c) => {
        const fd = new FormData();
        fd.set("id", String(c.id));
        await deleteCarePlanItem(fd);
      }}
    />
  );
}
