"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { FLOW_LEVELS, FLOW_LABELS, type CyclePeriod } from "@/lib/cycle";
import type { CycleCreateResult } from "./actions";

// Add / edit a recorded period (issue #714). Explicit submit (records are NOT
// autosave-on-blur — #794). Add mode: no `period`. Edit mode: pass the row + `onDone`.
export default function CycleForm({
  action,
  period,
  onDone,
}: {
  action: (formData: FormData) => Promise<CycleCreateResult>;
  period?: CyclePeriod;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!period;
  const [error, setError] = useState<string | null>(null);
  const uid = period?.id ?? "new";

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("period_start") ?? "").trim()) {
      setError("Enter the period start date.");
      return;
    }
    let result: CycleCreateResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this period. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Period updated" : "Period saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  return (
    <form
      ref={formRef}
      action={handle}
      className="card space-y-3"
      data-testid={editing ? `cycle-edit-form-${uid}` : "cycle-add-form"}
    >
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Log a period
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={period!.id} />}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`cycle-start-${uid}`}>
            Period start
          </label>
          <DateField
            id={`cycle-start-${uid}`}
            name="period_start"
            defaultValue={period?.period_start ?? ""}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor={`cycle-end-${uid}`}>
            Period end (optional)
          </label>
          <DateField
            id={`cycle-end-${uid}`}
            name="period_end"
            defaultValue={period?.period_end ?? ""}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`cycle-flow-${uid}`}>
          Flow (optional)
        </label>
        <select
          id={`cycle-flow-${uid}`}
          name="flow"
          className="input"
          defaultValue={period?.flow ?? ""}
        >
          <option value="">—</option>
          {FLOW_LEVELS.map((f) => (
            <option key={f} value={f}>
              {FLOW_LABELS[f]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`cycle-note-${uid}`}>
          Note (optional)
        </label>
        <input
          id={`cycle-note-${uid}`}
          name="note"
          className="input"
          defaultValue={period?.note ?? ""}
          placeholder="e.g. cramps day 1"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <SubmitButton className="btn w-full" pendingLabel="Saving…">
          {editing ? "Save" : "Add period"}
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
