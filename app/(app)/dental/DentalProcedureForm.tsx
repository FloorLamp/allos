"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import { useToast } from "@/components/Toast";
import {
  DENTAL_STATUSES,
  TOOTH_SYSTEMS,
  dentalStatusLabel,
} from "@/lib/dental";
import type { DentalProcedure, ToothSystem, FormResult } from "@/lib/types";

const TOOTH_SYSTEM_LABEL: Record<ToothSystem, string> = {
  universal: "Universal (1–32)",
  fdi: "FDI / ISO",
  palmer: "Palmer",
};

// Shared add/edit dental-procedure form. Add mode: no `record`. Edit mode: pass the
// row + an `onDone` callback (renders a hidden id + a Cancel button). Enum fields
// (status / tooth_system) are <select>s so a value can never miss the DB CHECK set;
// the action also re-normalizes on the server. Periodontal MEASUREMENTS are captured
// as biomarkers on the Biomarkers surface, not here — this is the procedure/finding.
export default function DentalProcedureForm({
  action,
  record,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  record?: DentalProcedure;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!record;
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this record. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Record updated" : "Record saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = record?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      className="card space-y-3"
      data-testid="dental-procedure-form"
    >
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add dental record
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={record!.id} />}
      <div>
        <label className="label" htmlFor={`dp-name-${uid}`}>
          Procedure / finding
        </label>
        <input
          id={`dp-name-${uid}`}
          name="name"
          className="input"
          required
          defaultValue={record?.name ?? ""}
          placeholder="e.g. Composite filling, Extraction, Caries watch"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`dp-status-${uid}`}>
            Status
          </label>
          <select
            id={`dp-status-${uid}`}
            name="status"
            className="input"
            defaultValue={record?.status ?? "completed"}
          >
            {DENTAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {dentalStatusLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`dp-date-${uid}`}>
            Date
          </label>
          <DateField
            id={`dp-date-${uid}`}
            name="procedure_date"
            defaultValue={record?.procedure_date ?? ""}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label" htmlFor={`dp-tooth-${uid}`}>
            Tooth
          </label>
          <input
            id={`dp-tooth-${uid}`}
            name="tooth"
            className="input"
            defaultValue={record?.tooth ?? ""}
            placeholder="e.g. 14"
          />
        </div>
        <div>
          <label className="label" htmlFor={`dp-system-${uid}`}>
            System
          </label>
          <select
            id={`dp-system-${uid}`}
            name="tooth_system"
            className="input"
            defaultValue={record?.tooth_system ?? ""}
          >
            <option value="">—</option>
            {TOOTH_SYSTEMS.map((t) => (
              <option key={t} value={t}>
                {TOOTH_SYSTEM_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`dp-surface-${uid}`}>
            Surface
          </label>
          <input
            id={`dp-surface-${uid}`}
            name="surface"
            className="input"
            defaultValue={record?.surface ?? ""}
            placeholder="e.g. MOD"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`dp-cdt-${uid}`}>
            CDT code
          </label>
          <input
            id={`dp-cdt-${uid}`}
            name="cdt_code"
            className="input"
            defaultValue={record?.cdt_code ?? ""}
            placeholder="e.g. D2392"
          />
        </div>
        <div>
          <label className="label" htmlFor={`dp-followup-${uid}`}>
            Recheck in (days)
          </label>
          <input
            id={`dp-followup-${uid}`}
            name="follow_up_interval_days"
            type="number"
            min="1"
            className="input"
            defaultValue={record?.follow_up_interval_days ?? ""}
            placeholder="e.g. 180"
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`dp-finding-${uid}`}>
          Finding / note
        </label>
        <textarea
          id={`dp-finding-${uid}`}
          name="finding"
          className="input min-h-16"
          defaultValue={record?.finding ?? ""}
          placeholder="Free-text clinical impression, e.g. watch mesial #14 for recurrent decay"
        />
      </div>
      <div>
        <label className="label" htmlFor={`dp-provider-${uid}`}>
          Provider
        </label>
        {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
        <ProviderCombobox
          id={`dp-provider-${uid}`}
          name="provider"
          defaultValue={record?.provider_name ?? ""}
          placeholder="e.g. Dr. Rivera (dentist)"
        />
        {editing && (
          <>
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
          </>
        )}
      </div>
      <div>
        <label className="label" htmlFor={`dp-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`dp-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={record?.notes ?? ""}
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
