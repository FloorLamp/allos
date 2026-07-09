"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import type { FamilyHistory } from "@/lib/types";

// Common relatives, offered as a datalist so a user can pick or type their own.
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
  onDone,
}: {
  action: (formData: FormData) => Promise<void>;
  entry?: FamilyHistory;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!entry;
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("condition") ?? "").trim()) {
      setError("Enter the condition.");
      return;
    }
    try {
      await action(formData);
    } catch {
      setError("Couldn't save this entry. Please try again.");
      return;
    }
    toast(editing ? "Family history updated" : "Family history saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = entry?.id ?? "new";
  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add family history
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={entry!.id} />}
      <datalist id="family-relations">
        {RELATIONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div>
        <label className="label" htmlFor={`fh-relation-${uid}`}>
          Relative
        </label>
        <input
          id={`fh-relation-${uid}`}
          name="relation"
          list="family-relations"
          className="input"
          defaultValue={entry?.relation ?? ""}
          placeholder="e.g. Mother, Father, Sibling"
        />
      </div>
      <div>
        <label className="label" htmlFor={`fh-condition-${uid}`}>
          Condition
        </label>
        <input
          id={`fh-condition-${uid}`}
          name="condition"
          className="input"
          defaultValue={entry?.condition ?? ""}
          placeholder="e.g. Type 2 diabetes, Breast cancer"
          required
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
            defaultValue={entry?.code ?? ""}
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
            defaultValue={entry?.code_system ?? ""}
            placeholder="SNOMED CT / ICD-10"
          />
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
