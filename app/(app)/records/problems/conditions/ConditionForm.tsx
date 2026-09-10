"use client";

import { useMemo, useRef, useState } from "react";
import DateField from "@/components/DateField";
import Button from "@/components/Button";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import Combobox from "@/components/Combobox";
import { useAddEntryModalClose } from "@/components/AddEntryPanel";
import InlineError from "@/components/InlineError";
import {
  bestIcd10Suggestion,
  icd10CodeForName,
  icd10SearchTerms,
  ICD10_CONDITION_NAMES,
  ICD10_SYSTEM,
} from "@/lib/icd10";
import {
  CONDITION_LATERALITIES,
  CONDITION_SEVERITIES,
  type Condition,
  type FormResult,
} from "@/lib/types";

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
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
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
      closeEntryModal?.();
    }
    onDone?.();
  }

  const uid = condition?.id ?? "new";
  return (
    <form ref={formRef} action={handle} className="space-y-3">
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
            {/* Filling a field is not the form's commit, so it takes no rank
                (ruling 6, #4978). Measured rather than eyeballed: `text-xs`
                already matched the control box, and `py-0.5` never applied at
                all — the box's derived `padding-block` is unlayered and
                outranks a `@layer utilities` padding — so the rendered box is
                unchanged at 34px and only the side padding moves. */}
            <Button
              data-testid="icd10-suggestion-apply"
              onClick={applySuggestion}
            >
              Use code
            </Button>
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
      {/* Side / grade / stage (#1403). All optional: a condition that isn't sided or
          graded simply leaves them unstated — the app never guesses a side. The side
          matters most, because a sided condition is a distinct clinical entity
          (#482) and the problem-list label and dedupe key both read it. */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`cond-laterality-${uid}`}>
            Side
          </label>
          <select
            id={`cond-laterality-${uid}`}
            name="laterality"
            className="input"
            defaultValue={condition?.laterality ?? ""}
          >
            <option value="">Not stated</option>
            {CONDITION_LATERALITIES.map((l) => (
              <option key={l} value={l}>
                {l[0].toUpperCase() + l.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`cond-severity-${uid}`}>
            Severity
          </label>
          <select
            id={`cond-severity-${uid}`}
            name="severity"
            className="input"
            defaultValue={condition?.severity ?? ""}
          >
            <option value="">Not stated</option>
            {CONDITION_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`cond-stage-${uid}`}>
          Stage
        </label>
        <input
          id={`cond-stage-${uid}`}
          name="stage"
          className="input"
          defaultValue={condition?.stage ?? ""}
          placeholder="e.g. Stage IIIA, CKD stage 3b"
        />
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
      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="condition-form-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="condition-form-primary-action"
        >
          <SubmitButton pendingLabel="Saving…" variant="primary">
            {editing ? "Save" : "Add"}
          </SubmitButton>
        </div>
        {editing && onDone && (
          // Quiet beside the form's filled commit (ruling 6, #4978); the drop to
          // the control box's 12px ends the "Cancel larger than Add" inversion.
          <Button onClick={onDone}>Cancel</Button>
        )}
      </div>
    </form>
  );
}
