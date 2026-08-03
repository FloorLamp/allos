"use client";

import { useState } from "react";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import { deleteAdministration } from "@/app/(app)/nutrition/supplement-actions";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatLongDate } from "@/lib/format-date";
import {
  formatMedicationDoseLine,
  formatMedicationDoseProduct,
} from "@/lib/medication-dose-format";

// One recorded administration as the panel renders it. `time` is the
// already-formatted profile-local clock string; `timeValue` is the HH:MM the edit
// form seeds its <input type="time"> with.
export interface DoseHistoryEntry {
  id: number;
  doseId: number;
  date: string;
  time: string;
  timeValue: string;
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
// Every action renders its core's typed outcome: the forms show the refusal text the
// action returned, and the delete goes through useUndoableDelete, which only offers
// Undo when the core actually handed back a token. Nothing here confirms
// unconditionally.
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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [menuId, setMenuId] = useState<number | null>(null);
  const undoable = useUndoableDelete();
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

  return (
    <div data-testid="dose-history">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="section-label">Dose history</span>
        {canWrite ? (
          <button
            type="button"
            onClick={() => {
              setEditingId(null);
              setAdding((value) => !value);
            }}
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
        <ul className="mt-2 divide-y divide-black/5 dark:divide-white/5">
          {history.map((entry) => (
            <li
              key={entry.id}
              data-testid="dose-history-row"
              className="py-2 first:pt-0 last:pb-0"
            >
              <div className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)_auto] items-center gap-x-3 text-sm text-slate-600 dark:text-slate-300">
                <span className="font-medium">
                  {formatLongDate(entry.date, formatPrefs)}
                </span>
                <span className="min-w-0 text-right text-xs text-slate-500 dark:text-slate-400">
                  {[
                    formatMedicationDoseProduct(entry.amount, entry.product),
                    entry.time,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {canWrite ? (
                  <OverflowMenu
                    label="Dose actions"
                    open={menuId === entry.id}
                    onOpenChange={(open) => setMenuId(open ? entry.id : null)}
                  >
                    {({ close }) => (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => {
                            setAdding(false);
                            setEditingId(entry.id);
                            close();
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM_DANGER}
                          onClick={async () => {
                            close();
                            const fd = new FormData();
                            fd.set("log_id", String(entry.id));
                            if (editingId === entry.id) setEditingId(null);
                            await undoable(deleteAdministration, fd, {
                              deletedMessage: "Dose deleted.",
                            });
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </OverflowMenu>
                ) : null}
              </div>
              {canWrite && editingId === entry.id ? (
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
                    time: entry.timeValue,
                    amount: entry.amount,
                  }}
                  onDone={() => setEditingId(null)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          No doses recorded yet.
        </p>
      )}
    </div>
  );
}
