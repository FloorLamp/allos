"use client";

import { useState, type FormEvent } from "react";
import DateField from "@/components/DateField";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useToast } from "@/components/Toast";
import { MAX_SUBSTANCE_ENTRY_AMOUNT, substanceDef } from "@/lib/substance-use";
import {
  addSubstanceDailyTotalAction,
  updateSubstanceDailyTotalAction,
} from "@/app/(app)/medical/substance-use/actions";

// THE SUBSTANCE DOMAIN'S ONE FORM (#4424 ruling 1), named by
// `LOG_MANIFEST.substance.pieces.form`, replacing the `/history` add door's spelling,
// that record row's correction and the substance card's add/edit pair. `row` absent
// posts the log action; `row` present seeds from that row and posts the correction
// action under its core's bounds. ONE layout — the mode decides seed and action only.
//
// THE AMOUNT CARRIES ITS UNIT (#4211, absorbed here): "Amount" alone means standard
// drinks on one row and uses on the next.
//
// THE SUBSTANCE IS PART OF THE ROW'S ADDRESS, not a field a correction may move —
// `updateSubstanceDailyTotalCore` finds its row by (id, profile, substance) — so a
// mount that can choose hands the list, one that cannot hands a single entry and its
// picker collapses away. The key posts from state either way.
//
// THE SUBJECT IS OPTIONAL AND SPELLED ONCE (ruling 4): absent is the acting profile,
// present posts `profile_id` and is re-gated by `gateItemProfile`.

export interface SubstanceChoice {
  key: string;
  label: string;
}

export interface SubstanceEntryRow {
  id: number;
  substance: string;
  date: string;
  amount: number;
  notes: string | null;
}

export default function SubstanceForm({
  substances,
  date,
  maxDate,
  row,
  subjectProfileId,
  onSaved,
  onCancel,
  testId,
}: {
  /** What this mount may write against. One entry collapses the picker. */
  substances: readonly SubstanceChoice[];
  /** The day in hand (ruling 2). A seeded row's own date wins. */
  date: string;
  maxDate: string;
  row?: SubstanceEntryRow;
  subjectProfileId?: number;
  onSaved: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const toast = useToast();
  // WHICH SURFACE THIS WRITE CAME FROM (#3087), read off the region: one form renders
  // on the record, in the card's modal and in a row, and the action cannot know which.
  const stampLoggedVia = useLoggedViaStamp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [substance, setSubstance] = useState(
    row?.substance ?? substances[0]?.key ?? ""
  );
  const unit = substanceDef(substance).unitPlural;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const fd = stampLoggedVia(new FormData(event.currentTarget));
    fd.set("substance", substance);
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
    if (row) fd.set("id", String(row.id));
    setPending(true);
    let result;
    try {
      result = row
        ? await updateSubstanceDailyTotalAction(fd)
        : await addSubstanceDailyTotalAction(fd);
    } catch {
      setPending(false);
      setError("Couldn't save that entry.");
      return;
    }
    setPending(false);
    if (result.kind !== "added" && result.kind !== "updated") {
      setError(refusal(result.kind));
      return;
    }
    setError(null);
    // THE CAP VERDICT RIDES THE SAVE, at every mount (#998/#3279): the tap surfaces
    // render it beside the button and the form surfaces had no readout at all. Derived
    // by the action AFTER the write, and null for a profile that set no cap.
    toast(
      [row ? "Corrected." : "Added to the record.", result.capProgress]
        .filter(Boolean)
        .join(" ")
    );
    onSaved();
  }

  return (
    <form
      className="grid gap-2 sm:grid-cols-2"
      onSubmit={(event) => void submit(event)}
      data-testid={testId}
    >
      {substances.length > 1 ? (
        <label className="text-xs text-slate-500 dark:text-slate-400">
          Substance
          <select
            className="input mt-1 w-full"
            value={substance}
            onChange={(event) => setSubstance(event.target.value)}
          >
            {substances.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="text-xs text-slate-500 dark:text-slate-400">
        Date
        <DateField
          name="date"
          defaultValue={row?.date ?? date}
          max={maxDate}
          required
          inputClassName="mt-1 w-full"
        />
      </label>
      <label className="text-xs text-slate-500 dark:text-slate-400">
        {`Amount (${unit})`}
        <input
          type="number"
          name="amount"
          min={1}
          max={MAX_SUBSTANCE_ENTRY_AMOUNT}
          step={1}
          defaultValue={row?.amount ?? 1}
          required
          className="input mt-1 w-full"
        />
      </label>
      {/* The action stores what it reads, so a form without this field would silently
          clear a note somebody wrote. */}
      <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
        Notes
        <textarea
          name="notes"
          rows={2}
          defaultValue={row?.notes ?? ""}
          className="input mt-1 w-full"
        />
      </label>
      <InlineError>{error}</InlineError>
      <div className="flex items-end gap-2 sm:col-span-2">
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Saving…" : row ? "Save" : "Add"}
        </button>
        <button className="btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// The refusals both modes reach: one copy, because both post through `historyInput`.
const REFUSALS: Record<string, string> = {
  "invalid-date": "Enter a valid date.",
  "invalid-amount": `Enter an amount between 1 and ${MAX_SUBSTANCE_ENTRY_AMOUNT}.`,
  "date-conflict": "An entry already exists for that date. Edit it instead.",
};
const refusal = (kind: string) => REFUSALS[kind] ?? "Couldn't save that entry.";
