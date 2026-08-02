"use client";

import { useRef, useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import Combobox from "@/components/Combobox";
import { useToast } from "@/components/Toast";
import { useAddEntryModalClose } from "@/components/AddEntryPanel";
import {
  icd10CodeForName,
  icd10SearchTerms,
  ICD10_CONDITION_NAMES,
  ICD10_SYSTEM,
} from "@/lib/icd10";
import {
  FAMILY_LINEAGES,
  type FamilyHistory,
  type FormResult,
} from "@/lib/types";

// Common relatives, offered as a pick-or-type Combobox (allowFreeText).
const RELATIONS = [
  "Mother",
  "Father",
  "Sister",
  "Brother",
  "Sibling",
  "Daughter",
  "Son",
  "Maternal grandmother",
  "Maternal grandfather",
  "Paternal grandmother",
  "Paternal grandfather",
  "Aunt",
  "Uncle",
  "Cousin",
];

// Shared add/edit family-history form. Add mode: no `entry`. Edit mode: pass the row
// + an `onDone` callback (renders a hidden id + a Cancel button). Condition is
// required; relation is a pick-or-type input.
export default function FamilyHistoryForm({
  action,
  entry,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  entry?: FamilyHistory;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!entry;
  const [error, setError] = useState<string | null>(null);
  // Relation is a controlled Combobox (#1177) — form.reset() can't clear it, so the
  // add path clears this state explicitly on a successful save.
  const [relation, setRelation] = useState(entry?.relation ?? "");
  // Condition draws on the SAME curated ICD-10-CM vocabulary the conditions form
  // does (#1676) — lib/condition-codes' recognizers read family-history names too,
  // and this field previously offered no suggestion at all.
  const [condition, setCondition] = useState(entry?.condition ?? "");
  // Code and code system are controlled so a catalog PICK can fill them, per the
  // owner's ruling that a pick applies its code the way the medication form's
  // RxNorm confirm does. Same picker, same two fields, same behaviour as
  // ConditionForm — the ruling is about the pick, not about which form it is in.
  const [code, setCode] = useState(entry?.code ?? "");
  const [codeSystem, setCodeSystem] = useState(entry?.code_system ?? "");
  // The code THIS form applied from a pick, so a later name edit can retract it
  // without ever touching a code the user typed or an import carried in
  // (ConditionForm's pickedCode, itself the medication form's rxcuiRef).
  const pickedCode = useRef<string | null>(null);

  // An explicit pick applies that entry's curated code immediately. Nothing here
  // fires for typed text: unlike the conditions form, family history has no
  // confirm-to-apply chip, so a typed condition simply carries no code — exactly as
  // it did before.
  function onPickCondition(picked: string) {
    const picked10 = icd10CodeForName(picked);
    if (!picked10) return; // free-text row: nothing curated to apply
    pickedCode.current = picked10;
    setCode(picked10);
    setCodeSystem(ICD10_SYSTEM);
  }

  // Editing the condition away from the picked entry retracts the code the pick
  // applied — and only that code.
  function onConditionChange(next: string) {
    setCondition(next);
    if (pickedCode.current && code === pickedCode.current) {
      pickedCode.current = null;
      setCode("");
      setCodeSystem("");
    }
  }

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("condition") ?? "").trim()) {
      setError("Enter the condition.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this entry. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Family history updated" : "Family history saved");
    if (!editing) {
      formRef.current?.reset();
      setRelation("");
      setCondition("");
      setCode("");
      setCodeSystem("");
      pickedCode.current = null;
      closeEntryModal?.();
    }
    onDone?.();
  }

  const uid = entry?.id ?? "new";
  return (
    <form ref={formRef} action={handle} className="space-y-3">
      {editing && <input type="hidden" name="id" value={entry!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      <div>
        <label className="label" htmlFor={`fh-relation-${uid}`}>
          Relative
        </label>
        <Combobox
          id={`fh-relation-${uid}`}
          name="relation"
          ariaLabel="Relative"
          value={relation}
          onChange={setRelation}
          options={RELATIONS}
          allowFreeText
          placeholder="e.g. Mother, Father, Sibling"
        />
      </div>
      <div>
        <label className="label" htmlFor={`fh-condition-${uid}`}>
          Condition
        </label>
        <Combobox
          id={`fh-condition-${uid}`}
          name="condition"
          ariaLabel="Condition"
          value={condition}
          onChange={onConditionChange}
          onPick={onPickCondition}
          options={[...ICD10_CONDITION_NAMES]}
          searchTermsFor={icd10SearchTerms}
          badgeFor={(option) => (
            <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
              {icd10CodeForName(option)}
            </span>
          )}
          allowFreeText
          placeholder="e.g. Type 2 diabetes, Breast cancer"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`fh-code-${uid}`}>
            Code
          </label>
          <input
            id={`fh-code-${uid}`}
            name="code"
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. E11.9"
          />
        </div>
        <div>
          <label className="label" htmlFor={`fh-codesys-${uid}`}>
            Code system
          </label>
          <input
            id={`fh-codesys-${uid}`}
            name="code_system"
            className="input"
            value={codeSystem}
            onChange={(e) => setCodeSystem(e.target.value)}
            placeholder="SNOMED CT / ICD-10"
          />
        </div>
      </div>
      {/* The genetic axis (#1407). A genetic-risk read that treats an ADOPTED
          parent's history as hereditary is wrong, so the discriminator is a stated
          fact here — left unstated it reads as genetic, which is what every row
          written before this field meant. */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`fh-relation-type-${uid}`}>
            Relationship
          </label>
          <select
            id={`fh-relation-type-${uid}`}
            name="relation_type"
            className="input"
            defaultValue={entry?.relation_type ?? ""}
          >
            <option value="">Not stated (genetic)</option>
            <option value="genetic">Genetic (biological)</option>
            <option value="half">Half sibling</option>
            <option value="adopted">Adopted — not genetic</option>
            <option value="step">Step — not genetic</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`fh-lineage-${uid}`}>
            Family side
          </label>
          <select
            id={`fh-lineage-${uid}`}
            name="lineage"
            className="input"
            defaultValue={entry?.lineage ?? ""}
          >
            <option value="">Not stated</option>
            {FAMILY_LINEAGES.map((l) => (
              <option key={l} value={l}>
                {l[0].toUpperCase() + l.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 items-end gap-3">
        <div>
          <label className="label" htmlFor={`fh-age-${uid}`}>
            Age at onset
          </label>
          <input
            id={`fh-age-${uid}`}
            name="onset_age"
            type="number"
            min={0}
            max={130}
            className="input"
            defaultValue={entry?.onset_age ?? ""}
            placeholder="years"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            name="deceased"
            type="checkbox"
            defaultChecked={entry?.deceased === 1}
            className="h-4 w-4"
          />
          Deceased
        </label>
      </div>
      {/* Age and cause of death (#1407) — "father, MI at 52" is precisely what the
          screening-cadence logic keys on, and neither half had a home before this.
          Filling either states the death, so the checkbox above follows them. */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`fh-age-death-${uid}`}>
            Age at death
          </label>
          <input
            id={`fh-age-death-${uid}`}
            name="age_at_death"
            type="number"
            min={0}
            max={130}
            className="input"
            defaultValue={entry?.age_at_death ?? ""}
            placeholder="years"
          />
        </div>
        <div>
          <label className="label" htmlFor={`fh-cause-death-${uid}`}>
            Cause of death
          </label>
          <input
            id={`fh-cause-death-${uid}`}
            name="cause_of_death"
            className="input"
            defaultValue={entry?.cause_of_death ?? ""}
            placeholder="e.g. Myocardial infarction"
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`fh-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`fh-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={entry?.notes ?? ""}
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
