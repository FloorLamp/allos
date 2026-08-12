"use client";

import { useState } from "react";
import Link from "next/link";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import EntryHistoryTable, {
  type EntryHistoryColumn,
} from "@/components/EntryHistoryTable";
import { deleteAdministration } from "@/app/(app)/nutrition/intake-actions";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatLongDate } from "@/lib/format-date";
import { formatMedicationDoseLine } from "@/lib/medication-dose-format";
import { medicationHref, intakeHref } from "@/lib/hrefs";
import type { DoseHistoryDose } from "@/components/intake/DoseHistoryPanel";
import type { IntakeItemKind } from "@/lib/types";

// One taken dose as the cross-item ledger renders it: the per-item panel's entry plus
// the identity of the item it was taken against. `time` is the already-formatted
// profile-local clock (or "recorded 7:02am" when the row states no intake time of its
// own — #2228 decision 4), and `statedAt` is the ONLY thing the edit form's time field
// may seed from.
export interface DoseLedgerEntry {
  id: number;
  itemId: number;
  itemName: string;
  kind: IntakeItemKind;
  doseId: number;
  date: string;
  time: string;
  statedAt: string | null;
  amount: string | null;
  product: string | null;
}

// An item the ledger can log a past dose against — the picker in front of the backfill
// form. Only items with a LIVE dose can be logged against, so an item whose doses are
// all retired is simply absent from the picker (its history still lists).
export interface DoseLedgerItem {
  id: number;
  name: string;
  kind: IntakeItemKind;
  product: string | null;
  asNeeded: boolean;
  doses: DoseHistoryDose[];
}

// The CROSS-ITEM dose ledger (#2417): every confirmed dose across items, on the shared
// EntryHistoryTable, with the same ⋯ Edit / Delete-with-undo row actions over the same
// unchanged cores the per-item panel uses.
//
// Dose history used to exist ONLY as a per-item disclosure two menus deep, so "what did
// I actually take last week, across items" cost one navigation per item. This is the
// other scope of that one question; components/intake/DoseHistoryPanel.tsx is the
// item-scoped one. Both render the same rows through the same component — the scope is
// the only difference, which is why neither gets its own row semantics.
//
// "Log past dose" is a TOP-LEVEL entry here (an item picker in front of the same
// HistoricalDoseForm), rather than living behind an item's ⋯ menu: backfilling a dose
// is the most common reason to open a dose ledger at all.
//
// FILTERS are the page's, not this component's: item / kind / date range ride the URL
// and narrow the QUERY, so a filtered ledger is a deep link and the item filter's rows
// are literally the per-item panel's rows (same reader, same window).
export default function DoseLedgerTable({
  rows,
  items,
  canWrite,
  maxDate,
  defaultTime,
  defaultItemId,
  note,
}: {
  rows: DoseLedgerEntry[];
  items: DoseLedgerItem[];
  canWrite: boolean;
  maxDate: string;
  defaultTime: string;
  // The item the ledger is currently FILTERED to, if any: a reader who narrowed the
  // table to one item and then tapped "Log past dose" means that item, so the picker
  // opens on it instead of on whatever sorts first. Every item stays selectable.
  defaultItemId?: number;
  // What the window is bounded to, rendered rather than left implicit so a list that
  // stops at the range's edge never reads as "you took nothing before this".
  note?: string;
}) {
  const formatPrefs = useFormatPrefs();
  const [adding, setAdding] = useState(false);
  const loggable = items.filter((item) => item.doses.length > 0);
  const [pickedId, setPickedId] = useState<number>(
    (defaultItemId && loggable.some((item) => item.id === defaultItemId)
      ? defaultItemId
      : loggable[0]?.id) ?? 0
  );
  const picked = loggable.find((item) => item.id === pickedId) ?? loggable[0];
  const itemById = new Map(items.map((item) => [item.id, item]));

  const doseOptionsFor = (item: DoseLedgerItem) =>
    item.doses.map((dose) => ({
      id: dose.id,
      label:
        formatMedicationDoseLine({
          amount: dose.amount,
          product: item.product,
          timeOfDay: dose.time_of_day,
          asNeeded: item.asNeeded,
          timeFormat: formatPrefs.timeFormat,
        }) || "Dose",
      amount: dose.amount,
    }));

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
    <div data-testid="dose-ledger">
      {canWrite && loggable.length > 0 ? (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setAdding((value) => !value)}
            className="btn-ghost btn-sm"
            aria-expanded={adding}
            data-testid="dose-ledger-add"
          >
            {adding ? "Cancel" : "Log past dose"}
          </button>
          {adding && picked ? (
            <div data-testid="dose-ledger-add-panel">
              {/* Named distinctly from the page's Item FILTER: two controls whose
                  accessible name is just "Item" would be indistinguishable to a
                  screen reader (and to a spec) on the same page. */}
              <label className="label mt-3 block" htmlFor="dose-ledger-item">
                Item to log against
              </label>
              <select
                id="dose-ledger-item"
                className="input"
                value={picked.id}
                data-testid="dose-ledger-item-picker"
                onChange={(event) => setPickedId(Number(event.target.value))}
              >
                {loggable.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              {/* Keyed on the item so switching the picker RESETS the form's dose,
                  amount and date state — a form seeded from a different item would
                  otherwise carry that item's dose id into this one's write. */}
              <HistoricalDoseForm
                key={picked.id}
                itemId={picked.id}
                itemName={picked.name}
                doses={doseOptionsFor(picked)}
                maxDate={maxDate}
                defaultTime={defaultTime}
                asNeeded={picked.asNeeded}
                courseBound={picked.kind === "medication"}
                onDone={() => setAdding(false)}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
          {note}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="dose-ledger-empty"
        >
          No confirmed doses in this window. Widen the date range, or confirm a
          dose on Supplements or Medications.
        </p>
      ) : (
        <EntryHistoryTable
          items={rows}
          columns={columns}
          readOnly={!canWrite}
          menuLabel="Dose actions"
          rowTestId={() => "dose-ledger-row"}
          renderEditForm={(row, done) => {
            const item = itemById.get(row.itemId);
            return (
              <HistoricalDoseForm
                itemId={row.itemId}
                itemName={row.itemName}
                doses={item ? doseOptionsFor(item) : []}
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
      )}
    </div>
  );
}
