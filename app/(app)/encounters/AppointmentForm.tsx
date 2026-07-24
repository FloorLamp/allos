"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import { useToast } from "@/components/Toast";
import { useFocusFormOnParam } from "@/components/useFocusFormOnParam";
import {
  APPOINTMENT_KINDS,
  APPOINTMENT_KIND_LABELS,
} from "@/lib/preventive-appointment";
import type { Appointment, FormResult } from "@/lib/types";

// Shared add/edit form for a scheduled visit. Add mode: no `appointment`. Edit
// mode: pass the row + `onDone` (renders a hidden id + a Cancel button). `prefill`
// seeds a NEW (create) form from a completed visit for a follow-up — same
// provider/reason/location, blank (defaultDate) date — and is ignored in edit
// mode. The date is required; the optional time is folded into scheduled_at
// ("YYYY-MM-DD HH:MM") on submit. Provider is a create-on-type ProviderCombobox
// (#1176) over the section's shared registry rows.
export default function AppointmentForm({
  action,
  appointment,
  onDone,
  defaultDate,
  prefill,
  date,
  onDateChange,
  embedded = false,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  appointment?: Appointment;
  onDone?: () => void;
  defaultDate: string;
  prefill?: {
    title: string | null;
    provider: string | null;
    location: string | null;
    kind?: string | null;
  };
  // When the single "Add visit" wrapper (issue #566) owns the date, it passes it
  // controlled so the value survives a tense flip between this form and the
  // encounter form. Only used in add mode; edit mode keeps its own stored date.
  date?: string;
  onDateChange?: (v: string) => void;
  // The single "Add visit" wrapper renders its own card heading + tense toggle, so
  // it suppresses this form's built-in "Add appointment" heading.
  embedded?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!appointment;
  const [error, setError] = useState<string | null>(null);

  // The primary create form focuses itself when reached with ?new=1 — from the
  // command palette's "Add appointment" (issue #29) or a preventive "Book" CTA
  // (issue #85), which also prefills title/kind/date. The follow-up prefill form
  // (distinguished by its `onDone` Cancel handler) opts out so it never steals
  // focus from the main form.
  useFocusFormOnParam(formRef, "new", undefined, !editing && !onDone);

  // In add mode the wrapper may drive the date (controlled) so it persists across
  // a tense flip; otherwise the field is uncontrolled and seeded from defaultDate.
  const controlledDate = !editing && date !== undefined;

  // Split any stored "YYYY-MM-DD HH:MM" back into its date + time parts for edit.
  const storedDate = appointment?.scheduled_at?.slice(0, 10) ?? defaultDate;
  const storedTime =
    appointment?.scheduled_at && appointment.scheduled_at.length > 10
      ? appointment.scheduled_at.slice(11, 16)
      : "";

  const uid = appointment?.id ?? "new";

  async function handle(formData: FormData) {
    setError(null);
    const date = String(formData.get("date") ?? "").trim();
    const time = String(formData.get("time") ?? "").trim();
    if (!date) {
      setError("Pick a date for this appointment.");
      return;
    }
    formData.set("scheduled_at", time ? `${date} ${time}` : date);
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this appointment. Try again.");
      return;
    }
    // A validation guard now answers with a typed error instead of a silent
    // resolve — surface it inline and DON'T toast success or reset (issue #474).
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Appointment updated" : "Appointment saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  return (
    <form
      ref={formRef}
      action={handle}
      className={`${embedded ? "" : "card "}space-y-3`}
    >
      {!editing && !embedded && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {onDone ? "Schedule follow-up" : "Add appointment"}
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={appointment!.id} />}
      <div>
        <label className="label" htmlFor={`appt-title-${uid}`}>
          Reason / title
        </label>
        <input
          id={`appt-title-${uid}`}
          name="title"
          className="input"
          defaultValue={appointment?.title ?? prefill?.title ?? ""}
          placeholder="e.g. Annual physical, Dermatology follow-up"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`appt-date-${uid}`}>
            Date
          </label>
          <DateField
            id={`appt-date-${uid}`}
            name="date"
            {...(controlledDate
              ? { value: date, onChange: onDateChange }
              : { defaultValue: storedDate })}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor={`appt-time-${uid}`}>
            Time (optional)
          </label>
          <input
            id={`appt-time-${uid}`}
            name="time"
            type="time"
            className="input"
            defaultValue={storedTime}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`appt-kind-${uid}`}>
          Kind (optional)
        </label>
        {/* Optional visit category (issue #85). A matching kind lets a preventive
            reminder quiet to "Scheduled" and, once completed, offer to mark that
            care done. Blank stays unset and never matches. */}
        <select
          id={`appt-kind-${uid}`}
          name="kind"
          className="input"
          defaultValue={appointment?.kind ?? prefill?.kind ?? ""}
        >
          <option value="">Unspecified</option>
          {APPOINTMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {APPOINTMENT_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`appt-provider-${uid}`}>
          Provider
        </label>
        {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
        <ProviderCombobox
          id={`appt-provider-${uid}`}
          name="provider"
          defaultValue={appointment?.provider_name ?? prefill?.provider ?? ""}
          placeholder="e.g. Example Medical Center, Dr. Smith"
        />
        {/* Round-trip the loaded link so an untouched field keeps its id (#601). */}
        {editing && (
          <>
            <input
              type="hidden"
              name="provider_id"
              value={appointment?.provider_id ?? ""}
            />
            <input
              type="hidden"
              name="provider_loaded"
              value={appointment?.provider_name ?? ""}
            />
          </>
        )}
      </div>
      <div>
        <label className="label" htmlFor={`appt-location-${uid}`}>
          Location (optional)
        </label>
        <input
          id={`appt-location-${uid}`}
          name="location"
          className="input"
          defaultValue={appointment?.location ?? prefill?.location ?? ""}
          placeholder="e.g. Clinic address, telehealth"
        />
      </div>
      <div>
        <label className="label" htmlFor={`appt-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`appt-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={appointment?.notes ?? ""}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <SubmitButton className="btn w-full" pendingLabel="Saving…">
          {editing ? "Save" : onDone ? "Schedule" : "Add"}
        </SubmitButton>
        {onDone && (
          <button type="button" className="btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
