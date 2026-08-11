"use client";

import { useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { useTimezone } from "@/components/TimezoneProvider";
import { statedHhmm, statedInstantOnDate } from "@/lib/stated-time";
import {
  logHistoricalDose,
  updateHistoricalDose,
} from "@/app/(app)/nutrition/supplement-actions";

export interface HistoricalDoseOption {
  id: number;
  label: string;
  amount: string | null;
}

// Backfill / amend one recorded dose. Shared by both intake surfaces since #1933, so
// its copy names the ITEM, not "the medication": the only medication-specific rule
// left is the course window, which only an item that HAS courses is bound by
// (`courseBound`).
//
// The date+time pair renders through the shared WhenControl (#2236 / #2228):
//
//   • BACKFILL is `state` mode with the time REQUIRED (decision 2): logging a past
//     dose is a new assertion that a dose happened, and naming when is the point.
//     The time still prefills from `defaultTime` so it costs no taps.
//   • AMEND is `correct` mode: "Not stated" is reachable and submits an empty time,
//     which the write path records as occurred_at = NULL — amending only the amount
//     of a dose whose intake time was never stated changes the amount and nothing
//     else. The time seeds from `editing.statedAt` (the row's occurred_at), NEVER
//     from the recorded_at/taken_at record chain — a row with no stated intake time
//     opens with an EMPTY time field instead of laundering a filing timestamp into
//     an administration time (#2228's defect).
//
// The wire stays date + "HH:MM" (hidden inputs kept in sync with the pair): the
// action re-anchors the wall time against the submitted date in the profile's
// timezone, and the core enforces the pair rule again at the boundary.
export default function HistoricalDoseForm({
  itemId,
  itemName,
  doses,
  minDate,
  maxDate,
  defaultTime,
  asNeeded,
  courseBound = true,
  editing,
  onDone,
}: {
  itemId: number;
  itemName: string;
  doses: HistoricalDoseOption[];
  minDate?: string;
  maxDate: string;
  defaultTime: string;
  asNeeded: boolean;
  // Whether this item's history is bounded by a medication course. False for an item
  // that keeps no courses (every supplement), whose backfill may reach any past date.
  courseBound?: boolean;
  editing?: {
    logId: number;
    doseId: number;
    date: string;
    // The row's stated event instant (occurred_at, ISO UTC), or null = no intake
    // time was ever stated. Never a record-chain fallback.
    statedAt: string | null;
    amount: string | null;
  };
  onDone: () => void;
}) {
  const tz = useTimezone();
  const first = doses[0];
  const initialDose = editing
    ? (doses.find((dose) => dose.id === editing.doseId) ?? {
        id: editing.doseId,
        label: "Recorded dose",
        amount: editing.amount,
      })
    : first;
  const [doseId, setDoseId] = useState(initialDose?.id ?? 0);
  const [amount, setAmount] = useState(
    editing?.amount ?? initialDose?.amount ?? ""
  );
  const [when, setWhen] = useState<WhenValue>(() =>
    editing
      ? { date: editing.date, statedAt: editing.statedAt }
      : {
          date: maxDate,
          statedAt:
            statedInstantOnDate(maxDate, defaultTime, tz)?.toISOString() ??
            null,
        }
  );
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  if (!initialDose) return null;

  return (
    <form
      action={async (formData) => {
        setError(null);
        const result = editing
          ? await updateHistoricalDose(formData)
          : await logHistoricalDose(formData);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        toast(
          editing
            ? `Updated dose of ${itemName}.`
            : `Logged past dose of ${itemName}.`
        );
        onDone();
      }}
      className="mt-3 space-y-3 border-y border-black/5 py-3 dark:border-white/5"
      data-testid="historical-dose-form"
    >
      <input type="hidden" name="id" value={itemId} />
      {editing ? (
        <input type="hidden" name="log_id" value={editing.logId} />
      ) : null}
      <input type="hidden" name="date" value={when.date} />
      <input type="hidden" name="time" value={statedHhmm(when.statedAt, tz)} />
      <div className="grid gap-3 sm:grid-cols-2">
        {!editing && doses.length > 1 ? (
          <div>
            <label className="label" htmlFor={`history-dose-${itemId}`}>
              {asNeeded ? "Dose" : "Scheduled dose"}
            </label>
            <select
              id={`history-dose-${itemId}`}
              name="dose_id"
              className="input"
              value={doseId}
              onChange={(event) => {
                const nextId = Number(event.target.value);
                setDoseId(nextId);
                setAmount(
                  doses.find((dose) => dose.id === nextId)?.amount ?? ""
                );
              }}
            >
              {doses.map((dose) => (
                <option key={dose.id} value={dose.id}>
                  {dose.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <input type="hidden" name="dose_id" value={doseId} />
        )}
        <div>
          <label className="label" htmlFor={`history-amount-${itemId}`}>
            Amount
          </label>
          <input
            id={`history-amount-${itemId}`}
            name="amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="input"
            placeholder="e.g. 5 mg"
          />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Taken</span>
          <WhenControl
            mode={editing ? "correct" : "state"}
            grain="minute"
            value={when}
            onChange={setWhen}
            timeRequired={!editing}
            minDate={minDate}
            maxDate={maxDate}
            dateLabel="Date"
            timeLabel="Time taken"
            testId="historical-dose"
          />
        </div>
      </div>

      {!editing ? (
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            name="adjust_supply"
            value="1"
            className="mt-0.5 h-4 w-4 rounded-sm border-slate-300 text-brand-600 dark:border-slate-600"
          />
          <span>
            Adjust current supply
            <span className="mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400">
              Subtract this dose from units on hand. Leave off if inventory has
              since been reconciled.
            </span>
          </span>
        </label>
      ) : null}

      <p className="text-xs text-slate-500 dark:text-slate-400">
        {editing
          ? `Changing this record won’t change current supply. ${
              !courseBound
                ? "It won’t change the schedule either."
                : asNeeded
                  ? "An earlier date will move the medication start date back to match."
                  : "The date must remain within a medication course."
            }`
          : !courseBound
            ? "Choose any past date that isn’t in the future. This updates adherence history for that date and won’t change the schedule."
            : asNeeded
              ? "Choose any past date. If it is before the current start date, the start date will move back to match. This records a separate administration in dose history."
              : "The date must fall within a medication course and cannot be in the future. This updates adherence history for that date."}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <SubmitButton pendingLabel="Saving…" className="btn btn-sm">
          {editing ? "Save changes" : "Save dose"}
        </SubmitButton>
        <button type="button" onClick={onDone} className="btn-ghost btn-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
