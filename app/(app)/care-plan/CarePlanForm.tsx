"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import type { CarePlanItem } from "@/lib/types";

// Shared add/edit care-plan form. Add mode: no `item`. Edit mode: pass the row + an
// `onDone` callback (renders a hidden id + a Cancel button). The provider is a
// create-on-type input backed by the page's shared <datalist id="provider-names">.
export default function CarePlanForm({
  action,
  item,
  onDone,
}: {
  action: (formData: FormData) => Promise<void>;
  item?: CarePlanItem;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!item;
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("description") ?? "").trim()) {
      setError("Enter the planned item.");
      return;
    }
    try {
      await action(formData);
    } catch {
      setError("Couldn't save this care-plan item. Please try again.");
      return;
    }
    toast(editing ? "Care-plan item updated" : "Care-plan item saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = item?.id ?? "new";
  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add care-plan item
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={item!.id} />}
      <div>
        <label className="label" htmlFor={`cp-desc-${uid}`}>
          Planned item
        </label>
        <input
          id={`cp-desc-${uid}`}
          name="description"
          className="input"
          defaultValue={item?.description ?? ""}
          placeholder="e.g. Follow-up colonoscopy, Lipid panel"
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`cp-category-${uid}`}>
            Category
          </label>
          <input
            id={`cp-category-${uid}`}
            name="category"
            className="input"
            defaultValue={item?.category ?? ""}
            placeholder="procedure / encounter / …"
          />
        </div>
        <div>
          <label className="label" htmlFor={`cp-status-${uid}`}>
            Status
          </label>
          <input
            id={`cp-status-${uid}`}
            name="status"
            className="input"
            defaultValue={item?.status ?? ""}
            placeholder="planned / active / …"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`cp-code-${uid}`}>
            Code
          </label>
          <input
            id={`cp-code-${uid}`}
            name="code"
            className="input"
            defaultValue={item?.code ?? ""}
            placeholder="e.g. 45378"
          />
        </div>
        <div>
          <label className="label" htmlFor={`cp-codesys-${uid}`}>
            Code system
          </label>
          <input
            id={`cp-codesys-${uid}`}
            name="code_system"
            className="input"
            defaultValue={item?.code_system ?? ""}
            placeholder="CPT / SNOMED CT"
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`cp-date-${uid}`}>
          Planned date
        </label>
        <DateField
          id={`cp-date-${uid}`}
          name="planned_date"
          defaultValue={item?.planned_date ?? ""}
        />
      </div>
      <div>
        <label className="label" htmlFor={`cp-provider-${uid}`}>
          Provider
        </label>
        {/* Create-on-type from the shared registry via <datalist id="provider-names">. */}
        <input
          id={`cp-provider-${uid}`}
          name="provider"
          list="provider-names"
          className="input"
          defaultValue={item?.provider_name ?? ""}
          placeholder="e.g. Dr. Smith"
        />
      </div>
      <div>
        <label className="label" htmlFor={`cp-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`cp-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={item?.notes ?? ""}
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
