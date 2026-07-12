"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import type { Allergy, FormResult } from "@/lib/types";

// Shared add/edit allergy form. Add mode: no `allergy`. Edit mode: pass the row +
// an `onDone` callback (renders a hidden id and a Cancel button).
export default function AllergyForm({
  action,
  allergy,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  allergy?: Allergy;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!allergy;
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("substance") ?? "").trim()) {
      setError("Enter the substance you're allergic to.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this allergy. Please try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Allergy updated" : "Allergy saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = allergy?.id ?? "new";
  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add allergy
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={allergy!.id} />}
      <div>
        <label className="label" htmlFor={`allergy-substance-${uid}`}>
          Substance
        </label>
        <input
          id={`allergy-substance-${uid}`}
          name="substance"
          className="input"
          defaultValue={allergy?.substance ?? ""}
          placeholder="e.g. Penicillin, Peanut, Latex"
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`allergy-reaction-${uid}`}>
            Reaction
          </label>
          <input
            id={`allergy-reaction-${uid}`}
            name="reaction"
            className="input"
            defaultValue={allergy?.reaction ?? ""}
            placeholder="e.g. Hives, Anaphylaxis"
          />
        </div>
        <div>
          <label className="label" htmlFor={`allergy-severity-${uid}`}>
            Severity
          </label>
          <input
            id={`allergy-severity-${uid}`}
            name="severity"
            className="input"
            defaultValue={allergy?.severity ?? ""}
            placeholder="Mild / Moderate / Severe"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`allergy-status-${uid}`}>
            Status
          </label>
          <select
            id={`allergy-status-${uid}`}
            name="status"
            className="input"
            defaultValue={allergy?.status ?? "active"}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`allergy-onset-${uid}`}>
            Onset date
          </label>
          <DateField
            id={`allergy-onset-${uid}`}
            name="onset_date"
            defaultValue={allergy?.onset_date ?? ""}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`allergy-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`allergy-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={allergy?.notes ?? ""}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <SubmitButton className="btn w-full" pendingLabel="Saving…">
          {editing ? "Save" : "Add"}
        </SubmitButton>
        {editing && onDone && (
          <button type="button" className="btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
