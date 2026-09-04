"use client";

import { useState, type FormEvent } from "react";
import Combobox from "@/components/Combobox";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { SYMPTOM_SEVERITY_LEVELS, severityLabelFor } from "@/lib/symptoms";
import { editSymptom, logSymptom } from "@/app/(app)/symptom-actions";
import SubmitButton from "@/components/SubmitButton";

// THE SYMPTOM DOMAIN'S ONE FORM (#4424 ruling 1), named by
// `LOG_MANIFEST.symptom.pieces.form`. `row` absent posts the log core; `row` present
// seeds from that row and posts the correction core. ONE layout — the mode decides
// seed and action only, never which fields exist.
//
// NO DATE FIELD, IN EITHER MODE, and that is the store's shape rather than an
// omission: `symptom_logs` is UNIQUE(profile_id, date, symptom), so moving a
// symptom-day to another date is a delete plus a re-log, and `setSymptomSeverityCore`
// would silently upsert onto whatever day it was handed — merging two days' worst
// severities into one. The day rides in from the mount, which is standing on it.
//
// THE SYMPTOM IS HALF THE ROW'S ADDRESS, not a field a correction may move, so the
// picker collapses on the CHOICE LIST rather than on the mode: a mount that can choose
// hands several, one that cannot hands the row's own. Both modes therefore draw the
// same field set for the same list, which is what makes the seam assertable.
//
// SEVERITY IS THE DIFFERENCE BETWEEN THE TWO ACTIONS. `logSymptom` keeps the day's
// WORST (a tap only ever raises, #799); `editSymptom` SETS it exactly, which is what a
// correction has to be able to do — including downwards.
//
// THE SUBJECT IS OPTIONAL AND SPELLED ONCE (ruling 4): absent is the acting profile,
// present posts `profile_id` and is re-gated server-side.

export interface SymptomChoice {
  key: string;
  label: string;
}

export interface SymptomDayRow {
  symptom: string;
  date: string;
  severity: number;
  note: string | null;
}

export default function SymptomForm({
  symptoms,
  date,
  row,
  subjectProfileId,
  onSaved,
  onCancel,
}: {
  /** What this mount may write against. One entry collapses the picker. */
  symptoms: readonly SymptomChoice[];
  /** The day in hand (ruling 2). A seeded row's own date wins. */
  date: string;
  row?: SymptomDayRow;
  subjectProfileId?: number;
  /** The row as the write settled it — the SERVER's resolved key, not a guess. */
  onSaved: (saved: { symptom: string; severity: number; note: string }) => void;
  onCancel: () => void;
}) {
  // WHICH SURFACE THIS WRITE CAME FROM (#3087), read off the region: one form renders
  // in the bar's picker and on the record's rows, and the action cannot know which.
  const stampLoggedVia = useLoggedViaStamp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const only = symptoms.length === 1 ? symptoms[0] : undefined;
  const [severity, setSeverity] = useState(row?.severity ?? 1);
  // Free text is a first-class symptom (#1676), so the picker holds a LABEL and
  // `logSymptomCore` resolves it — which is also the one place a custom key may be
  // minted (#3325), so no mount guesses at the key the write will land on.
  const [typed, setTyped] = useState("");
  const key = row?.symptom ?? only?.key ?? typed;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const fd = stampLoggedVia(new FormData(event.currentTarget));
    fd.set("symptom", key);
    fd.set("severity", String(severity));
    fd.set("date", row?.date ?? date);
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
    setPending(true);
    let result;
    try {
      result = row ? await editSymptom(fd) : await logSymptom(fd);
    } catch {
      setPending(false);
      setError("Couldn't save that symptom.");
      return;
    }
    setPending(false);
    if (!result.ok) {
      setError(result.error || "Couldn't save that symptom.");
      return;
    }
    setError(null);
    onSaved({
      symptom: result.symptom,
      severity: result.severity,
      note: String(fd.get("note") ?? ""),
    });
  }

  return (
    <form
      className="grid gap-2 sm:grid-cols-2"
      onSubmit={(event) => void submit(event)}
    >
      {only ? null : (
        <div data-testid="symptom-form-picker">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Symptom
          </span>
          <div className="mt-1">
            <Combobox
              ariaLabel="Symptom"
              value={typed}
              onChange={setTyped}
              options={symptoms.map((choice) => choice.label)}
              allowFreeText
              closeStopsPropagation
              placeholder="Add another symptom…"
              inputClassName="h-8 text-sm"
            />
          </div>
        </div>
      )}
      <label className="text-xs text-slate-500 dark:text-slate-400">
        Severity
        <select
          data-testid="symptom-form-severity"
          value={severity}
          onChange={(event) => setSeverity(Number(event.target.value))}
          className="input mt-1 w-full"
        >
          {SYMPTOM_SEVERITY_LEVELS.map((level) => (
            <option key={level.value} value={level.value}>
              {severityLabelFor(key, level.value)}
            </option>
          ))}
        </select>
      </label>
      {/* Both cores store the note they are handed, so a form without this field would
          silently clear one somebody wrote. */}
      <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
        Note
        <input
          type="text"
          name="note"
          defaultValue={row?.note ?? ""}
          maxLength={500}
          placeholder="Note (e.g. worse at night)…"
          className="input mt-1 w-full"
        />
      </label>
      <InlineError>{error}</InlineError>
      <div className="flex items-end gap-2 sm:col-span-2">
        <SubmitButton
          data-testid="symptom-form-save"
          disabled={pending || key.trim() === ""}
        >
          {pending ? "Saving…" : row ? "Save" : "Add"}
        </SubmitButton>
        <button className="btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
