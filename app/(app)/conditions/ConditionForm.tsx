"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { bestIcd10Suggestion, ICD10_SYSTEM } from "@/lib/icd10";
import type { Condition, FormResult } from "@/lib/types";

// Shared add/edit condition form. Add mode: no `condition`. Edit mode: pass the
// row + an `onDone` callback. The resolved-date field only applies when the status
// is Resolved.
export default function ConditionForm({
  action,
  condition,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  condition?: Condition;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!condition;
  const [status, setStatus] = useState(condition?.status ?? "active");
  const [error, setError] = useState<string | null>(null);
  // Controlled so the ICD-10-CM suggestion can read the name and, on confirm, fill
  // the code/code-system fields (issue #155).
  const [name, setName] = useState(condition?.name ?? "");
  const [code, setCode] = useState(condition?.code ?? "");
  const [codeSystem, setCodeSystem] = useState(condition?.code_system ?? "");

  // Best-effort code suggestion for a code-LESS condition. Only when no code is
  // already present (imported/coded rows keep theirs — never overwritten) and the
  // suggested code differs from what's typed.
  const suggestion = useMemo(() => {
    if (code.trim()) return null;
    return bestIcd10Suggestion(name);
  }, [name, code]);

  function applySuggestion() {
    if (!suggestion) return;
    setCode(suggestion.code);
    setCodeSystem(ICD10_SYSTEM);
  }

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("name") ?? "").trim()) {
      setError("Enter the condition name.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this condition. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Condition updated" : "Condition saved");
    if (!editing) {
      formRef.current?.reset();
      setStatus("active");
      setName("");
      setCode("");
      setCodeSystem("");
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
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Asthma, Type 2 diabetes"
          required
        />
        {suggestion && (
          <div
            data-testid="icd10-suggestion"
            className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
          >
            <span>
              Suggested code{" "}
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {suggestion.code}
              </span>{" "}
              ({ICD10_SYSTEM})
            </span>
            <button
              type="button"
              data-testid="icd10-suggestion-apply"
              className="btn-ghost px-2 py-0.5 text-xs"
              onClick={applySuggestion}
            >
              Use code
            </button>
          </div>
        )}
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
            value={code}
            onChange={(e) => setCode(e.target.value)}
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
            value={codeSystem}
            onChange={(e) => setCodeSystem(e.target.value)}
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
