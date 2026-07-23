"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import { useToast } from "@/components/Toast";
import type { Procedure, FormResult } from "@/lib/types";

// Shared add/edit procedure form. Add mode: no `procedure`. Edit mode: pass the row
// + an `onDone` callback (renders a hidden id + a Cancel button). The performer is a
// create-on-type ProviderCombobox (#1176) over the section's shared registry rows.
export default function ProcedureForm({
  action,
  procedure,
  onDone,
  prefillName,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  procedure?: Procedure;
  onDone?: () => void;
  // Deep-link prefill (#1083, mirrors #662): a preventive procedure-screening row/nudge
  // lands on the procedures page with `?new=1&name=<procedure>`; the add form seeds the
  // name field + focuses it. Add mode only (ignored when editing an existing row).
  prefillName?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!procedure;
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("name") ?? "").trim()) {
      setError("Enter the procedure name.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this procedure. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Procedure updated" : "Procedure saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = procedure?.id ?? "new";
  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add procedure
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={procedure!.id} />}
      <div>
        <label className="label" htmlFor={`proc-name-${uid}`}>
          Procedure
        </label>
        <input
          id={`proc-name-${uid}`}
          name="name"
          className="input"
          defaultValue={
            procedure?.name ?? (!editing ? (prefillName ?? "") : "")
          }
          autoFocus={!editing && !!prefillName}
          placeholder="e.g. Appendectomy, Colonoscopy"
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`proc-code-${uid}`}>
            Code
          </label>
          <input
            id={`proc-code-${uid}`}
            name="code"
            className="input"
            defaultValue={procedure?.code ?? ""}
            placeholder="e.g. 44950"
          />
        </div>
        <div>
          <label className="label" htmlFor={`proc-codesys-${uid}`}>
            Code system
          </label>
          <input
            id={`proc-codesys-${uid}`}
            name="code_system"
            className="input"
            defaultValue={procedure?.code_system ?? ""}
            placeholder="CPT / SNOMED CT"
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`proc-date-${uid}`}>
          Date
        </label>
        <DateField
          id={`proc-date-${uid}`}
          name="date"
          defaultValue={procedure?.date ?? ""}
        />
      </div>
      <div>
        <label className="label" htmlFor={`proc-provider-${uid}`}>
          Provider
        </label>
        {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
        <ProviderCombobox
          id={`proc-provider-${uid}`}
          name="provider"
          defaultValue={procedure?.provider_name ?? ""}
          placeholder="e.g. Dr. Smith"
        />
        {/* Round-trip the loaded link so an untouched field keeps its id (#601). */}
        {editing && (
          <>
            <input
              type="hidden"
              name="provider_id"
              value={procedure?.provider_id ?? ""}
            />
            <input
              type="hidden"
              name="provider_loaded"
              value={procedure?.provider_name ?? ""}
            />
          </>
        )}
      </div>
      <div>
        <label className="label" htmlFor={`proc-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`proc-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={procedure?.notes ?? ""}
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
