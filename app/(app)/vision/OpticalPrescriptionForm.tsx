"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import { useToast } from "@/components/Toast";
import { OPTICAL_KINDS, kindLabel } from "@/lib/optical-prescription";
import type { OpticalPrescription, OpticalKind, FormResult } from "@/lib/types";

// Shared add/edit optical-prescription form. Add mode: no `rx`. Edit mode: pass the
// row + an `onDone` callback (renders a hidden id + a Cancel button). `kind` is a
// <select> so it can never miss the DB CHECK set; the powers/axis/distances are
// re-parsed on the server through lib/optical-prescription. The contacts-only extras
// (base curve / diameter / brand) reveal when kind = contacts. OD = right eye, OS =
// left eye — the standard optometry notation an Rx slip prints.
export default function OpticalPrescriptionForm({
  action,
  rx,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  rx?: OpticalPrescription;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!rx;
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<OpticalKind>(rx?.kind ?? "glasses");

  async function handle(formData: FormData) {
    setError(null);
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this prescription. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Prescription updated" : "Prescription saved");
    if (!editing) {
      formRef.current?.reset();
      setKind("glasses");
    }
    onDone?.();
    router.refresh();
  }

  const uid = rx?.id ?? "new";
  const num = (v: number | null | undefined) => (v == null ? "" : String(v));

  // One eye's four refraction inputs (sphere / cylinder / axis / add).
  const eyeRow = (eye: "od" | "os", label: string) => (
    <div className="grid grid-cols-4 gap-2">
      <div className="col-span-4 text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div>
        <label className="label" htmlFor={`rx-${eye}-sphere-${uid}`}>
          Sphere
        </label>
        <input
          id={`rx-${eye}-sphere-${uid}`}
          name={`${eye}_sphere`}
          className="input"
          defaultValue={num(rx?.[`${eye}_sphere`])}
          placeholder="-2.00"
        />
      </div>
      <div>
        <label className="label" htmlFor={`rx-${eye}-cylinder-${uid}`}>
          Cyl
        </label>
        <input
          id={`rx-${eye}-cylinder-${uid}`}
          name={`${eye}_cylinder`}
          className="input"
          defaultValue={num(rx?.[`${eye}_cylinder`])}
          placeholder="-0.75"
        />
      </div>
      <div>
        <label className="label" htmlFor={`rx-${eye}-axis-${uid}`}>
          Axis
        </label>
        <input
          id={`rx-${eye}-axis-${uid}`}
          name={`${eye}_axis`}
          className="input"
          defaultValue={num(rx?.[`${eye}_axis`])}
          placeholder="90"
        />
      </div>
      <div>
        <label className="label" htmlFor={`rx-${eye}-add-${uid}`}>
          Add
        </label>
        <input
          id={`rx-${eye}-add-${uid}`}
          name={`${eye}_add`}
          className="input"
          defaultValue={num(rx?.[`${eye}_add`])}
          placeholder="+1.00"
        />
      </div>
    </div>
  );

  return (
    <form
      ref={formRef}
      action={handle}
      className="card space-y-3"
      data-testid="optical-prescription-form"
    >
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add prescription
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={rx!.id} />}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`rx-kind-${uid}`}>
            Type
          </label>
          <select
            id={`rx-kind-${uid}`}
            name="kind"
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value as OpticalKind)}
          >
            {OPTICAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`rx-pd-${uid}`}>
            PD (mm)
          </label>
          <input
            id={`rx-pd-${uid}`}
            name="pd"
            className="input"
            defaultValue={num(rx?.pd)}
            placeholder="63"
          />
        </div>
      </div>

      {eyeRow("od", "Right eye (OD)")}
      {eyeRow("os", "Left eye (OS)")}

      {kind === "contacts" && (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="label" htmlFor={`rx-bc-${uid}`}>
              Base curve
            </label>
            <input
              id={`rx-bc-${uid}`}
              name="base_curve"
              className="input"
              defaultValue={num(rx?.base_curve)}
              placeholder="8.6"
            />
          </div>
          <div>
            <label className="label" htmlFor={`rx-dia-${uid}`}>
              Diameter
            </label>
            <input
              id={`rx-dia-${uid}`}
              name="diameter"
              className="input"
              defaultValue={num(rx?.diameter)}
              placeholder="14.2"
            />
          </div>
          <div>
            <label className="label" htmlFor={`rx-brand-${uid}`}>
              Brand
            </label>
            <input
              id={`rx-brand-${uid}`}
              name="brand"
              className="input"
              defaultValue={rx?.brand ?? ""}
              placeholder="Acuvue"
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`rx-issued-${uid}`}>
            Issued
          </label>
          <DateField
            id={`rx-issued-${uid}`}
            name="issued_date"
            defaultValue={rx?.issued_date ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor={`rx-expiry-${uid}`}>
            Expires
          </label>
          <DateField
            id={`rx-expiry-${uid}`}
            name="expiry_date"
            defaultValue={rx?.expiry_date ?? ""}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`rx-provider-${uid}`}>
          Prescriber
        </label>
        {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
        <ProviderCombobox
          id={`rx-provider-${uid}`}
          name="provider"
          ariaLabel="Prescriber"
          defaultValue={rx?.provider_name ?? ""}
          placeholder="e.g. Dr. Nguyen (optometrist)"
        />
        {editing && (
          <>
            <input
              type="hidden"
              name="provider_id"
              value={rx?.provider_id ?? ""}
            />
            <input
              type="hidden"
              name="provider_loaded"
              value={rx?.provider_name ?? ""}
            />
          </>
        )}
      </div>
      <div>
        <label className="label" htmlFor={`rx-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`rx-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={rx?.notes ?? ""}
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
