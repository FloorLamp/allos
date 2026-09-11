"use client";

import { useRef, useState } from "react";
import DateField from "@/components/DateField";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import { useToast } from "@/components/Toast";
import { useAddEntryModalClose } from "@/components/AddEntryPanel";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import RecordFactRow, {
  RecordFactMoreMenu,
} from "@/components/records/RecordFactRow";
import {
  IMAGING_MODALITIES,
  IMAGING_LATERALITIES,
  modalityLabel,
  lateralityLabel,
} from "@/lib/imaging-study";
import {
  imagingStudyFactSummary,
  IMAGING_STUDY_FACT_NOUNS,
  type ImagingStudyFactKey,
} from "@/lib/imaging-study-facts";
import type { ImagingStudy, FormResult } from "@/lib/types";
import InlineError from "@/components/InlineError";

// WHICH PANELS EXIST is the fact keys plus the trailing affordance's own menu — the
// intake form's shape (#3216).
type ImagingOpenPanel = ImagingStudyFactKey | "more";

// Shared add/edit imaging-study form, on the facts-with-editors primitive (#5302, over
// #3218 and #5300's grammar) — the second of slice 4's forms. Add mode: no `study`.
// Edit mode: pass the row + an `onDone` callback (renders a hidden id + a Cancel
// button). Enum fields (modality / laterality) are <select>s so a value can never miss
// the DB CHECK set; the action also re-normalizes on the server. Image pixels / DICOM
// are out of scope — this captures the report's metadata + the radiologist's impression.
//
// WHAT CHANGED, and what deliberately did not. Twelve labelled controls stood open for
// a record whose statement is "this modality, aimed here, on this day". Now the
// MODALITY is rule 1's one identifying field — it is also what `studyDisplayLabel` leads
// with and what both consumers key on — the row states the STUDY DATE, and everything
// that narrows or reads the study lives behind the one trailing affordance. Why the
// body region is NOT an essential here, where the skin form's location is, is argued in
// lib/imaging-study-facts. The write is untouched: the same `<form action={…}>` posts
// the same named fields to the same Server Action.
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden; an unmounted field is a field the form CLEARS
// (#2359) and one the dirty-form registry cannot see. See ConditionForm's header for
// the same reading at the sibling address.
export default function ImagingStudyForm({
  action,
  study,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  study?: ImagingStudy;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const prefs = useFormatPrefs();
  // A study happened; it is not scheduled. A typo'd 2099 date sailed through and put
  // "From your records, since January 1, 2099." on the dose card (#2970), so the field
  // stops at the profile's today.
  const timezone = useTimezone();
  const today = dateStrInTz(timezone);
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!study;
  const [error, setError] = useState<string | null>(null);
  // The chips' copies of the DOM-owned fields: `defaultValue` keeps the browser's value
  // the one that posts, and these only draw the sentence. The date is controlled
  // because `DateField` has no uncontrolled change callback, and its named input is
  // `type="hidden"`, which the dirty-form registry excludes anyway.
  const [studyDate, setStudyDate] = useState(study?.study_date ?? "");
  const [bodyRegion, setBodyRegion] = useState(study?.body_region ?? "");
  const [laterality, setLaterality] = useState(study?.laterality ?? "");
  const [contrast, setContrast] = useState(study?.contrast ?? false);
  const [contrastAgent, setContrastAgent] = useState(
    study?.contrast_agent ?? ""
  );
  const [doseMsv, setDoseMsv] = useState(
    study?.dose_msv == null ? "" : String(study.dose_msv)
  );
  const [indication, setIndication] = useState(study?.indication ?? "");
  const [impression, setImpression] = useState(study?.impression ?? "");
  const [status, setStatus] = useState(study?.status ?? "");
  const [orderingProvider, setOrderingProvider] = useState(
    study?.ordering_provider_name ?? ""
  );
  const [readingProvider, setReadingProvider] = useState(
    study?.reading_provider_name ?? ""
  );
  const [notes, setNotes] = useState(study?.notes ?? "");

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<ImagingOpenPanel>({ scopeRef: formRef });

  const summary = imagingStudyFactSummary({
    studyDate,
    bodyRegion,
    laterality,
    contrast,
    contrastAgent,
    doseMsv,
    indication,
    impression,
    status,
    orderingProvider,
    readingProvider,
    notes,
    prefs,
  });

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
    if (!editing) {
      formRef.current?.reset();
      setStudyDate("");
      setBodyRegion("");
      setLaterality("");
      setContrast(false);
      setContrastAgent("");
      setDoseMsv("");
      setIndication("");
      setImpression("");
      setStatus("");
      setOrderingProvider("");
      setReadingProvider("");
      setNotes("");
      closePanel();
    }
    onDone?.();
    if (!editing) closeEntryModal?.();
  }

  const uid = study?.id ?? "new";
  // Add mode renders in the shared entry modal; edit mode swaps into a table row.
  // The form stays frameless in both places so neither host gets a nested card.
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="imaging-study-form"
    >
      {editing && <input type="hidden" name="id" value={study!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
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

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {openEditor == null && (
        <RecordFactRow
          prefix="imaging-study"
          summary={summary}
          nouns={IMAGING_STUDY_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(panel, focusKey) =>
            openPanel(panel as ImagingOpenPanel, focusKey)
          }
        />
      )}

      <FactEditorHost
        testId="imaging-study-editor"
        doneTestId="imaging-study-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        // Hidden rather than unmounted — see the header: this form is DOM-collected,
        // so an unmounted field is a cleared field.
        className={openEditor == null ? "hidden" : undefined}
      >
        <div hidden={openEditor !== "study_date"}>
          <label className="label" htmlFor={`is-study-date-${uid}`}>
            Study date
          </label>
          <DateField
            id={`is-study-date-${uid}`}
            name="study_date"
            value={studyDate}
            onChange={setStudyDate}
            max={today}
          />
        </div>

        <div hidden={openEditor !== "region"}>
          <label className="label" htmlFor={`is-region-${uid}`}>
            Body region
          </label>
          <input
            id={`is-region-${uid}`}
            name="body_region"
            className="input"
            defaultValue={study?.body_region ?? ""}
            onChange={(e) => setBodyRegion(e.target.value)}
            placeholder="e.g. Chest, Left Knee"
          />
        </div>

        <div hidden={openEditor !== "laterality"}>
          <label className="label" htmlFor={`is-laterality-${uid}`}>
            Laterality
          </label>
          <select
            id={`is-laterality-${uid}`}
            name="laterality"
            className="input"
            defaultValue={study?.laterality ?? ""}
            onChange={(e) => setLaterality(e.target.value)}
          >
            <option value="">—</option>
            {IMAGING_LATERALITIES.map((l) => (
              <option key={l} value={l}>
                {lateralityLabel(l)}
              </option>
            ))}
          </select>
        </div>

        {/* The contrast pair is ONE fact over ONE editor: "with contrast" is the
            claim and the agent names which. */}
        <div
          hidden={openEditor !== "contrast"}
          className="grid items-end gap-3"
        >
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
              onChange={(e) => setContrast(e.target.checked)}
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
              onChange={(e) => setContrastAgent(e.target.value)}
              placeholder="e.g. gadolinium"
            />
          </div>
        </div>

        <div hidden={openEditor !== "dose"}>
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
            onChange={(e) => setDoseMsv(e.target.value)}
            placeholder="Only if the report prints one (rare)"
          />
          {/* The value's own meaning, which is the one sentence an open editor may
              carry (#5300 rule 4). */}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Leave blank to use a typical estimate for the modality.
          </p>
        </div>

        <div hidden={openEditor !== "indication"}>
          <label className="label" htmlFor={`is-indication-${uid}`}>
            Indication
          </label>
          <input
            id={`is-indication-${uid}`}
            name="indication"
            className="input"
            defaultValue={study?.indication ?? ""}
            onChange={(e) => setIndication(e.target.value)}
            placeholder="Reason the study was ordered, e.g. screening"
          />
        </div>

        <div hidden={openEditor !== "impression"}>
          <label className="label" htmlFor={`is-impression-${uid}`}>
            Impression
          </label>
          <textarea
            id={`is-impression-${uid}`}
            name="impression"
            className="input min-h-20"
            defaultValue={study?.impression ?? ""}
            onChange={(e) => setImpression(e.target.value)}
            placeholder="The radiologist's impression / findings, verbatim"
          />
          {/* The imported report, when one was stored (#3594). An import keeps the
              whole rendered report rather than guessing which sentence is the
              finding, so it is shown here — as the record, not as an editable
              impression — and the list's "the full text is one tap away in the
              form" stays true for an imported study. */}
          {study?.report_narrative ? (
            <p className="mt-2 whitespace-pre-wrap text-xs text-slate-400">
              <span className="font-medium">Imported report: </span>
              {study.report_narrative}
            </p>
          ) : null}
        </div>

        <div hidden={openEditor !== "status"}>
          <label className="label" htmlFor={`is-status-${uid}`}>
            Status
          </label>
          <input
            id={`is-status-${uid}`}
            name="status"
            className="input"
            defaultValue={study?.status ?? ""}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="e.g. final"
          />
        </div>

        <div hidden={openEditor !== "ordering"}>
          <label className="label" htmlFor={`is-ordering-${uid}`}>
            Ordering provider
          </label>
          {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
          <ProviderCombobox
            id={`is-ordering-${uid}`}
            name="ordering_provider"
            ariaLabel="Ordering provider"
            defaultValue={study?.ordering_provider_name ?? ""}
            onChange={setOrderingProvider}
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

        <div hidden={openEditor !== "radiologist"}>
          <label className="label" htmlFor={`is-reading-${uid}`}>
            Reading radiologist
          </label>
          <ProviderCombobox
            id={`is-reading-${uid}`}
            name="reading_provider"
            ariaLabel="Reading radiologist"
            defaultValue={study?.reading_provider_name ?? ""}
            onChange={setReadingProvider}
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

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`is-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`is-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={study?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="imaging-study"
            more={summary.more}
            nouns={IMAGING_STUDY_FACT_NOUNS}
            onOpen={(panel) => openPanel(panel as ImagingOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="imaging-study-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="imaging-study-primary-action"
        >
          <SubmitButton pendingLabel="Saving…" variant="primary">
            {editing ? "Save" : "Add"}
          </SubmitButton>
        </div>
        {editing && onDone && (
          <button type="button" className="btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
