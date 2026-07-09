"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import type { Condition } from "@/lib/types";

// Shared add/edit condition form. Add mode: no `condition`. Edit mode: pass the
// row + an `onDone` callback. The resolved-date field only applies when the status
// is Resolved.
export default function ConditionForm({
  action,
  condition,
  onDone,
}: {
  action: (formData: FormData) => Promise<void>;
  condition?: Condition;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!condition;
  const [status, setStatus] = useState(condition?.status ?? "active");
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("name") ?? "").trim()) {
      setError("Enter the condition name.");
      return;
    }
    try {
      await action(formData);
    } catch {
      setError("Couldn't save this condition. Please try again.");
      return;
    }
    toast(editing ? "Condition updated" : "Condition saved");
    if (!editing) {
      formRef.current?.reset();
      setStatus("active");
    }
    onDone?.();
    router.refresh();
  }

  const uid = condition?.id ?? "new";
  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add condition
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={condition!.id} />}
      <div>
        <label className="label" htmlFor={`cond-name-${uid}`}>
          Condition
        </label>
        <input
          id={`cond-name-${uid}`}
          name="name"
          className="input"
          defaultValue={condition?.name ?? ""}
          placeholder="e.g. Asthma, Type 2 diabetes"
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`cond-code-${uid}`}>
            Code
          </label>
          <input
            id={`cond-code-${uid}`}
            name="code"
            className="input"
            defaultValue={condition?.code ?? ""}
            placeholder="e.g. J45.909"
          />
        </div>
        <div>
          <label className="label" htmlFor={`cond-codesys-${uid}`}>
            Code system
          </label>
          <input
            id={`cond-codesys-${uid}`}
            name="code_system"
            className="input"
            defaultValue={condition?.code_system ?? ""}
            placeholder="ICD-10-CM / SNOMED CT"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`cond-status-${uid}`}>
            Status
          </label>
          <select
            id={`cond-status-${uid}`}
            name="status"
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`cond-onset-${uid}`}>
            Onset date
          </label>
          <DateField
            id={`cond-onset-${uid}`}
            name="onset_date"
            defaultValue={condition?.onset_date ?? ""}
          />
        </div>
      </div>
      {status === "resolved" && (
        <div>
          <label className="label" htmlFor={`cond-resolved-${uid}`}>
            Resolved date
          </label>
          <DateField
            id={`cond-resolved-${uid}`}
            name="resolved_date"
            defaultValue={condition?.resolved_date ?? ""}
          />
        </div>
      )}
      <div>
        <label className="label" htmlFor={`cond-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`cond-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={condition?.notes ?? ""}
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
