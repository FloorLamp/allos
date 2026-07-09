"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import type { Encounter } from "@/lib/types";

// Shared add/edit visit form. Add mode: no `encounter` (blank fields, date seeded
// to defaultDate). Edit mode: pass the row + an `onDone` callback (renders a hidden
// id + a Cancel button). The date is required; provider + facility are create-on-
// type inputs backed by the page's shared <datalist id="provider-names">.
export default function EncounterForm({
  action,
  encounter,
  onDone,
  defaultDate,
}: {
  action: (formData: FormData) => Promise<void>;
  encounter?: Encounter;
  onDone?: () => void;
  defaultDate: string;
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
    try {
      await action(formData);
    } catch {
      setError("Couldn't save this visit. Please try again.");
      return;
    }
    toast(editing ? "Visit updated" : "Visit saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = encounter?.id ?? "new";
  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      {!editing && (
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
            defaultValue={encounter?.date ?? defaultDate}
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
