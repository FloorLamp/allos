"use client";

import { useRef } from "react";
import DateField from "./DateField";
import SubmitButton from "./SubmitButton";
import { useToast } from "./Toast";
import { useFocusFormOnParam } from "./useFocusFormOnParam";
import { MEDICAL_CATEGORIES } from "@/lib/medical-categories";
import type { MedicalRecord } from "@/lib/types";

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
// the add caller wraps it in its own card. The `canonical-names` / `provider-names`
// <datalist>s are provided by the host page.
export default function RecordForm({
  action,
  mode,
  record,
  onDone,
  categories = MEDICAL_CATEGORIES,
  defaultDate,
  defaultCategory,
}: {
  action: (formData: FormData) => Promise<void>;
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
}) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = mode === "edit";
  const uid = record?.id ?? "new";

  // The add form focuses itself when reached from the palette's "Add biomarker
  // record" (issue #29); the inline row editors (edit mode) opt out.
  useFocusFormOnParam(formRef, "new", undefined, mode === "add");

  async function handle(formData: FormData) {
    await action(formData);
    if (editing) {
      onDone?.();
    } else {
      // Add: the server action revalidates the list; clear the form for the next
      // entry and confirm the save.
      formRef.current?.reset();
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
          defaultValue={record?.name ?? ""}
          className="input"
          placeholder="e.g. LDL cholesterol"
          required
        />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`rec-${uid}-canonical`}>
          Canonical name
        </label>
        <input
          id={`rec-${uid}-canonical`}
          name="canonical_name"
          list="canonical-names"
          defaultValue={record?.canonical_name ?? ""}
          className="input"
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
          {/* Provider picker: create-on-type from the shared registry
              via the host page's <datalist id="provider-names">. */}
          <input
            id={`rec-${uid}-provider`}
            name="provider"
            list="provider-names"
            defaultValue={record?.provider_name ?? ""}
            className="input"
            placeholder="e.g. Quest Diagnostics"
          />
        </div>
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
    </form>
  );
}
