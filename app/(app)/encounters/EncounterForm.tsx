"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import type { Encounter, FormResult } from "@/lib/types";

// Shared add/edit visit form. Add mode: no `encounter` (blank fields, date seeded
// to defaultDate). Edit mode: pass the row + an `onDone` callback (renders a hidden
// id + a Cancel button). The date is required; provider + facility are create-on-
// type inputs backed by the page's shared <datalist id="provider-names">.
export default function EncounterForm({
  action,
  encounter,
  onDone,
  defaultDate,
  date,
  onDateChange,
  embedded = false,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  encounter?: Encounter;
  onDone?: () => void;
  defaultDate: string;
  // When the single "Add visit" wrapper (issue #566) owns the date, it passes it
  // controlled so the value survives a tense flip between this form and the
  // appointment form. Only used in add mode; edit mode keeps its own stored date.
  date?: string;
  onDateChange?: (v: string) => void;
  // The wrapper renders its own card heading + tense toggle, so it suppresses this
  // form's built-in "Add visit" heading to avoid a doubled title.
  embedded?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!encounter;
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("date") ?? "").trim()) {
      setError("Pick a date for this visit.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this visit. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Visit updated" : "Visit saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = encounter?.id ?? "new";
  // In add mode the wrapper may drive the date (controlled) so it persists across
  // a tense flip; otherwise the field is uncontrolled and seeded from defaultDate.
  const controlledDate = !editing && date !== undefined;
  return (
    <form
      ref={formRef}
      action={handle}
      className={`${embedded ? "" : "card "}space-y-3`}
    >
      {!editing && !embedded && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add visit
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={encounter!.id} />}
      <div>
        <label className="label" htmlFor={`enc-type-${uid}`}>
          Visit type
        </label>
        <input
          id={`enc-type-${uid}`}
          name="type"
          className="input"
          defaultValue={encounter?.type ?? ""}
          placeholder="e.g. Office Visit, Emergency, Hospitalization"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`enc-date-${uid}`}>
            Date
          </label>
          <DateField
            id={`enc-date-${uid}`}
            name="date"
            {...(controlledDate
              ? { value: date, onChange: onDateChange }
              : { defaultValue: encounter?.date ?? defaultDate })}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor={`enc-end-${uid}`}>
            End date (optional)
          </label>
          <DateField
            id={`enc-end-${uid}`}
            name="end_date"
            defaultValue={encounter?.end_date ?? ""}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`enc-reason-${uid}`}>
          Reason (chief complaint)
        </label>
        <input
          id={`enc-reason-${uid}`}
          name="reason"
          className="input"
          defaultValue={encounter?.reason ?? ""}
          placeholder="e.g. Annual physical, Chest pain"
        />
      </div>
      <div>
        <label className="label" htmlFor={`enc-diagnoses-${uid}`}>
          Diagnoses
        </label>
        <input
          id={`enc-diagnoses-${uid}`}
          name="diagnoses"
          className="input"
          defaultValue={encounter?.diagnoses ?? ""}
          placeholder="Separate multiple with “; ”"
        />
      </div>
      <div>
        <label className="label" htmlFor={`enc-provider-${uid}`}>
          Provider
        </label>
        {/* Create-on-type from the shared registry via <datalist id="provider-names">. */}
        <input
          id={`enc-provider-${uid}`}
          name="provider"
          list="provider-names"
          className="input"
          defaultValue={encounter?.provider_name ?? ""}
          placeholder="e.g. Dr. Smith"
        />
        {/* Round-trip the loaded link so an untouched field keeps its id (#601). */}
        {editing && (
          <>
            <input
              type="hidden"
              name="provider_id"
              value={encounter?.provider_id ?? ""}
            />
            <input
              type="hidden"
              name="provider_loaded"
              value={encounter?.provider_name ?? ""}
            />
          </>
        )}
      </div>
      <div>
        <label className="label" htmlFor={`enc-location-${uid}`}>
          Facility / location
        </label>
        <input
          id={`enc-location-${uid}`}
          name="location"
          list="provider-names"
          className="input"
          defaultValue={encounter?.location_name ?? ""}
          placeholder="e.g. Example Medical Center, telehealth"
        />
        {/* Round-trip the loaded facility link so an untouched field keeps it (#601). */}
        {editing && (
          <>
            <input
              type="hidden"
              name="location_provider_id"
              value={encounter?.location_provider_id ?? ""}
            />
            <input
              type="hidden"
              name="location_loaded"
              value={encounter?.location_name ?? ""}
            />
          </>
        )}
      </div>
      <div>
        <label className="label" htmlFor={`enc-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`enc-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={encounter?.notes ?? ""}
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
