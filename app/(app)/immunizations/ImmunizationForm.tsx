"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import Combobox from "@/components/Combobox";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { PICKER_NAMES, vaccineDisplayName } from "@/lib/immunization-catalog";
import type { FormResult, Immunization } from "@/lib/types";

// Shared add/edit form. Add mode: no `immunization`. Edit mode: pass the row +
// an `onDone` callback (renders a hidden id and a Cancel button). The vaccine
// field is a free-text combobox seeded from the catalog; the server action
// normalizes the chosen/typed name back to a catalog code on save.
const OPTIONS = PICKER_NAMES;

export default function ImmunizationForm({
  action,
  immunization,
  onDone,
  defaultDate,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  immunization?: Immunization;
  onDone?: () => void;
  defaultDate: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!immunization;
  const [vaccine, setVaccine] = useState(
    immunization ? vaccineDisplayName(immunization.vaccine) : ""
  );
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    formData.set("vaccine", vaccine);
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      // Keep the form and its input mounted, and surface the failure inline.
      setError("Couldn't save this immunization. Please try again.");
      return;
    }
    // A validation guard now answers with a typed error instead of a silent
    // resolve — surface it inline and DON'T toast success or reset (issue #474).
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Immunization updated" : "Immunization saved");
    if (!editing) {
      formRef.current?.reset();
      setVaccine("");
    }
    onDone?.();
    router.refresh();
  }

  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add immunization
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={immunization!.id} />}
      <div>
        <label className="label">Vaccine</label>
        <Combobox
          value={vaccine}
          onChange={setVaccine}
          options={OPTIONS}
          allowFreeText
          name="vaccine"
          ariaLabel="Vaccine"
          placeholder="e.g. Tdap, MMR, Vaxelis, Yellow Fever"
          freeTextLabel={(q) => <>Use “{q}”</>}
        />
      </div>
      <div>
        <label
          className="label"
          htmlFor={`imm-date-${immunization?.id ?? "new"}`}
        >
          Date given
        </label>
        <DateField
          id={`imm-date-${immunization?.id ?? "new"}`}
          name="date"
          defaultValue={immunization?.date ?? defaultDate}
          required
        />
      </div>
      <div>
        <label
          className="label"
          htmlFor={`imm-dose-${immunization?.id ?? "new"}`}
        >
          Dose / label
        </label>
        <input
          id={`imm-dose-${immunization?.id ?? "new"}`}
          name="dose_label"
          className="input"
          defaultValue={immunization?.dose_label ?? ""}
          placeholder="e.g. Booster, Dose 1, 2025 seasonal"
        />
      </div>
      <div>
        <label
          className="label"
          htmlFor={`imm-notes-${immunization?.id ?? "new"}`}
        >
          Notes
        </label>
        <input
          id={`imm-notes-${immunization?.id ?? "new"}`}
          name="notes"
          className="input"
          defaultValue={immunization?.notes ?? ""}
        />
      </div>
      <div>
        <label
          className="label"
          htmlFor={`imm-provider-${immunization?.id ?? "new"}`}
        >
          Administered by
        </label>
        {/* Provider picker: free text with create-on-type from the
            shared registry via the page's <datalist id="provider-names">. */}
        <input
          id={`imm-provider-${immunization?.id ?? "new"}`}
          name="provider"
          list="provider-names"
          className="input"
          defaultValue={immunization?.provider_name ?? ""}
          placeholder="e.g. Example Medical Center, Dr. Smith"
        />
        {/* Round-trip the loaded link so an untouched field keeps its id (#601). */}
        {editing && (
          <>
            <input
              type="hidden"
              name="provider_id"
              value={immunization?.provider_id ?? ""}
            />
            <input
              type="hidden"
              name="provider_loaded"
              value={immunization?.provider_name ?? ""}
            />
          </>
        )}
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
