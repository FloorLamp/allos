"use client";

import { useState, type FormEvent } from "react";
import DateField from "@/components/DateField";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useToast } from "@/components/Toast";
import {
  MAX_SUBSTANCE_ENTRY_AMOUNT,
  substanceDef,
} from "@/lib/substance-use";
import {
  addSubstanceDailyTotalAction,
  updateSubstanceDailyTotalAction,
} from "@/app/(app)/medical/substance-use/actions";

// THE SUBSTANCE DOMAIN'S ONE FORM (#4424 ruling 1), serving ADD and FULL-STATEMENT
// EDIT. It replaces three spellings — the `/history` add door's own, the record row's
// correction, and the substance card's add/edit pair — and it is what
// `LOG_MANIFEST.substance.pieces.form` names, so a mount that reached for a deleted
// spelling fails `tsc` rather than a census test.
//
// ONE LAYOUT, TWO MODES. `row` absent posts `addSubstanceDailyTotalCore`'s action;
// `row` present seeds every field from that row and posts the correction action under
// that core's own bounds and audit. There is no second form: the fields below are
// rendered once and the mode decides only the SEED and the ACTION.
//
// THE AMOUNT CARRIES ITS UNIT (#4211, absorbed by #4424). The door's copy asked for a
// bare "Amount", which on a nicotine row means uses and on an alcohol row means
// standard drinks — the same number meaning two things. The label names the substance's
// own unit word, so deleting `unitPlural` from it is a visible change and not a
// cosmetic one.
//
// THE SUBSTANCE IS PART OF THE ROW'S ADDRESS, not a field a correction may move:
// `updateSubstanceDailyTotalCore` finds its row by (id, profile, substance), so an edit
// offers exactly the substance it was seeded with. A mount that can choose (the record's
// add door, where a profile tracks several) hands the whole list; a mount that cannot
// hands one and the picker collapses away rather than rendering a select with a single
// option — the door's own "a picker with nothing to pick is worse than no control"
// rule. Either way the key is posted from state, so the wire shape is identical.
//
// THE SUBJECT IS OPTIONAL AND SPELLED ONCE (ruling 4): absent means the acting profile,
// present posts `profile_id` and is re-gated server-side by `gateItemProfile`. The form
// never relaxes a gate; it only names who the row belongs to.

export interface SubstanceChoice {
  key: string;
  label: string;
}

/** The row a full-statement edit is seeded from and posts back to. */
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
  /** Absent: add. Present: edit, seeded from the row. */
  row?: SubstanceEntryRow;
  /** Absent: the acting profile. Present: re-gated server-side. */
  subjectProfileId?: number;
  onSaved: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const toast = useToast();
  // WHICH SURFACE THIS WRITE CAME FROM (#3087), read off the region rather than
  // asserted here: the same form renders on the record, in the card's modal and in a
  // row's disclosure, and the action cannot know which.
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
    // THE CAP VERDICT RIDES THE SAVE, at every mount (#998/#3279). The tap surfaces
    // render it beside the button; the form surfaces had no readout at all, so a
    // correction that took somebody over their weekly cap said nothing anywhere. The
    // action derives it after the write, so what is announced is the state the write
    // actually produced — and a profile with no cap has none, and hears nothing.
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
          clear a note the person wrote — the rewrite-everything contract the record's
          other correction forms carry. */}
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

// The refusals the two cores answer with, in the person's words. One copy for both
// modes, because both post through `historyInput` and reach the same outcomes.
function refusal(kind: string): string {
  if (kind === "invalid-date") return "Enter a valid date.";
  if (kind === "invalid-amount")
    return `Enter an amount between 1 and ${MAX_SUBSTANCE_ENTRY_AMOUNT}.`;
  if (kind === "date-conflict")
    return "An entry already exists for that date. Edit it instead.";
  return "Couldn't save that entry.";
}
