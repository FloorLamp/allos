"use client";

import { useMemo, useRef, useState } from "react";
import DateField from "./DateField";
import EditLockNotice from "./EditLockNotice";
import SubmitButton from "./SubmitButton";
import Combobox from "./Combobox";
import ProviderCombobox from "./ProviderCombobox";
import { useCanonicalNames } from "./CanonicalNamesContext";
import { useToast } from "./Toast";
import { useFocusFormOnParam } from "./useFocusFormOnParam";
import DraftRestoreBanner from "./DraftRestoreBanner";
import { useFormDraft } from "./useFormDraft";
import { useAddEntryModalClose } from "./AddEntryPanel";
import { MEDICAL_CATEGORIES } from "@/lib/medical-categories";
import { BIOMARKER_GROUP_LABELS } from "@/lib/biomarker-rank";
import { biomarkerSearchTerms } from "@/lib/canonical-name";
import {
  RESULT_STATUSES,
  RESULT_STATUS_LABELS,
  SPECIMEN_SUGGESTIONS,
} from "@/lib/lab-result-lifecycle";
import type { FormResult, ClinicalObservation } from "@/lib/types";

// Only clinical flags are user-settable; "non-optimal" is derived from the
// canonical optimal band, so it's not offered here.
const FLAGS = ["normal", "high", "low", "abnormal"] as const;

// The shared clinical-result form, for both the add slot (Readings page) and the
// inline observation editor (document view + Readings rows). `mode` toggles which fields
// show and the submit label: add mode carries the manual-entry field set (the
// columns addResult reads); edit mode additionally exposes panel / flag / provider
// (the columns updateResult writes). `action` is the server action to call —
// addResult or updateResult — so the two callers stay on the same profile-scoped,
// flag-reconciling write path.
//
// It renders a bare <form> (no card) so a table cell can host the edit variant;
// the add caller wraps it in its own card. The canonical-name suggestions come from
// the host page's CanonicalNamesProvider; the "Performed by" picker is the shared
// ProviderCombobox (#1176/#1177) over the section's ProviderOptionsProvider rows.
export default function ResultForm({
  action,
  mode,
  observation,
  onDone,
  categories = MEDICAL_CATEGORIES,
  defaultDate,
  defaultCategory,
  defaultName,
  writeProfileId,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  mode: "add" | "edit";
  // The row being edited (edit mode). Its columns seed the field defaults.
  observation?: ClinicalObservation;
  // Multi-view (#1331): the SUBJECT profile this edit targets. Posted as a hidden
  // `profile_id` so updateResult's gateItemProfile() writes the row's own member,
  // not the acting profile. Omitted in single view (the default) → no hidden field,
  // gateItemProfile falls back to the acting-profile gate — byte-identical.
  writeProfileId?: number;
  // Called after a successful submit — the row editor closes on it.
  onDone?: () => void;
  // Category <select> options. Defaults to the full enum; the Readings page
  // passes its prescription-less list so a med can't be added/relabelled there.
  categories?: readonly string[];
  // Add mode: the initial date (today in the profile's tz) and category.
  defaultDate?: string;
  defaultCategory?: string;
  // Add mode: prefill the name field — the command palette's "Add result" hit
  // action lands here name-carrying (#662). Also seeds the canonical name, which
  // defaults to the name.
  defaultName?: string;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = mode === "edit";
  const uid = observation?.id ?? "new";
  const [error, setError] = useState<string | null>(null);
  // The canonical-name field is a controlled Combobox (#1177), so form.reset() can't
  // clear it — the add path resets this state explicitly on a successful save.
  // Relevance-ranked, group-tagged canonical names (#1675) — same list, same order,
  // in the Biomarkers add slot, the inline row editor, and the import mapping field.
  const canonicalOptions = useCanonicalNames();
  const canonicalNames = useMemo(
    () => canonicalOptions.map((option) => option.name),
    [canonicalOptions]
  );
  const canonicalGroups = useMemo(
    () =>
      new Map(
        canonicalOptions.map((option) => [
          option.name,
          BIOMARKER_GROUP_LABELS[option.group],
        ])
      ),
    [canonicalOptions]
  );
  const [canonical, setCanonical] = useState(observation?.canonical_name ?? "");
  // Same controlled-Combobox treatment for the specimen picker (#1404): form.reset()
  // can't clear a controlled input, so the add path clears it explicitly on save.
  const [specimen, setSpecimen] = useState(observation?.specimen ?? "");

  // Local draft (#1699). Every field but the two controlled comboboxes is a named
  // input, so `extra` only carries those.
  const draftExtra = useMemo(
    () => ({ canonical, specimen }),
    [canonical, specimen]
  );
  type ResultDraft = typeof draftExtra;
  const draft = useFormDraft<ResultDraft>({
    // Compatibility: this local-draft key predates the terminology change. Keeping
    // it lets an in-progress form survive the upgrade without a storage migration.
    formKey: "medical-record",
    recordId: observation?.id ?? null,
    formRef,
    extra: draftExtra,
    onRestore: (d) => {
      setCanonical(d.canonical);
      setSpecimen(d.specimen);
    },
  });

  // The add form focuses itself when reached from the palette's "Add result"
  // action (issue #29); the inline row editors (edit mode) opt out.
  useFocusFormOnParam(formRef, "new", undefined, mode === "add");

  async function handle(formData: FormData) {
    setError(null);
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this result. Try again.");
      return;
    }
    // A validation guard now answers with a typed error instead of a silent
    // resolve — surface it inline and DON'T toast success or reset (issue #474).
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Saved for real — the draft has nothing left to protect (#1699).
    draft.clear();
    if (editing) {
      onDone?.();
    } else {
      // Add: the server action revalidates the list; clear the form for the next
      // entry and confirm the save.
      formRef.current?.reset();
      setCanonical("");
      setSpecimen("");
      toast("Result saved");
      closeEntryModal?.();
    }
  }

  return (
    <form ref={formRef} action={handle} className="grid gap-3 sm:grid-cols-4">
      <DraftRestoreBanner
        draft={draft}
        noun="result"
        className="sm:col-span-4"
      />
      {editing && <input type="hidden" name="id" value={observation!.id} />}
      {editing && writeProfileId != null && (
        <input type="hidden" name="profile_id" value={writeProfileId} />
      )}
      <div>
        <label className="label" htmlFor={`rec-${uid}-date`}>
          Date
        </label>
        <DateField
          id={`rec-${uid}-date`}
          name="date"
          defaultValue={observation?.date ?? defaultDate ?? ""}
          required
        />
      </div>
      <div>
        <label className="label" htmlFor={`rec-${uid}-category`}>
          Category
        </label>
        <select
          id={`rec-${uid}-category`}
          name="category"
          className="input capitalize"
          defaultValue={observation?.category ?? defaultCategory ?? "lab"}
        >
          {categories.map((c) => (
            <option key={c} value={c} className="capitalize">
              {c}
            </option>
          ))}
        </select>
      </div>
      {editing && (
        <>
          <div>
            <label className="label" htmlFor={`rec-${uid}-panel`}>
              Panel
            </label>
            <input
              id={`rec-${uid}-panel`}
              name="panel"
              defaultValue={observation?.panel ?? ""}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor={`rec-${uid}-flag`}>
              Flag
            </label>
            <select
              id={`rec-${uid}-flag`}
              name="flag"
              className="input"
              defaultValue={observation?.flag ?? ""}
            >
              <option value="">—</option>
              {FLAGS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`rec-${uid}-name`}>
          Name
        </label>
        <input
          id={`rec-${uid}-name`}
          name="name"
          defaultValue={observation?.name ?? defaultName ?? ""}
          className="input"
          placeholder="e.g. LDL cholesterol"
          required
        />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`rec-${uid}-canonical`}>
          Canonical name
        </label>
        <Combobox
          id={`rec-${uid}-canonical`}
          name="canonical_name"
          ariaLabel="Canonical name"
          value={canonical}
          onChange={setCanonical}
          options={canonicalNames}
          groupFor={(option) => canonicalGroups.get(option) ?? null}
          // #2382: the analyte's own acronym and its curated aliases are searched
          // as their own keys, so "psa" reaches Prostate-Specific Antigen (PSA) —
          // which the greedy subsequence walk over the long name never could.
          searchTermsFor={biomarkerSearchTerms}
          allowFreeText
          placeholder="defaults to name"
        />
      </div>
      <div>
        <label className="label" htmlFor={`rec-${uid}-value`}>
          Value
        </label>
        <input
          id={`rec-${uid}-value`}
          name="value"
          defaultValue={observation?.value ?? ""}
          className="input"
          placeholder="e.g. 95"
        />
      </div>
      <div>
        <label className="label" htmlFor={`rec-${uid}-unit`}>
          Unit
        </label>
        <input
          id={`rec-${uid}-unit`}
          name="unit"
          defaultValue={observation?.unit ?? ""}
          className="input"
          placeholder="mg/dL"
        />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`rec-${uid}-reference`}>
          Reference range
        </label>
        <input
          id={`rec-${uid}-reference`}
          name="reference_range"
          defaultValue={observation?.reference_range ?? ""}
          className="input"
          placeholder="< 100"
        />
      </div>
      {/* The collection attributes of a reading (#1404). Offered in BOTH modes: a
          hand-entered fasting glucose needs its fasting state as much as an imported
          one, and a user transcribing a corrected report needs to say so. All three
          default to "unstated" — never to "final" / "non-fasting", which would be a
          claim the reading doesn't make. */}
      <div>
        <label className="label" htmlFor={`rec-${uid}-result-status`}>
          Result status
        </label>
        <select
          id={`rec-${uid}-result-status`}
          name="result_status"
          className="input capitalize"
          data-testid="record-result-status"
          defaultValue={observation?.result_status ?? ""}
        >
          <option value="">—</option>
          {RESULT_STATUSES.map((s) => (
            <option key={s} value={s} className="capitalize">
              {RESULT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`rec-${uid}-fasting`}>
          Fasting
        </label>
        <select
          id={`rec-${uid}-fasting`}
          name="fasting"
          className="input"
          data-testid="record-fasting"
          defaultValue={
            observation?.fasting == null ? "" : String(observation.fasting)
          }
        >
          <option value="">—</option>
          <option value="1">Fasting</option>
          <option value="0">Non-fasting</option>
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`rec-${uid}-specimen`}>
          Specimen
        </label>
        {/* The shared Combobox in free-text mode (#1176/#1177), never a native
            datalist: the suggestions are a curated STARTING point, and a lab that
            prints "Capillary Whole Blood" must still be typeable. */}
        <Combobox
          id={`rec-${uid}-specimen`}
          name="specimen"
          ariaLabel="Specimen"
          value={specimen}
          onChange={setSpecimen}
          options={[...SPECIMEN_SUGGESTIONS]}
          allowFreeText
          placeholder="e.g. Serum"
        />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`rec-${uid}-notes`}>
          Notes
        </label>
        <input
          id={`rec-${uid}-notes`}
          name="notes"
          defaultValue={observation?.notes ?? ""}
          className="input"
        />
      </div>
      {editing && (
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`rec-${uid}-provider`}>
            Performed by
          </label>
          {/* Provider picker: create-on-type ProviderCombobox (#1176) over the
              section's shared registry rows. */}
          <ProviderCombobox
            id={`rec-${uid}-provider`}
            name="provider"
            defaultValue={observation?.provider_name ?? ""}
            placeholder="e.g. Quest Diagnostics"
          />
          {/* Round-trip the loaded link so an untouched field keeps its id (#601). */}
          <input
            type="hidden"
            name="provider_id"
            value={observation?.provider_id ?? ""}
          />
          <input
            type="hidden"
            name="provider_loaded"
            value={observation?.provider_name ?? ""}
          />
        </div>
      )}
      {editing && (
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`rec-${uid}-ordering-provider`}>
            Ordered by
          </label>
          {/* The clinician who ORDERED the test, distinct from the performing lab
              above (#1404) — "Dr. A ordered it, Quest ran it" used to collapse into
              one link. Same shared registry, same create-on-type picker. */}
          <ProviderCombobox
            id={`rec-${uid}-ordering-provider`}
            name="ordering_provider"
            defaultValue={observation?.ordering_provider_name ?? ""}
            placeholder="e.g. Dr. Ada Lovelace"
          />
          <input
            type="hidden"
            name="ordering_provider_id"
            value={observation?.ordering_provider_id ?? ""}
          />
          <input
            type="hidden"
            name="ordering_provider_loaded"
            value={observation?.ordering_provider_name ?? ""}
          />
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="text-sm text-rose-600 sm:col-span-4 dark:text-rose-400"
        >
          {error}
        </p>
      )}
      <div className="flex items-end gap-2 sm:col-span-4">
        <SubmitButton pendingLabel="Saving…">
          {editing ? "Save" : "Save result"}
        </SubmitButton>
        {editing && onDone && (
          <button type="button" onClick={onDone} className="btn-ghost">
            Cancel
          </button>
        )}
      </div>
      {/* Edit-lock badge + resume affordance for a hand-edited imported reading
          (#659): only source-owned rows (external_id set) carry the lock. */}
      {editing && !!observation?.edited && !!observation?.external_id && (
        <div className="sm:col-span-4">
          <EditLockNotice table="medical_records" id={observation!.id} />
        </div>
      )}
    </form>
  );
}
