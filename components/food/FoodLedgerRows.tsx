"use client";

import { useState, type FormEvent } from "react";
import DateField from "@/components/DateField";
import EntryHistoryTable, {
  type EntryHistoryColumn,
} from "@/components/EntryHistoryTable";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useToast } from "@/components/Toast";
import {
  deleteFoodLogEvent,
  updateFoodLogEvent,
} from "@/app/(app)/nutrition/actions";
import { FOOD_GROUPS } from "@/lib/food-groups";
import { FOOD_SLOTS, type FoodSlot } from "@/lib/food-slot";
import { formatClockValue, formatWeekdayDate } from "@/lib/format-date";
import { foodLedgerOccurredAtPatch } from "@/lib/event-ledger";

export interface FoodLedgerEntry {
  id: number;
  groupKey: string;
  groupName: string;
  date: string;
  mealSlot: FoodSlot;
  clock: string | null;
  clockKind: "eaten" | "logged";
}

async function removeFoodServing(fd: FormData) {
  const outcome = await deleteFoodLogEvent(fd);
  return outcome.ok
    ? { undoId: outcome.undoId }
    : { undoId: null, error: outcome.error };
}

export default function FoodLedgerRows({
  rows,
  canWrite,
  maxDate,
}: {
  rows: FoodLedgerEntry[];
  canWrite: boolean;
  maxDate: string;
}) {
  const prefs = useFormatPrefs();
  const toast = useToast();
  const [pendingId, setPendingId] = useState<number | null>(null);

  async function submitEdit(
    event: FormEvent<HTMLFormElement>,
    row: FoodLedgerEntry,
    done: () => void
  ) {
    event.preventDefault();
    setPendingId(row.id);
    const fd = new FormData(event.currentTarget);
    fd.set("event_id", String(row.id));
    const occurredAt = foodLedgerOccurredAtPatch(
      row,
      String(fd.get("date") ?? "")
    );
    if (occurredAt) fd.set("occurred_at", occurredAt);
    const outcome = await updateFoodLogEvent(fd);
    setPendingId(null);
    if (!outcome.ok) {
      toast(outcome.error, { tone: "error" });
      return;
    }
    toast("Serving corrected.");
    done();
  }

  // WHEN A SERVING WAS EATEN OR LOGGED, AS ONE CELL — the dose ledger's grammar
  // (#3937), because this is the same defect: a clock on its own leaves every row's
  // day unnamed on a list that spans days, and `trailing` is one cell by
  // construction (lib/card-row.ts). The clock keeps its "Ate"/"Logged" word, which
  // is the distinction #2228 made this column carry.
  const whenCell = (row: FoodLedgerEntry): string => {
    const date = formatWeekdayDate(row.date, prefs);
    if (!row.clock) return date;
    const verb = row.clockKind === "eaten" ? "Ate" : "Logged";
    return `${date} · ${verb} ${formatClockValue(row.clock, prefs.timeFormat)}`;
  };

  const columns: EntryHistoryColumn<FoodLedgerEntry>[] = [
    {
      // IDENTITY IS THE FOOD AT THIS SCOPE (#3937). A day of servings differs by
      // what was eaten, not by the date every one of them shares.
      header: "Food",
      slot: "title",
      cellClassName: "font-medium text-slate-700 dark:text-slate-200",
      cell: (row) => row.groupName,
    },
    {
      header: "When",
      slot: "trailing",
      cellClassName: "whitespace-nowrap",
      cell: whenCell,
    },
    {
      header: "Meal",
      slot: "meta",
      label: "Meal",
      cell: (row) => row.mealSlot,
    },
  ];

  return (
    <EntryHistoryTable
      items={rows}
      columns={columns}
      readOnly={!canWrite}
      menuKind="Serving"
      // THE ⋯ NAMES THE ROW IT ACTS ON, AND NO TWO ROWS ALIKE (#2615): two servings
      // of one food on one day are told apart only by the clock, so the name carries
      // the whole when-cell rather than the date alone.
      menuItemName={(row) => `${row.groupName} — ${whenCell(row)}`}
      rowTestId={() => "food-ledger-row"}
      editTestId={() => "food-ledger-edit"}
      deleteTestId={() => "food-ledger-delete"}
      renderEditForm={(row, done) => (
        <form
          className="grid gap-2 sm:grid-cols-2"
          onSubmit={(event) => void submitEdit(event, row, done)}
        >
          <label className="text-xs text-slate-500 dark:text-slate-400">
            Date
            <DateField
              name="date"
              defaultValue={row.date}
              max={maxDate}
              required
              inputClassName="mt-1 w-full"
            />
          </label>
          <label className="text-xs text-slate-500 dark:text-slate-400">
            Food group
            <select
              name="group_key"
              defaultValue={row.groupKey}
              className="input mt-1 w-full"
            >
              {FOOD_GROUPS.map((group) => (
                <option key={group.slug} value={group.slug}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500 dark:text-slate-400">
            Meal
            <select
              name="meal_slot"
              defaultValue={row.mealSlot}
              className="input mt-1 w-full"
            >
              {FOOD_SLOTS.map((slot) => (
                <option key={slot}>{slot}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <button
              className="btn"
              type="submit"
              disabled={pendingId === row.id}
            >
              {pendingId === row.id ? "Saving…" : "Save"}
            </button>
            <button className="btn-ghost" type="button" onClick={done}>
              Cancel
            </button>
          </div>
        </form>
      )}
      confirmDelete={(row) => ({
        title: "Delete serving?",
        message: `Remove ${row.groupName} from ${formatWeekdayDate(row.date, prefs)}. You can undo this.`,
        confirmLabel: "Delete serving",
      })}
      deleteFormData={(row) => {
        const fd = new FormData();
        fd.set("event_id", String(row.id));
        return fd;
      }}
      deleteAction={removeFoodServing}
      deletedMessage="Serving removed"
      onDeleteError={() =>
        toast("Couldn't remove that serving.", { tone: "error" })
      }
    />
  );
}
