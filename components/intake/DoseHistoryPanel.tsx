"use client";

import { useState } from "react";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import EntryHistoryTable, {
  type EntryHistoryColumn,
} from "@/components/EntryHistoryTable";
import { deleteAdministration } from "@/app/(app)/nutrition/intake-actions";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatLongDate } from "@/lib/format-date";
import {
  formatMedicationDoseLine,
  formatMedicationDoseProduct,
} from "@/lib/medication-dose-format";

// One recorded administration as the panel renders it. `time` is the
// already-formatted profile-local clock string — when the row states no intake time
// of its own, the caller marks the record-chain clock as "recorded 7:02am" rather
// than presenting a filing timestamp as an administration time (#2228 decision 4).
// `statedAt` is the row's stated event instant (occurred_at, ISO UTC) or null — the
// ONLY thing the edit form's time field may seed from (#2228 decision 1): a row
// whose intake time was never stated opens its editor with an EMPTY time field,
// never with the recorded_at/taken_at record chain wearing an administration time's
// clothes.
export interface DoseHistoryEntry {
  id: number;
  doseId: number;
  date: string;
  time: string;
  statedAt: string | null;
  amount: string | null;
  product: string | null;
}

// A live (non-retired) dose row the backfill form may log against.
export interface DoseHistoryDose {
  id: number;
  amount: string | null;
  time_of_day: string | null;
}

// The dose-history panel: an item's recorded administrations, with backfill, amend,
// and delete-with-undo behind the ⋯ row-action convention (#1488).
//
// ONE component for BOTH kinds (#1933). It was inline in MedicationCard, which is
// exactly how the split survived: supplements and medications share their dose,
// adherence, refill, interaction, and warning machinery by rule, and historical dose
// correction is adherence machinery. A second copy under the supplements tab would
// have re-created the divergence this issue exists to remove, so the medication card
// and the supplement row now render the same panel over the same ungated cores.
//
// The ROWS are the shared EntryHistoryTable since #2417 — that component's header had
// named dose history as one of the four clones it existed to absorb, and this was the
// copy that never migrated. The bespoke `<ul>`, its own ⋯ menu, and its own delete
// wiring are gone; what stays here is what is genuinely dose history's own: the
// columns, the backfill/amend form, and the item's dose options.
//
// This is the ITEM-SCOPED scope of one question. The CROSS-ITEM scope — the same
// rows for every item at once — is components/intake/DoseLedgerTable.tsx, over the
// same cores and the same table. An item-scoped question stays answerable on the
// item, which is why this panel keeps its own "Log past dose" entry.
//
// Every action renders its core's typed outcome: the forms show the refusal text the
// action returned, and the delete goes through EntryHistoryTable's useUndoableDelete,
// which only offers Undo when the core actually handed back a token. Nothing here
// confirms unconditionally.
export default function DoseHistoryPanel({
  itemId,
  itemName,
  product,
  doses,
  asNeeded,
  history,
  minDate,
  maxDate,
  defaultTime,
  canWrite = true,
  courseBound = true,
  backfillDisabledReason,
  note,
}: {
  itemId: number;
  itemName: string;
  product: string | null;
  doses: DoseHistoryDose[];
  asNeeded: boolean;
  history: DoseHistoryEntry[];
  minDate?: string;
  maxDate: string;
  defaultTime: string;
  canWrite?: boolean;
  // Whether this item's history is bounded by a medication course (see the form).
  courseBound?: boolean;
  // Why a backfill can't be offered right now (no live dose, no course covering any
  // date). Present = the button is disabled and says so; absent = it is offered.
  backfillDisabledReason?: string;
  // What this list is bounded to, when a caller shows a window rather than the whole
  // record. Rendered rather than left implicit, so a list that stops at 90 days never
  // reads as "you have no older doses".
  note?: string;
}) {
  const [adding, setAdding] = useState(false);
  const formatPrefs = useFormatPrefs();

  const doseOptions = doses.map((dose) => ({
    id: dose.id,
    label:
      formatMedicationDoseLine({
        amount: dose.amount,
        product,
        timeOfDay: dose.time_of_day,
        asNeeded,
        timeFormat: formatPrefs.timeFormat,
      }) || "Dose",
    amount: dose.amount,
  }));

  const columns: EntryHistoryColumn<DoseHistoryEntry>[] = [
    {
      header: "Date",
      slot: "title",
      cellClassName: "font-medium text-slate-600 dark:text-slate-300",
      cell: (entry) => formatLongDate(entry.date, formatPrefs),
    },
    {
      header: "Amount",
      slot: "value",
      label: "Amount",
      empty: (entry) =>
        !formatMedicationDoseProduct(entry.amount, entry.product),
      cellClassName: "text-slate-600 dark:text-slate-300",
      cell: (entry) =>
        formatMedicationDoseProduct(entry.amount, entry.product) || "—",
    },
    {
      header: "Time",
      slot: "meta",
      label: "Time",
      empty: (entry) => !entry.time,
      cellClassName: "text-xs text-slate-500 dark:text-slate-400",
      cell: (entry) => entry.time || "—",
    },
  ];

  return (
    <div data-testid="dose-history">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="section-label">Dose history</span>
        {canWrite ? (
          <button
            type="button"
            onClick={() => setAdding((value) => !value)}
            className="btn-ghost btn-sm"
            disabled={!!backfillDisabledReason}
            title={backfillDisabledReason}
            aria-expanded={adding}
            data-testid="dose-history-add"
          >
            {adding ? "Cancel" : "Log past dose"}
          </button>
        ) : null}
      </div>
      {note ? (
        <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
          {note}
        </p>
      ) : null}
      {canWrite && adding ? (
        <HistoricalDoseForm
          itemId={itemId}
          itemName={itemName}
          doses={doseOptions}
          minDate={minDate}
          maxDate={maxDate}
          defaultTime={defaultTime}
          asNeeded={asNeeded}
          courseBound={courseBound}
          onDone={() => setAdding(false)}
        />
      ) : null}
      {history.length > 0 ? (
        <div className="mt-2">
          <EntryHistoryTable
            items={history}
            columns={columns}
            readOnly={!canWrite}
            menuLabel="Dose actions"
            rowTestId={() => "dose-history-row"}
            renderEditForm={(entry, done) => (
              <HistoricalDoseForm
                itemId={itemId}
                itemName={itemName}
                doses={doseOptions}
                minDate={minDate}
                maxDate={maxDate}
                defaultTime={defaultTime}
                asNeeded={asNeeded}
                courseBound={courseBound}
                editing={{
                  logId: entry.id,
                  doseId: entry.doseId,
                  date: entry.date,
                  statedAt: entry.statedAt,
                  amount: entry.amount,
                }}
                onDone={done}
              />
            )}
            confirmDelete={(entry) => ({
              title: "Delete dose?",
              message: `Remove the ${formatLongDate(
                entry.date,
                formatPrefs
              )} dose of ${itemName} from the record. You can undo this.`,
              confirmLabel: "Delete dose",
            })}
            deleteFormData={(entry) => {
              const fd = new FormData();
              fd.set("log_id", String(entry.id));
              return fd;
            }}
            deleteAction={deleteAdministration}
            deletedMessage="Dose deleted."
          />
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          No doses recorded yet.
        </p>
      )}
    </div>
  );
}
