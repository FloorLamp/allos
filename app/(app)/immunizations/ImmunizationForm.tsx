"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import Combobox from "@/components/Combobox";
import ProviderCombobox from "@/components/ProviderCombobox";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { PICKER_NAMES, vaccineDisplayName } from "@/lib/immunization-catalog";
import {
  IMMUNIZATION_ROUTES,
  type FormResult,
  type Immunization,
} from "@/lib/types";

// Human labels for the CHECK-pinned route vocabulary (#1406). "Not stated" is the
// default and a real answer — never a guessed 'intramuscular'.
const ROUTE_LABELS: Record<(typeof IMMUNIZATION_ROUTES)[number], string> = {
  intramuscular: "Intramuscular (IM)",
  subcutaneous: "Subcutaneous (SC)",
  intradermal: "Intradermal (ID)",
  oral: "Oral (PO)",
  intranasal: "Intranasal (IN)",
  other: "Other",
};

// Shared add/edit form. Add mode: no `immunization`. Edit mode: pass the row +
// an `onDone` callback (renders a hidden id and a Cancel button). The vaccine
// field is a free-text combobox seeded from the catalog; the server action
// normalizes the chosen/typed name back to a catalog code on save.
const OPTIONS = PICKER_NAMES;

export default function ImmunizationForm({
  action,
  immunization,
  profileId,
  onDone,
  defaultDate,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  immunization?: Immunization;
  // Multi-view (#1359): the row's OWN profile, posted so an edit on a non-acting
  // member's dose targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
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
      setError("Couldn't save this immunization. Try again.");
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
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
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
      {/* Administration details (#1406): lot / route / site are exactly what school,
          travel, camp and employer forms ask for, and had nowhere to live; `reaction`
          records an adverse reaction to THIS dose (notes is the dose's general note).
          All optional — a blank field stores NULL, not a guess. */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            className="label"
            htmlFor={`imm-lot-${immunization?.id ?? "new"}`}
          >
            Lot number
          </label>
          <input
            id={`imm-lot-${immunization?.id ?? "new"}`}
            name="lot_number"
            className="input"
            defaultValue={immunization?.lot_number ?? ""}
            placeholder="e.g. AB1234"
          />
        </div>
        <div>
          <label
            className="label"
            htmlFor={`imm-route-${immunization?.id ?? "new"}`}
          >
            Route
          </label>
          <select
            id={`imm-route-${immunization?.id ?? "new"}`}
            name="route"
            className="input"
            defaultValue={immunization?.route ?? ""}
          >
            <option value="">Not stated</option>
            {IMMUNIZATION_ROUTES.map((r) => (
              <option key={r} value={r}>
                {ROUTE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            className="label"
            htmlFor={`imm-site-${immunization?.id ?? "new"}`}
          >
            Site
          </label>
          <input
            id={`imm-site-${immunization?.id ?? "new"}`}
            name="site"
            className="input"
            defaultValue={immunization?.site ?? ""}
            placeholder="e.g. Left deltoid"
          />
        </div>
        <div>
          <label
            className="label"
            htmlFor={`imm-reaction-${immunization?.id ?? "new"}`}
          >
            Reaction
          </label>
          <input
            id={`imm-reaction-${immunization?.id ?? "new"}`}
            name="reaction"
            className="input"
            defaultValue={immunization?.reaction ?? ""}
            placeholder="e.g. Sore arm for two days"
          />
        </div>
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
        {/* Provider picker: create-on-type ProviderCombobox (#1176) over the
            section's shared registry rows. */}
        <ProviderCombobox
          id={`imm-provider-${immunization?.id ?? "new"}`}
          name="provider"
          ariaLabel="Administered by"
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
