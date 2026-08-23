"use client";

import Link from "next/link";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import EntryHistoryTable, {
  type EntryHistoryColumn,
} from "@/components/EntryHistoryTable";
import { deleteAdministration } from "@/app/(app)/nutrition/intake-actions";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
  doseOptionsFor,
  type DoseLedgerEntry,
  type DoseLedgerItem,
} from "@/components/intake/dose-ledger-entry";
import { formatLongDate } from "@/lib/format-date";
import { medicationHref, intakeHref } from "@/lib/hrefs";

// THE DOSE MOUNT'S ROWS (#2417, remounted on the shared frame by #3484 part 2).
//
// Everything kind-specific about the cross-item dose ledger lives here rather than in
// components/ledger/EventLedgerFrame.tsx: the columns, the amend contract (#2228 —
// the edit form seeds its time from `statedAt` and nothing else), the medication /
// supplement link targets, and the domain's undo contract (`deleteAdministration`
// returns an `undoId`, and EntryHistoryTable's shared undoable-delete path carries
// it). None of that generalizes: a food ledger's amend rules and a practice ledger's
// undo are their own, and a frame holding a branch for each would be three ledgers
// again with one name.
//
// components/intake/DoseHistoryPanel.tsx is the ITEM-scoped view of the same rows.
// Both render through EntryHistoryTable, so the scope is the only difference and
// neither gets its own row semantics.
//
// FILTERS are the page's, not this component's: item / kind / date range ride the URL
// and narrow the QUERY, so a filtered ledger is a deep link and the item filter's rows
// are literally the per-item panel's rows (same reader, same window).
export default function DoseLedgerRows({
  rows,
  items,
  canWrite,
  maxDate,
  defaultTime,
}: {
  rows: DoseLedgerEntry[];
  items: DoseLedgerItem[];
  canWrite: boolean;
  maxDate: string;
  defaultTime: string;
}) {
  const formatPrefs = useFormatPrefs();
  const itemById = new Map(items.map((item) => [item.id, item]));

  const columns: EntryHistoryColumn<DoseLedgerEntry>[] = [
    {
      header: "Date",
      slot: "title",
      cellClassName: "font-medium text-slate-700 dark:text-slate-200",
      cell: (row) => formatLongDate(row.date, formatPrefs),
    },
    {
      header: "Time",
      slot: "meta",
      label: "Time",
      empty: (row) => !row.time,
      cellClassName: "text-xs text-slate-500 dark:text-slate-400",
      cell: (row) => row.time || "—",
    },
    {
      header: "Item",
      slot: "value",
      label: "Item",
      cellClassName: "text-slate-600 dark:text-slate-300",
      cell: (row) => (
        <Link
          href={
            row.kind === "medication"
              ? medicationHref(row.itemId)
              : intakeHref(row.kind)
          }
          className="font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          {row.itemName}
        </Link>
      ),
    },
    {
      header: "Amount",
      slot: "value",
      label: "Amount",
      empty: (row) => !row.amount,
      cellClassName: "text-slate-600 dark:text-slate-300",
      cell: (row) => row.amount || "—",
    },
    {
      header: "Product",
      slot: "meta",
      label: "Product",
      empty: (row) => !row.product,
      cellClassName: "text-xs text-slate-500 dark:text-slate-400",
      cell: (row) => row.product || "—",
    },
  ];

  return (
    <EntryHistoryTable
      items={rows}
      columns={columns}
      readOnly={!canWrite}
      menuKind="Dose"
      menuItemName={(row) => formatLongDate(row.date, formatPrefs)}
      rowTestId={() => "dose-ledger-row"}
      renderEditForm={(row, done) => {
        const item = itemById.get(row.itemId);
        return (
          <HistoricalDoseForm
            itemId={row.itemId}
            itemName={row.itemName}
            doses={item ? doseOptionsFor(item, formatPrefs) : []}
            maxDate={maxDate}
            defaultTime={defaultTime}
            asNeeded={item?.asNeeded ?? false}
            courseBound={row.kind === "medication"}
            editing={{
              logId: row.id,
              doseId: row.doseId,
              date: row.date,
              statedAt: row.statedAt,
              amount: row.amount,
            }}
            onDone={done}
          />
        );
      }}
      confirmDelete={(row) => ({
        title: "Delete dose?",
        message: `Remove the ${formatLongDate(
          row.date,
          formatPrefs
        )} dose of ${row.itemName} from the record. You can undo this.`,
        confirmLabel: "Delete dose",
      })}
      deleteFormData={(row) => {
        const fd = new FormData();
        fd.set("log_id", String(row.id));
        return fd;
      }}
      deleteAction={deleteAdministration}
      deletedMessage="Dose deleted."
    />
  );
}
