"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import {
  logHistoricalDose,
  updateHistoricalDose,
} from "@/app/(app)/medications/actions";

export interface HistoricalDoseOption {
  id: number;
  label: string;
  amount: string | null;
}

export default function HistoricalDoseForm({
  itemId,
  medicationName,
  doses,
  minDate,
  maxDate,
  defaultTime,
  asNeeded,
  editing,
  onDone,
}: {
  itemId: number;
  medicationName: string;
  doses: HistoricalDoseOption[];
  minDate?: string;
  maxDate: string;
  defaultTime: string;
  asNeeded: boolean;
  editing?: {
    logId: number;
    doseId: number;
    date: string;
    time: string;
    amount: string | null;
  };
  onDone: () => void;
}) {
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
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
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
            ? `Updated dose of ${medicationName}.`
            : `Logged past dose of ${medicationName}.`
        );
        onDone();
        router.refresh();
      }}
      className="mt-3 space-y-3 border-y border-black/5 py-3 dark:border-white/5"
      data-testid="historical-dose-form"
    >
      <input type="hidden" name="id" value={itemId} />
      {editing ? (
        <input type="hidden" name="log_id" value={editing.logId} />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
        <div>
          <label className="label" htmlFor={`history-date-${itemId}`}>
            Date
          </label>
          <DateField
            id={`history-date-${itemId}`}
            name="date"
            defaultValue={editing?.date ?? maxDate}
            min={minDate}
            max={maxDate}
            required
            data-testid="historical-dose-date"
          />
        </div>
        <div>
          <label className="label" htmlFor={`history-time-${itemId}`}>
            Time taken
          </label>
          <input
            id={`history-time-${itemId}`}
            name="time"
            type="time"
            defaultValue={editing?.time ?? defaultTime}
            required
            className="input"
            data-testid="historical-dose-time"
          />
        </div>
      </div>

      {!editing ? (
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            name="adjust_supply"
            value="1"
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
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
              asNeeded
                ? "An earlier date will move the medication start date back to match."
                : "The date must remain within a medication course."
            }`
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
