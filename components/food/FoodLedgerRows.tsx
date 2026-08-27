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
import { formatClockValue, formatLongDate } from "@/lib/format-date";
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

  const columns: EntryHistoryColumn<FoodLedgerEntry>[] = [
    {
      header: "Date",
      slot: "title",
      cellClassName: "font-medium text-slate-700 dark:text-slate-200",
      cell: (row) => formatLongDate(row.date, prefs),
    },
    {
      header: "Food",
      slot: "value",
      label: "Food",
      cell: (row) => row.groupName,
    },
    {
      header: "Meal",
      slot: "meta",
      label: "Meal",
      cell: (row) => row.mealSlot,
    },
    {
      // THE HEAD LINE'S RIGHT-HAND FACT (#3671): when a serving was eaten or logged
      // is the one attribute worth a phone row's trailing edge; the food group and
      // the meal are the labelled detail behind the tap.
      header: "Time",
      slot: "trailing",
      empty: (row) => !row.clock,
      cell: (row) =>
        row.clock
          ? `${row.clockKind === "eaten" ? "Ate" : "Logged"} ${formatClockValue(row.clock, prefs.timeFormat)}`
          : "—",
    },
  ];

  return (
    <EntryHistoryTable
      items={rows}
      columns={columns}
      readOnly={!canWrite}
      menuKind="Serving"
      menuItemName={(row) =>
        `${row.groupName}, ${formatLongDate(row.date, prefs)}`
      }
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
        message: `Remove ${row.groupName} from ${formatLongDate(row.date, prefs)}. You can undo this.`,
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
