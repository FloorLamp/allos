"use client";

import { useRef, useState } from "react";
import DateField from "./DateField";
import EditLockNotice from "./EditLockNotice";
import SubmitButton from "./SubmitButton";
import Combobox from "./Combobox";
import ProviderCombobox from "./ProviderCombobox";
import { useCanonicalNames } from "./CanonicalNamesContext";
import { useToast } from "./Toast";
import { useFocusFormOnParam } from "./useFocusFormOnParam";
import { MEDICAL_CATEGORIES } from "@/lib/medical-categories";
import type { FormResult, MedicalRecord } from "@/lib/types";

// Only clinical flags are user-settable; "non-optimal" is derived from the
// canonical optimal band, so it's not offered here.
const FLAGS = ["normal", "high", "low", "abnormal"] as const;

// The shared medical-record form, for both the add slot (Biomarkers page) and the
// inline row editor (document view + Biomarkers rows). `mode` toggles which fields
// show and the submit label: add mode carries the manual-entry field set (the
// columns addRecord reads); edit mode additionally exposes panel / flag / provider
// (the columns updateRecord writes). `action` is the server action to call —
// addRecord or updateRecord — so the two callers stay on the same profile-scoped,
// flag-reconciling write path.
//
// It renders a bare <form> (no card) so a table cell can host the edit variant;
// the add caller wraps it in its own card. The canonical-name suggestions come from
// the host page's CanonicalNamesProvider; the "Performed by" picker is the shared
// ProviderCombobox (#1176/#1177) over the section's ProviderOptionsProvider rows.
export default function RecordForm({
  action,
  mode,
  record,
  onDone,
  categories = MEDICAL_CATEGORIES,
  defaultDate,
  defaultCategory,
  defaultName,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  mode: "add" | "edit";
  // The row being edited (edit mode). Its columns seed the field defaults.
  record?: MedicalRecord;
  // Called after a successful submit — the row editor closes on it.
  onDone?: () => void;
  // Category <select> options. Defaults to the full enum; the Biomarkers page
  // passes its prescription-less list so a med can't be added/relabelled there.
  categories?: readonly string[];
  // Add mode: the initial date (today in the profile's tz) and category.
  defaultDate?: string;
  defaultCategory?: string;
  // Add mode: prefill the name field — the command palette's "Add result" hit
  // action lands here name-carrying (#662). Also seeds the canonical name, which
  // defaults to the name.
  defaultName?: string;
}) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = mode === "edit";
  const uid = record?.id ?? "new";
  const [error, setError] = useState<string | null>(null);
  // The canonical-name field is a controlled Combobox (#1177), so form.reset() can't
  // clear it — the add path resets this state explicitly on a successful save.
  const canonicalNames = useCanonicalNames();
  const [canonical, setCanonical] = useState(record?.canonical_name ?? "");

  // The add form focuses itself when reached from the palette's "Add biomarker
  // record" (issue #29); the inline row editors (edit mode) opt out.
  useFocusFormOnParam(formRef, "new", undefined, mode === "add");

  async function handle(formData: FormData) {
    setError(null);
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this record. Try again.");
      return;
    }
    // A validation guard now answers with a typed error instead of a silent
    // resolve — surface it inline and DON'T toast success or reset (issue #474).
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (editing) {
      onDone?.();
    } else {
      // Add: the server action revalidates the list; clear the form for the next
      // entry and confirm the save.
      formRef.current?.reset();
      setCanonical("");
      toast("Record saved");
    }
  }

  return (
    <form ref={formRef} action={handle} className="grid gap-3 sm:grid-cols-4">
      {editing && <input type="hidden" name="id" value={record!.id} />}
      <div>
        <label className="label" htmlFor={`rec-${uid}-date`}>
          Date
        </label>
        <DateField
          id={`rec-${uid}-date`}
          name="date"
          defaultValue={record?.date ?? defaultDate ?? ""}
          required
        />
      </div>
      <div>
        <label className="label" htmlFor={`rec-${uid}-category`}>
          Category
        </label>
        <select
          id={`rec-${uid}-category`}
          name="category"
          className="input capitalize"
          defaultValue={record?.category ?? defaultCategory ?? "lab"}
        >
          {categories.map((c) => (
            <option key={c} value={c} className="capitalize">
              {c}
            </option>
          ))}
        </select>
      </div>
      {editing && (
        <>
          <div>
            <label className="label" htmlFor={`rec-${uid}-panel`}>
              Panel
            </label>
            <input
              id={`rec-${uid}-panel`}
              name="panel"
              defaultValue={record?.panel ?? ""}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor={`rec-${uid}-flag`}>
              Flag
            </label>
            <select
              id={`rec-${uid}-flag`}
              name="flag"
              className="input"
              defaultValue={record?.flag ?? ""}
            >
              <option value="">—</option>
              {FLAGS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`rec-${uid}-name`}>
          Name
        </label>
        <input
          id={`rec-${uid}-name`}
          name="name"
          defaultValue={record?.name ?? defaultName ?? ""}
          className="input"
          placeholder="e.g. LDL cholesterol"
          required
        />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`rec-${uid}-canonical`}>
          Canonical name
        </label>
        <Combobox
          id={`rec-${uid}-canonical`}
          name="canonical_name"
          ariaLabel="Canonical name"
          value={canonical}
          onChange={setCanonical}
          options={canonicalNames}
          allowFreeText
          placeholder="defaults to name"
        />
      </div>
      <div>
        <label className="label" htmlFor={`rec-${uid}-value`}>
          Value
        </label>
        <input
          id={`rec-${uid}-value`}
          name="value"
          defaultValue={record?.value ?? ""}
          className="input"
          placeholder="e.g. 95"
        />
      </div>
      <div>
        <label className="label" htmlFor={`rec-${uid}-unit`}>
          Unit
        </label>
        <input
          id={`rec-${uid}-unit`}
          name="unit"
          defaultValue={record?.unit ?? ""}
          className="input"
          placeholder="mg/dL"
        />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`rec-${uid}-reference`}>
          Reference range
        </label>
        <input
          id={`rec-${uid}-reference`}
          name="reference_range"
          defaultValue={record?.reference_range ?? ""}
          className="input"
          placeholder="< 100"
        />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`rec-${uid}-notes`}>
          Notes
        </label>
        <input
          id={`rec-${uid}-notes`}
          name="notes"
          defaultValue={record?.notes ?? ""}
          className="input"
        />
      </div>
      {editing && (
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`rec-${uid}-provider`}>
            Performed by
          </label>
          {/* Provider picker: create-on-type ProviderCombobox (#1176) over the
              section's shared registry rows. */}
          <ProviderCombobox
            id={`rec-${uid}-provider`}
            name="provider"
            defaultValue={record?.provider_name ?? ""}
            placeholder="e.g. Quest Diagnostics"
          />
          {/* Round-trip the loaded link so an untouched field keeps its id (#601). */}
          <input
            type="hidden"
            name="provider_id"
            value={record?.provider_id ?? ""}
          />
          <input
            type="hidden"
            name="provider_loaded"
            value={record?.provider_name ?? ""}
          />
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="text-sm text-rose-600 sm:col-span-4 dark:text-rose-400"
        >
          {error}
        </p>
      )}
      <div className="flex items-end gap-2 sm:col-span-4">
        <SubmitButton pendingLabel="Saving…">
          {editing ? "Save" : "Save record"}
        </SubmitButton>
        {editing && onDone && (
          <button type="button" onClick={onDone} className="btn-ghost">
            Cancel
          </button>
        )}
      </div>
      {/* Edit-lock badge + resume affordance for a hand-edited imported reading
          (#659): only source-owned rows (external_id set) carry the lock. */}
      {editing && !!record?.edited && !!record?.external_id && (
        <div className="sm:col-span-4">
          <EditLockNotice table="medical_records" id={record!.id} />
        </div>
      )}
    </form>
  );
}
