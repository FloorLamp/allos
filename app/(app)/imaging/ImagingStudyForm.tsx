"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import { useToast } from "@/components/Toast";
import {
  IMAGING_MODALITIES,
  IMAGING_LATERALITIES,
  modalityLabel,
  lateralityLabel,
} from "@/lib/imaging-study";
import type { ImagingStudy, FormResult } from "@/lib/types";

// Shared add/edit imaging-study form. Add mode: no `study`. Edit mode: pass the row
// + an `onDone` callback (renders a hidden id + a Cancel button). Enum fields
// (modality / laterality) are <select>s so a value can never miss the DB CHECK set;
// the action also re-normalizes on the server. Image pixels / DICOM are out of scope
// — this captures the report's metadata + the radiologist's impression.
export default function ImagingStudyForm({
  action,
  study,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  study?: ImagingStudy;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!study;
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this study. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Study updated" : "Study saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = study?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      className="card space-y-3"
      data-testid="imaging-study-form"
    >
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add imaging study
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={study!.id} />}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`is-modality-${uid}`}>
            Modality
          </label>
          <select
            id={`is-modality-${uid}`}
            name="modality"
            className="input"
            defaultValue={study?.modality ?? "x-ray"}
          >
            {IMAGING_MODALITIES.map((m) => (
              <option key={m} value={m}>
                {modalityLabel(m)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`is-region-${uid}`}>
            Body region
          </label>
          <input
            id={`is-region-${uid}`}
            name="body_region"
            className="input"
            defaultValue={study?.body_region ?? ""}
            placeholder="e.g. Chest, Left Knee"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`is-laterality-${uid}`}>
            Laterality
          </label>
          <select
            id={`is-laterality-${uid}`}
            name="laterality"
            className="input"
            defaultValue={study?.laterality ?? ""}
          >
            <option value="">—</option>
            {IMAGING_LATERALITIES.map((l) => (
              <option key={l} value={l}>
                {lateralityLabel(l)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`is-study-date-${uid}`}>
            Study date
          </label>
          <DateField
            id={`is-study-date-${uid}`}
            name="study_date"
            defaultValue={study?.study_date ?? ""}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 items-end gap-3">
        <label
          className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
          htmlFor={`is-contrast-${uid}`}
        >
          <input
            id={`is-contrast-${uid}`}
            type="checkbox"
            name="contrast"
            value="true"
            defaultChecked={study?.contrast ?? false}
            className="h-4 w-4"
          />
          Contrast given
        </label>
        <div>
          <label className="label" htmlFor={`is-contrast-agent-${uid}`}>
            Contrast agent
          </label>
          <input
            id={`is-contrast-agent-${uid}`}
            name="contrast_agent"
            className="input"
            defaultValue={study?.contrast_agent ?? ""}
            placeholder="e.g. gadolinium"
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`is-dose-${uid}`}>
          Effective dose (mSv)
        </label>
        <input
          id={`is-dose-${uid}`}
          name="dose_msv"
          type="number"
          step="any"
          min="0"
          inputMode="decimal"
          className="input"
          defaultValue={study?.dose_msv ?? ""}
          placeholder="Only if the report prints one (rare)"
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Leave blank to use a typical estimate for the modality.
        </p>
      </div>
      <div>
        <label className="label" htmlFor={`is-indication-${uid}`}>
          Indication
        </label>
        <input
          id={`is-indication-${uid}`}
          name="indication"
          className="input"
          defaultValue={study?.indication ?? ""}
          placeholder="Reason the study was ordered, e.g. screening"
        />
      </div>
      <div>
        <label className="label" htmlFor={`is-impression-${uid}`}>
          Impression
        </label>
        <textarea
          id={`is-impression-${uid}`}
          name="impression"
          className="input min-h-20"
          defaultValue={study?.impression ?? ""}
          placeholder="The radiologist's impression / findings, verbatim"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`is-status-${uid}`}>
            Status
          </label>
          <input
            id={`is-status-${uid}`}
            name="status"
            className="input"
            defaultValue={study?.status ?? ""}
            placeholder="e.g. final"
          />
        </div>
        <div>
          <label className="label" htmlFor={`is-ordering-${uid}`}>
            Ordering provider
          </label>
          {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
          <ProviderCombobox
            id={`is-ordering-${uid}`}
            name="ordering_provider"
            ariaLabel="Ordering provider"
            defaultValue={study?.ordering_provider_name ?? ""}
            placeholder="e.g. Dr. Lee"
          />
          {editing && (
            <>
              <input
                type="hidden"
                name="ordering_provider_id"
                value={study?.ordering_provider_id ?? ""}
              />
              <input
                type="hidden"
                name="ordering_provider_loaded"
                value={study?.ordering_provider_name ?? ""}
              />
            </>
          )}
        </div>
        <div>
          <label className="label" htmlFor={`is-reading-${uid}`}>
            Reading radiologist
          </label>
          <ProviderCombobox
            id={`is-reading-${uid}`}
            name="reading_provider"
            ariaLabel="Reading radiologist"
            defaultValue={study?.reading_provider_name ?? ""}
            placeholder="e.g. Dr. Osei"
          />
          {editing && (
            <>
              <input
                type="hidden"
                name="reading_provider_id"
                value={study?.reading_provider_id ?? ""}
              />
              <input
                type="hidden"
                name="reading_provider_loaded"
                value={study?.reading_provider_name ?? ""}
              />
            </>
          )}
        </div>
        <div>
          <label className="label" htmlFor={`is-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`is-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={study?.notes ?? ""}
          />
        </div>
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
