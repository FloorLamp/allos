"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import type { CareGoal, FormResult } from "@/lib/types";

// Shared add/edit care-goal form. Add mode: no `goal`. Edit mode: pass the row + an
// `onDone` callback (renders a hidden id + a Cancel button).
export default function CareGoalForm({
  action,
  goal,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  goal?: CareGoal;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!goal;
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("description") ?? "").trim()) {
      setError("Enter the goal.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this goal. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Goal updated" : "Goal saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = goal?.id ?? "new";
  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add health goal
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={goal!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      <div>
        <label className="label" htmlFor={`cg-desc-${uid}`}>
          Goal
        </label>
        <input
          id={`cg-desc-${uid}`}
          name="description"
          className="input"
          defaultValue={goal?.description ?? ""}
          placeholder="e.g. A1c below 7.0%, BP under 130/80"
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`cg-date-${uid}`}>
            Target date
          </label>
          <DateField
            id={`cg-date-${uid}`}
            name="target_date"
            defaultValue={goal?.target_date ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor={`cg-status-${uid}`}>
            Status
          </label>
          <input
            id={`cg-status-${uid}`}
            name="status"
            className="input"
            defaultValue={goal?.status ?? ""}
            placeholder="proposed / active / achieved"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`cg-code-${uid}`}>
            Code
          </label>
          <input
            id={`cg-code-${uid}`}
            name="code"
            className="input"
            defaultValue={goal?.code ?? ""}
            placeholder="e.g. 4548-4"
          />
        </div>
        <div>
          <label className="label" htmlFor={`cg-codesys-${uid}`}>
            Code system
          </label>
          <input
            id={`cg-codesys-${uid}`}
            name="code_system"
            className="input"
            defaultValue={goal?.code_system ?? ""}
            placeholder="LOINC / SNOMED CT"
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`cg-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`cg-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={goal?.notes ?? ""}
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
