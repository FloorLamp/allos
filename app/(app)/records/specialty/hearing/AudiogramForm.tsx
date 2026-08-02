"use client";

import { useRef, useState } from "react";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { useAddEntryModalClose } from "@/components/AddEntryPanel";
import {
  AUDIOGRAM_EARS,
  AUDIOGRAM_FREQUENCIES_HZ,
  audiogramFieldName,
  earLabel,
  frequencyLabel,
  NORMAL_THRESHOLD_DB_HL,
} from "@/lib/audiogram";
import type { FormResult } from "@/lib/types";

// Manual audiogram entry (issue #1600) — the entry surface hearing was missing. One
// dated hearing test: a pure-tone air-conduction threshold in dB HL per ear per test
// frequency, transcribed off the audiologist's report. Twelve fields, all optional
// (a blank is "not tested", which is honest and common — a screening audiogram often
// skips 250 Hz), with the date required.
//
// The grid is frequency-per-ROW rather than per-column so it reads the way the printed
// report does and so the two ears sit side by side for comparison. Every input carries
// its own label naming both ear and frequency, so the form is usable without sight of
// the column header.
//
// Manual FIRST by design: mapping CCD/FHIR audiometry is explicitly a later change
// (#1600), and the store this writes into (canonical `vitals` medical_records rows) is
// the same one an importer will land on, so nothing here has to be redone for it.
export default function AudiogramForm({
  action,
  defaultDate,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  defaultDate: string;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this hearing test. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast("Hearing test saved");
    formRef.current?.reset();
    closeEntryModal?.();
  }

  return (
    <form
      ref={formRef}
      action={handle}
      className="space-y-3"
      data-testid="audiogram-form"
    >
      <div>
        <label className="label" htmlFor="audiogram-date">
          Test date
        </label>
        <DateField id="audiogram-date" name="date" defaultValue={defaultDate} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs font-medium text-slate-500 dark:text-slate-400">
              <th scope="col" className="w-24 py-1 text-left">
                Frequency
              </th>
              {AUDIOGRAM_EARS.map((ear) => (
                <th key={ear} scope="col" className="py-1 text-left capitalize">
                  {earLabel(ear)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AUDIOGRAM_FREQUENCIES_HZ.map((hz) => (
              <tr key={hz}>
                <th
                  scope="row"
                  className="py-1 pr-2 text-left text-xs font-medium text-slate-600 dark:text-slate-300"
                >
                  {frequencyLabel(hz)}
                </th>
                {AUDIOGRAM_EARS.map((ear) => {
                  const field = audiogramFieldName(ear, hz);
                  return (
                    <td key={ear} className="py-1 pr-2">
                      <label className="sr-only" htmlFor={`audiogram-${field}`}>
                        {`${earLabel(ear)} ${frequencyLabel(hz)} threshold (dB HL)`}
                      </label>
                      <input
                        id={`audiogram-${field}`}
                        name={field}
                        className="input"
                        inputMode="numeric"
                        placeholder="dB HL"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Thresholds in decibels hearing level (dB HL) — the quietest tone each
        ear heard. Lower is better; {NORMAL_THRESHOLD_DB_HL} dB HL or less is
        the normal band. Leave a frequency blank if it wasn&apos;t tested.
      </p>

      <div>
        <label className="label" htmlFor="audiogram-notes">
          Notes
        </label>
        <input
          id="audiogram-notes"
          name="notes"
          className="input"
          placeholder="e.g. annual monitoring audiogram, masked"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <SubmitButton className="btn w-full" pendingLabel="Saving…">
        Add
      </SubmitButton>
    </form>
  );
}
