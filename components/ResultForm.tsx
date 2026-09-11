"use client";

import { useMemo, useRef, useState } from "react";
import DateField from "./DateField";
import EditLockNotice from "./EditLockNotice";
import Button from "./Button";
import SubmitButton from "./SubmitButton";
import Combobox from "./Combobox";
import ProviderCombobox from "./ProviderCombobox";
import InlineError from "./InlineError";
import { useCanonicalNames } from "./CanonicalNamesContext";
import { useToast } from "./Toast";
import { useFocusFormOnParam } from "./useFocusFormOnParam";
import DraftRestoreBanner from "./DraftRestoreBanner";
import { useFormDraft } from "./useFormDraft";
import { useAddEntryModalClose } from "./AddEntryPanel";
import { useFormatPrefs } from "./FormatPrefsProvider";
import FactEditorHost, { useFactEditor } from "./facts/FactEditorHost";
import RecordFactRow, { RecordFactMoreMenu } from "./records/RecordFactRow";
import { ASSIGNABLE_MEDICAL_CATEGORIES } from "@/lib/medical-categories";
import { BIOMARKER_GROUP_LABELS } from "@/lib/biomarker-rank";
import { biomarkerSearchTerms } from "@/lib/canonical-name";
import {
  RESULT_STATUSES,
  RESULT_STATUS_LABELS,
  SPECIMEN_SUGGESTIONS,
} from "@/lib/lab-result-lifecycle";
import {
  resultFactSummary,
  RESULT_FACT_NOUNS,
  type ResultFactKey,
} from "@/lib/result-facts";
import type { FormResult, ClinicalObservation } from "@/lib/types";

// Only clinical flags are user-settable; "non-optimal" is derived from the
// canonical optimal band, so it's not offered here.
const FLAGS = ["normal", "high", "low", "abnormal"] as const;

// WHICH PANELS EXIST is the fact keys plus the trailing affordance's own menu — the
// intake form's shape (#3216).
type ResultOpenPanel = ResultFactKey | "more";

// The shared clinical-result form, on the facts-with-editors primitive (#5302, over
// #3218 and #5300's grammar) — the largest of the twelve. It serves both the add slot
// (Clinical results page) and the inline observation editor (document view + Clinical
// results rows). `mode` toggles which fields show and the submit label: add mode
// carries the manual-entry field set (the columns addResult reads); edit mode
// additionally exposes panel / flag / provider / ordering provider (the columns
// updateResult writes). `action` is the server action to call — addResult or
// updateResult — so the two callers stay on the same profile-scoped, flag-reconciling
// write path.
//
// WHAT CHANGED, and what deliberately did not. Fifteen labelled controls stood open in
// a four-column grid. Now the NAME is rule 1's one identifying field, the row states
// the DATE, the CATEGORY and the READING — the value and its unit as one fact, argued
// against the consumers in lib/result-facts — and everything else lives behind the one
// trailing affordance. The five edit-only facts are absent from the summary in add
// mode, because `addResult` parses none of them and a fact the form does not post is
// not a fact. The write is untouched: the same `<form action={…}>` posts the same named
// fields to the same Server Action.
//
// TWO `required` ATTRIBUTES DID NOT SURVIVE, and this is the one place the adoption
// could not carry an affordance across: a `required` control inside a HIDDEN panel is
// not focusable, so the browser refuses a submit it cannot point at. `date` and
// `category` moved into editors and lost theirs; NAME keeps its, because the
// identifying field is never hidden. Neither guard moved — both actions already answer
// a bad date with `formError("Enter a valid date.")` and resolve an unrecognized
// category to 'lab' server-side — and the dashed chips now ask before the submit does.
//
// It renders a bare <form> (no card) so a table cell can host the edit variant;
// the add caller wraps it in its own card. The canonical-name suggestions come from
// the host page's CanonicalNamesProvider; the "Performed by" picker is the shared
// ProviderCombobox (#1176/#1177) over the section's ProviderOptionsProvider rows.
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden; an unmounted field is a field the form CLEARS
// (#2359), one the dirty-form registry cannot see, and one the local draft (#1699)
// would silently drop.
export default function ResultForm({
  action,
  mode,
  observation,
  onDone,
  categories = ASSIGNABLE_MEDICAL_CATEGORIES,
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
  // Category <select> options. Defaults to the full enum; the Clinical results page
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
  const prefs = useFormatPrefs();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = mode === "edit";
  const uid = observation?.id ?? "new";
  const [error, setError] = useState<string | null>(null);
  // The canonical-name field is a controlled Combobox (#1177), so form.reset() can't
  // clear it — the add path resets this state explicitly on a successful save.
  // Relevance-ranked, group-tagged canonical names (#1675) — same list, same order,
  // in the Clinical results add slot, the inline row editor, and the import mapping field.
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
  // The date is controlled for the chip: `DateField` has no uncontrolled change
  // callback, and its named input is `type="hidden"`.
  const [date, setDate] = useState(observation?.date ?? defaultDate ?? "");
  // The chips' copies of the DOM-owned fields. `defaultValue` keeps the browser's
  // value the one that posts; these only draw the sentence, and a draft restore
  // updates them because it writes through the native setter and dispatches `input`.
  const [name, setName] = useState(observation?.name ?? defaultName ?? "");
  const [category, setCategory] = useState(
    observation?.category ?? defaultCategory ?? ""
  );
  const [value, setValue] = useState(observation?.value ?? "");
  const [unit, setUnit] = useState(observation?.unit ?? "");
  const [referenceRange, setReferenceRange] = useState(
    observation?.reference_range ?? ""
  );
  const [resultStatus, setResultStatus] = useState(
    observation?.result_status ?? ""
  );
  const [fasting, setFasting] = useState(
    observation?.fasting == null ? "" : String(observation.fasting)
  );
  const [notes, setNotes] = useState(observation?.notes ?? "");
  const [panel, setPanel] = useState(observation?.panel ?? "");
  const [flag, setFlag] = useState(observation?.flag ?? "");
  const [provider, setProvider] = useState(observation?.provider_name ?? "");
  const [orderingProvider, setOrderingProvider] = useState(
    observation?.ordering_provider_name ?? ""
  );

  // Local draft (#1699). `extra` carries the state the native restore cannot reach:
  // the two controlled comboboxes, and the date — whose posted input is hidden, so a
  // value written into it would be reverted by the next controlled render.
  const draftExtra = useMemo(
    () => ({ canonical, specimen, date }),
    [canonical, specimen, date]
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
      // A draft written before this field joined `extra` has no date in it.
      setDate(d.date ?? "");
    },
  });

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<ResultOpenPanel>({ scopeRef: formRef });

  const summary = resultFactSummary({
    date,
    category,
    name,
    canonical,
    value,
    unit,
    referenceRange,
    specimen,
    fasting,
    resultStatus,
    notes,
    editing,
    panel,
    flag,
    provider,
    orderingProvider,
    prefs,
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
      setDate(defaultDate ?? "");
      setName("");
      setCategory(defaultCategory ?? "");
      setValue("");
      setUnit("");
      setReferenceRange("");
      setResultStatus("");
      setFasting("");
      setNotes("");
      closePanel();
      toast("Result saved");
      closeEntryModal?.();
    }
  }

  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="result-form"
    >
      <DraftRestoreBanner draft={draft} noun="result" />
      {editing && <input type="hidden" name="id" value={observation!.id} />}
      {editing && writeProfileId != null && (
        <input type="hidden" name="profile_id" value={writeProfileId} />
      )}
      <div>
        <label className="label" htmlFor={`rec-${uid}-name`}>
          Name
        </label>
        <input
          id={`rec-${uid}-name`}
          name="name"
          defaultValue={observation?.name ?? defaultName ?? ""}
          onChange={(e) => setName(e.target.value)}
          className="input"
          placeholder="e.g. LDL cholesterol"
          required
        />
      </div>

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {openEditor == null && (
        <RecordFactRow
          prefix="result"
          summary={summary}
          nouns={RESULT_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(p, focusKey) => openPanel(p as ResultOpenPanel, focusKey)}
        />
      )}

      <FactEditorHost
        testId="result-editor"
        doneTestId="result-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        // Hidden rather than unmounted — see the header: this form is DOM-collected,
        // so an unmounted field is a cleared field and a dropped draft.
        className={openEditor == null ? "hidden" : undefined}
      >
        <div hidden={openEditor !== "date"}>
          <label className="label" htmlFor={`rec-${uid}-date`}>
            Date
          </label>
          <DateField
            id={`rec-${uid}-date`}
            name="date"
            value={date}
            onChange={setDate}
          />
        </div>

        <div hidden={openEditor !== "category"}>
          <label className="label" htmlFor={`rec-${uid}-category`}>
            Category
          </label>
          <select
            id={`rec-${uid}-category`}
            name="category"
            className="input capitalize"
            defaultValue={observation?.category ?? defaultCategory ?? ""}
            onChange={(e) => setCategory(e.target.value)}
          >
            {!observation?.category && !defaultCategory && (
              <option value="">Choose category</option>
            )}
            {categories.map((c) => (
              <option key={c} value={c} className="capitalize">
                {c}
              </option>
            ))}
          </select>
        </div>

        {/* The value and its unit are ONE fact over ONE editor: a number without its
            unit is not a smaller fact, it is a different one (lib/result-facts). */}
        <div hidden={openEditor !== "reading"}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`rec-${uid}-value`}>
                Value
              </label>
              <input
                id={`rec-${uid}-value`}
                name="value"
                defaultValue={observation?.value ?? ""}
                onChange={(e) => setValue(e.target.value)}
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
                onChange={(e) => setUnit(e.target.value)}
                className="input"
                placeholder="mg/dL"
              />
            </div>
          </div>
        </div>

        <div hidden={openEditor !== "canonical"}>
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

        <div hidden={openEditor !== "reference"}>
          <label className="label" htmlFor={`rec-${uid}-reference`}>
            Reference range
          </label>
          <input
            id={`rec-${uid}-reference`}
            name="reference_range"
            defaultValue={observation?.reference_range ?? ""}
            onChange={(e) => setReferenceRange(e.target.value)}
            className="input"
            placeholder="< 100"
          />
        </div>

        {/* The collection attributes of a reading (#1404). Offered in BOTH modes: a
            hand-entered fasting glucose needs its fasting state as much as an imported
            one, and a user transcribing a corrected report needs to say so. All three
            default to "unstated" — never to "final" / "non-fasting", which would be a
            claim the reading doesn't make. */}
        <div hidden={openEditor !== "status"}>
          <label className="label" htmlFor={`rec-${uid}-result-status`}>
            Result status
          </label>
          <select
            id={`rec-${uid}-result-status`}
            name="result_status"
            className="input capitalize"
            data-testid="record-result-status"
            defaultValue={observation?.result_status ?? ""}
            onChange={(e) => setResultStatus(e.target.value)}
          >
            <option value="">—</option>
            {RESULT_STATUSES.map((s) => (
              <option key={s} value={s} className="capitalize">
                {RESULT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        <div hidden={openEditor !== "fasting"}>
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
            onChange={(e) => setFasting(e.target.value)}
          >
            <option value="">—</option>
            <option value="1">Fasting</option>
            <option value="0">Non-fasting</option>
          </select>
        </div>

        <div hidden={openEditor !== "specimen"}>
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

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`rec-${uid}-notes`}>
            Notes
          </label>
          <input
            id={`rec-${uid}-notes`}
            name="notes"
            defaultValue={observation?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
            className="input"
          />
        </div>

        {/* The four columns only `updateResult` writes. Rendered in edit mode alone,
            which is also why the add door's summary never names them. */}
        {editing && (
          <>
            <div hidden={openEditor !== "panel"}>
              <label className="label" htmlFor={`rec-${uid}-panel`}>
                Panel
              </label>
              <input
                id={`rec-${uid}-panel`}
                name="panel"
                defaultValue={observation?.panel ?? ""}
                onChange={(e) => setPanel(e.target.value)}
                className="input"
              />
            </div>

            <div hidden={openEditor !== "flag"}>
              <label className="label" htmlFor={`rec-${uid}-flag`}>
                Flag
              </label>
              <select
                id={`rec-${uid}-flag`}
                name="flag"
                className="input"
                defaultValue={observation?.flag ?? ""}
                onChange={(e) => setFlag(e.target.value)}
              >
                <option value="">—</option>
                {FLAGS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>

            <div hidden={openEditor !== "provider"}>
              <label className="label" htmlFor={`rec-${uid}-provider`}>
                Performed by
              </label>
              {/* Provider picker: create-on-type ProviderCombobox (#1176) over the
                  section's shared registry rows. */}
              <ProviderCombobox
                id={`rec-${uid}-provider`}
                name="provider"
                defaultValue={observation?.provider_name ?? ""}
                onChange={setProvider}
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

            <div hidden={openEditor !== "ordering"}>
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
                onChange={setOrderingProvider}
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
          </>
        )}

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="result"
            more={summary.more}
            nouns={RESULT_FACT_NOUNS}
            onOpen={(p) => openPanel(p as ResultOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex items-end gap-2">
        <SubmitButton pendingLabel="Saving…" variant="primary">
          {editing ? "Save" : "Save result"}
        </SubmitButton>
        {editing && onDone && <Button onClick={onDone}>Cancel</Button>}
      </div>
      {/* Edit-lock badge + resume affordance for a hand-edited imported reading
          (#659): only source-owned rows (external_id set) carry the lock. */}
      {editing && !!observation?.edited && !!observation?.external_id && (
        <EditLockNotice table="medical_records" id={observation!.id} />
      )}
    </form>
  );
}
