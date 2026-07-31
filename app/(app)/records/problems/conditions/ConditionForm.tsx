"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import Combobox from "@/components/Combobox";
import {
  bestIcd10Suggestion,
  icd10CodeForName,
  icd10SearchTerms,
  ICD10_CONDITION_NAMES,
  ICD10_SYSTEM,
} from "@/lib/icd10";
import type { Condition, FormResult } from "@/lib/types";

// Shared add/edit condition form. Add mode: no `condition`. Edit mode: pass the
// row + an `onDone` callback. The resolved-date field only applies when the status
// is Resolved.
export default function ConditionForm({
  action,
  condition,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  condition?: Condition;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
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
  // The code THIS form applied from a catalog pick, so a later name edit can retract
  // it without ever touching a code the user typed or an import carried in. Mirrors
  // the medication form's rxcuiRef (components/intake/useIntakeRxcui).
  const pickedCode = useRef<string | null>(null);

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

  // An explicit PICK from the catalog applies that entry's code immediately — the
  // owner's ruling, mirroring how the medication form auto-confirms an RxNorm code
  // when a catalog med is chosen (`onPickName` → `rx.autoConfirm`, #851 item 7).
  // A pick is unambiguous by construction here: each catalog name carries exactly one
  // curated code, so there is no candidate list to disambiguate and nothing to
  // degrade to. TYPING is untouched — a typed name still offers the #155
  // confirm-to-apply chip and never writes a code on its own.
  function onPickName(picked: string) {
    const picked10 = icd10CodeForName(picked);
    if (!picked10) return; // free-text row: nothing curated to apply
    pickedCode.current = picked10;
    setCode(picked10);
    setCodeSystem(ICD10_SYSTEM);
  }

  // Editing the name away from the picked entry retracts the code the pick applied,
  // so the row can never claim a code for a concept it no longer names — the
  // medication form's `onNameChange` invalidation. A code the user typed, or one an
  // import carried in, is left alone: only this form's own pick is retractable.
  function onNameChange(next: string) {
    setName(next);
    if (pickedCode.current && code === pickedCode.current) {
      pickedCode.current = null;
      setCode("");
      setCodeSystem("");
    }
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
      pickedCode.current = null;
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
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      <div>
        <label className="label" htmlFor={`cond-name-${uid}`}>
          Condition
        </label>
        {/* The curated ICD-10-CM NAMES (#1676). suggestIcd10() has always ranked
            over them, but only the resulting CODE reached the UI — the names
            themselves were invisible, so a typed one-off spelling never became the
            catalog entry the code chip and lib/condition-codes' recognizers want.
            Synonyms ride along as hidden search terms, so "high blood pressure"
            still finds "Essential (primary) hypertension"; free text still saves. */}
        <Combobox
          id={`cond-name-${uid}`}
          name="name"
          ariaLabel="Condition"
          value={name}
          onChange={onNameChange}
          onPick={onPickName}
          options={[...ICD10_CONDITION_NAMES]}
          searchTermsFor={icd10SearchTerms}
          badgeFor={(option) => (
            <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
              {icd10CodeForName(option)}
            </span>
          )}
          allowFreeText
          placeholder="e.g. Asthma, Type 2 diabetes"
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
            placeholder="ICD-10 / SNOMED"
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
