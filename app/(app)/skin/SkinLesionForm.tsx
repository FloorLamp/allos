"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import {
  SKIN_LESION_STATUSES,
  BODY_REGIONS,
  BODY_SIDES,
  ABCDE_DIMENSIONS,
  skinLesionStatusLabel,
  bodyRegionLabel,
  bodySideLabel,
} from "@/lib/skin-lesion";
import type { SkinLesion, FormResult } from "@/lib/types";

// Shared add/edit skin-lesion form (issue #715). Add mode: no `record`. Edit mode: pass
// the row + an `onDone` callback (renders a hidden id + a Cancel button). Enum fields
// (status / body_region / body_side) are <select>s so a value can never miss the DB
// CHECK set; the action re-normalizes on the server. The five ABCDE fields are
// USER-RECORDED OBSERVATIONS (checkboxes) — the labels describe what you observed, never
// a verdict (this app tracks and compares, it does not assess a lesion).
export default function SkinLesionForm({
  action,
  record,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  record?: SkinLesion;
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
      setError("Couldn't save this lesion. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Lesion updated" : "Lesion saved");
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
      data-testid="skin-lesion-form"
    >
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add skin lesion
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={record!.id} />}
      <div>
        <label className="label" htmlFor={`sl-label-${uid}`}>
          Label / location
        </label>
        <input
          id={`sl-label-${uid}`}
          name="label"
          className="input"
          defaultValue={record?.label ?? ""}
          placeholder="e.g. Upper left forearm mole"
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label" htmlFor={`sl-region-${uid}`}>
            Region
          </label>
          <select
            id={`sl-region-${uid}`}
            name="body_region"
            className="input"
            defaultValue={record?.body_region ?? ""}
          >
            <option value="">—</option>
            {BODY_REGIONS.map((r) => (
              <option key={r} value={r}>
                {bodyRegionLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`sl-side-${uid}`}>
            Side
          </label>
          <select
            id={`sl-side-${uid}`}
            name="body_side"
            className="input"
            defaultValue={record?.body_side ?? ""}
          >
            <option value="">—</option>
            {BODY_SIDES.map((s) => (
              <option key={s} value={s}>
                {bodySideLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`sl-size-${uid}`}>
            Size (mm)
          </label>
          <input
            id={`sl-size-${uid}`}
            name="size_mm"
            type="number"
            min="0"
            step="0.1"
            className="input"
            defaultValue={record?.size_mm ?? ""}
            placeholder="e.g. 5"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`sl-status-${uid}`}>
            Status
          </label>
          <select
            id={`sl-status-${uid}`}
            name="status"
            className="input"
            defaultValue={record?.status ?? "active"}
          >
            {SKIN_LESION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {skinLesionStatusLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`sl-date-${uid}`}>
            Observed
          </label>
          <DateField
            id={`sl-date-${uid}`}
            name="observed_date"
            defaultValue={record?.observed_date ?? ""}
          />
        </div>
      </div>
      <fieldset className="rounded-lg border border-black/10 p-3 dark:border-white/10">
        <legend className="px-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          ABCDE observations (what you noticed — not an assessment)
        </legend>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {ABCDE_DIMENSIONS.map((d) => (
            <label
              key={d.key}
              className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
            >
              <input
                type="checkbox"
                name={d.key}
                value="1"
                defaultChecked={record?.[d.key] === 1}
              />
              <span>
                <span className="font-semibold">{d.letter}</span> — {d.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label className="label" htmlFor={`sl-followup-${uid}`}>
          Recheck in (days)
        </label>
        <input
          id={`sl-followup-${uid}`}
          name="follow_up_interval_days"
          type="number"
          min="1"
          className="input"
          defaultValue={record?.follow_up_interval_days ?? ""}
          placeholder="e.g. 90"
        />
      </div>
      <div>
        <label className="label" htmlFor={`sl-finding-${uid}`}>
          Finding / note
        </label>
        <textarea
          id={`sl-finding-${uid}`}
          name="finding"
          className="input min-h-16"
          defaultValue={record?.finding ?? ""}
          placeholder="Free-text notes, e.g. slightly raised, dark brown, unchanged since last check"
        />
      </div>
      <div>
        <label className="label" htmlFor={`sl-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`sl-notes-${uid}`}
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
