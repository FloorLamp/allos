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
import { formatWeekdayDate } from "@/lib/format-date";
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

  // WHEN A DOSE WAS TAKEN, AS ONE CELL. The head line's second fact has to answer
  // "which day AND what time" on a list that spans days — splitting the date off
  // would leave every row's clock floating on an unnamed day — and `trailing` is one
  // cell by construction (lib/card-row.ts). `formatWeekdayDate` is the dense-row
  // formatter: "Fri, Aug 28", pref-aware, the year only when it is not this one. The
  // long shape wrapped its own desktop column to two lines on every row.
  const whenCell = (row: DoseLedgerEntry): string => {
    const date = formatWeekdayDate(row.date, formatPrefs);
    return row.time ? `${date} · ${row.time}` : date;
  };

  const columns: EntryHistoryColumn<DoseLedgerEntry>[] = [
    {
      // IDENTITY IS THE ITEM AT THIS SCOPE (#3937). The per-item panel's rows differ
      // by day, so its date-as-title is right; here six doses of a morning stack
      // share a minute and differ only by which item they were, so the item is what
      // the row is. The link comes with it — the identity is where a reader reaches
      // for the item.
      header: "Item",
      slot: "title",
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
      header: "When",
      slot: "trailing",
      // The weekday survives the shortening because scanning for weekday patterns is
      // half of what a dose ledger is read for; `whitespace-nowrap` is what stops the
      // column wrapping the day off its own date.
      cellClassName:
        "whitespace-nowrap text-xs text-slate-500 dark:text-slate-400",
      cell: whenCell,
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
      // NO TWO ROWS' CONTROLS MAY ANNOUNCE THE SAME WORDS (#2615). The date alone
      // named every row of a stack day identically.
      menuItemName={(row) =>
        `${row.itemName} — ${formatWeekdayDate(row.date, formatPrefs)}`
      }
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
        message: `Remove the ${formatWeekdayDate(
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
