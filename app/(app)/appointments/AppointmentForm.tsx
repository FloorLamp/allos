"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import type { Appointment } from "@/lib/types";

// Shared add/edit form for a scheduled visit. Add mode: no `appointment`. Edit
// mode: pass the row + `onDone` (renders a hidden id + a Cancel button). `prefill`
// seeds a NEW (create) form from a completed visit for a follow-up — same
// provider/reason/location, blank (defaultDate) date — and is ignored in edit
// mode. The date is required; the optional time is folded into scheduled_at
// ("YYYY-MM-DD HH:MM") on submit. Provider is a create-on-type input backed by the
// page's shared <datalist id="provider-names">.
export default function AppointmentForm({
  action,
  appointment,
  onDone,
  defaultDate,
  prefill,
}: {
  action: (formData: FormData) => Promise<void>;
  appointment?: Appointment;
  onDone?: () => void;
  defaultDate: string;
  prefill?: {
    title: string | null;
    provider: string | null;
    location: string | null;
  };
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!appointment;
  const [error, setError] = useState<string | null>(null);

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
    try {
      await action(formData);
    } catch {
      setError("Couldn't save this appointment. Please try again.");
      return;
    }
    toast(editing ? "Appointment updated" : "Appointment saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {prefill ? "Schedule follow-up" : "Add appointment"}
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
            defaultValue={storedDate}
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
        <label className="label" htmlFor={`appt-provider-${uid}`}>
          Provider
        </label>
        {/* Create-on-type from the shared registry via <datalist id="provider-names">. */}
        <input
          id={`appt-provider-${uid}`}
          name="provider"
          list="provider-names"
          className="input"
          defaultValue={appointment?.provider_name ?? prefill?.provider ?? ""}
          placeholder="e.g. Example Medical Center, Dr. Smith"
        />
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
          {editing ? "Save" : prefill ? "Schedule" : "Add"}
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
