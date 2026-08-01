"use client";

import { useRef, useState } from "react";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import { useToast } from "@/components/Toast";
import {
  CARE_PLAN_CATEGORIES,
  CARE_PLAN_CATEGORY_LABELS,
  CARE_PLAN_CLOSED_STATUS_LIST,
  CARE_PLAN_OPEN_STATUSES,
  isRecognizedCarePlanStatus,
} from "@/lib/care-plan-upcoming";
import type { CarePlanItem, FormResult } from "@/lib/types";

// The sentinel the two pickers use for "none of the above, let me type it". It is
// never stored — the paired text field owns the posted value.
const OTHER = "__other";

// Whether a loaded value is one of the offered options (case-insensitively), so an
// imported row's own spelling opens the picker on "Other" with its text preserved
// instead of silently snapping to a neighbour.
function offered(
  value: string | null | undefined,
  options: readonly string[]
): string | null {
  const v = value?.trim();
  if (!v) return null;
  return options.find((o) => o.toLowerCase() === v.toLowerCase()) ?? null;
}

// Shared add/edit care-plan form. Add mode: no `item`. Edit mode: pass the row + an
// `onDone` callback (renders a hidden id + a Cancel button). The provider is a
// create-on-type ProviderCombobox (#1176) over the section's shared registry rows.
export default function CarePlanForm({
  action,
  item,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  item?: CarePlanItem;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
}) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!item;
  const [error, setError] = useState<string | null>(null);
  // Category and status were bare inputs (#1676). Status is the one that mattered:
  // isCarePlanItemOpen() only recognizes a curated set of CLOSED spellings, so a
  // hand-typed "finished" left the item nudging Upcoming forever. Both are now enum
  // pickers with an explicit, visibly-labelled free-text escape.
  const loadedCategory = offered(item?.category, CARE_PLAN_CATEGORIES);
  const [category, setCategory] = useState(
    item?.category?.trim() ? (loadedCategory ?? OTHER) : ""
  );
  const [categoryOther, setCategoryOther] = useState(
    loadedCategory ? "" : (item?.category ?? "")
  );
  const RECOGNIZED_STATUSES = [
    ...CARE_PLAN_OPEN_STATUSES,
    ...CARE_PLAN_CLOSED_STATUS_LIST,
  ];
  const loadedStatus = offered(item?.status, RECOGNIZED_STATUSES);
  const [status, setStatus] = useState(
    item?.status?.trim() ? (loadedStatus ?? OTHER) : ""
  );
  const [statusOther, setStatusOther] = useState(
    loadedStatus ? "" : (item?.status ?? "")
  );

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("description") ?? "").trim()) {
      setError("Enter the planned item.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this care-plan item. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Care-plan item updated" : "Care-plan item saved");
    if (!editing) {
      formRef.current?.reset();
      setCategory("");
      setCategoryOther("");
      setStatus("");
      setStatusOther("");
    }
    onDone?.();
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
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
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
          {/* The buckets the Plan-of-Treatment importer already writes, so a manual
              item and an imported one classify the same way. */}
          <select
            id={`cp-category-${uid}`}
            className="input"
            data-testid={`cp-category-select-${uid}`}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Not stated</option>
            {CARE_PLAN_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CARE_PLAN_CATEGORY_LABELS[c]}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
          {category === OTHER ? (
            <input
              name="category"
              className="input mt-2"
              aria-label="Other category"
              data-testid={`cp-category-other-${uid}`}
              value={categoryOther}
              onChange={(e) => setCategoryOther(e.target.value)}
              placeholder="Describe the kind of planned care"
            />
          ) : (
            <input type="hidden" name="category" value={category} />
          )}
        </div>
        <div>
          <label className="label" htmlFor={`cp-status-${uid}`}>
            Status
          </label>
          <select
            id={`cp-status-${uid}`}
            className="input"
            data-testid={`cp-status-select-${uid}`}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Not stated</option>
            <optgroup label="Open — keeps nudging Upcoming">
              {CARE_PLAN_OPEN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </optgroup>
            <optgroup label="Closed — stops nudging">
              {CARE_PLAN_CLOSED_STATUS_LIST.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </optgroup>
            <option value={OTHER}>Other…</option>
          </select>
          {status === OTHER ? (
            <input
              name="status"
              className="input mt-2"
              aria-label="Other status"
              data-testid={`cp-status-other-${uid}`}
              value={statusOther}
              onChange={(e) => setStatusOther(e.target.value)}
              placeholder="e.g. awaiting authorization"
            />
          ) : (
            <input type="hidden" name="status" value={status} />
          )}
        </div>
      </div>
      {/* The unrecognized-status fate, said out loud instead of discovered weeks
          later (#1676). An unknown status counts as OPEN — the safe direction for a
          real plan with an odd imported status, and unchanged by this issue — which
          means a free-text "finished" does NOT close the item. */}
      {status === OTHER && !isRecognizedCarePlanStatus(statusOther) && (
        <p
          data-testid={`cp-status-unrecognized-${uid}`}
          className="text-xs text-amber-700 dark:text-amber-400"
        >
          A status outside the list above sits outside the open/closed
          machinery: this item keeps counting as open and keeps appearing in
          Upcoming. Pick a closed status to stop it.
        </p>
      )}
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
        {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
        <ProviderCombobox
          id={`cp-provider-${uid}`}
          name="provider"
          defaultValue={item?.provider_name ?? ""}
          placeholder="e.g. Dr. Smith"
        />
        {/* Round-trip the loaded link so the action keeps it when the field is
            untouched, instead of re-resolving an ambiguous name into a dup (#601). */}
        {editing && (
          <>
            <input
              type="hidden"
              name="provider_id"
              value={item?.provider_id ?? ""}
            />
            <input
              type="hidden"
              name="provider_loaded"
              value={item?.provider_name ?? ""}
            />
          </>
        )}
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
