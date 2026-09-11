"use client";

import { useRef, useState } from "react";
import DateField from "@/components/DateField";
import Button from "@/components/Button";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import EncounterField from "@/components/EncounterField";
import { useEncounterOptions } from "@/components/EncounterOptionsContext";
import { formatVisitLabel } from "@/lib/record-format";
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
  skinLesionFactSummary,
  SKIN_LESION_FACT_NOUNS,
  type SkinLesionFactKey,
} from "@/lib/skin-lesion-facts";
import {
  SKIN_LESION_STATUSES,
  BODY_REGIONS,
  BODY_SIDES,
  ABCDE_DIMENSIONS,
  skinLesionStatusLabel,
  bodyRegionLabel,
  bodySideLabel,
  type AbcdeKey,
} from "@/lib/skin-lesion";
import type { SkinLesion, FormResult } from "@/lib/types";
import InlineError from "@/components/InlineError";

// WHICH PANELS EXIST is the fact keys plus the trailing affordance's own menu — the
// intake form's shape (#3216).
type SkinLesionOpenPanel = SkinLesionFactKey | "more";

const EMPTY_ABCDE: Record<AbcdeKey, boolean> = {
  asymmetry: false,
  border: false,
  color: false,
  diameter: false,
  evolving: false,
};

// Shared add/edit skin-lesion form (issue #715), on the facts-with-editors primitive
// (#5302, over #3218 and #5300's grammar) — the first of slice 3's forms. Add mode: no
// `record`. Edit mode: pass the row + an `onDone` callback (renders a hidden id + a
// Cancel button).
//
// WHAT CHANGED, and what deliberately did not. Thirteen labelled controls stood open
// for a record whose statement is one mole. Now the LABEL is rule 1's one identifying
// field, the row states where the lesion is, when it was observed and what it is being
// tracked as — the three facts the #482 identity and the #700 follow-up chain read it
// with, argued in lib/skin-lesion-facts — and the rest live behind the one trailing
// affordance. The write is untouched: the same `<form action={…}>` posts the same named
// fields to the same Server Action, the enum fields stay <select>s so a value can never
// miss the DB CHECK set, and the five ABCDE fields stay USER-RECORDED OBSERVATIONS
// (checkboxes) — the labels describe what you observed, never a verdict (#715's scope
// law: this app tracks and compares, it does not assess a lesion).
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden; an unmounted field is a field the form CLEARS
// (#2359) and one the dirty-form registry cannot see. That matters most for the five
// ABCDE checkboxes, which post only when checked and would silently clear if the panel
// unmounted. See ConditionForm's header for the same reading at the sibling address.
export default function SkinLesionForm({
  action,
  record,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  record?: SkinLesion;
  onDone?: () => void;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const prefs = useFormatPrefs();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!record;
  const [error, setError] = useState<string | null>(null);
  // The chips' copies of the DOM-owned fields: `defaultValue` keeps the browser's
  // value the one that posts, and these only draw the sentence. The date is
  // controlled because `DateField` has no uncontrolled change callback, and its named
  // input is `type="hidden"`, which the dirty-form registry excludes anyway.
  const [bodyRegion, setBodyRegion] = useState(record?.body_region ?? "");
  const [bodySide, setBodySide] = useState(record?.body_side ?? "");
  const [observedDate, setObservedDate] = useState(record?.observed_date ?? "");
  const [status, setStatus] = useState(record?.status ?? "active");
  const [sizeMm, setSizeMm] = useState(
    record?.size_mm != null ? String(record.size_mm) : ""
  );
  const [abcde, setAbcde] = useState<Record<AbcdeKey, boolean>>(() =>
    record
      ? {
          asymmetry: record.asymmetry === 1,
          border: record.border === 1,
          color: record.color === 1,
          diameter: record.diameter === 1,
          evolving: record.evolving === 1,
        }
      : { ...EMPTY_ABCDE }
  );
  const [recheckDays, setRecheckDays] = useState(
    record?.follow_up_interval_days != null
      ? String(record.follow_up_interval_days)
      : ""
  );
  const [finding, setFinding] = useState(record?.finding ?? "");
  const [provider, setProvider] = useState(record?.provider_name ?? "");
  const [notes, setNotes] = useState(record?.notes ?? "");
  // The visits this profile could be linked to. The picker renders nothing when there
  // are none, so the row must not offer the fact either (the allergy form's rule).
  const visits = useEncounterOptions();
  // The linked visit's LABEL, mirrored off the picker — the chip states which visit,
  // and the select still posts the id. Seeded on the edit form through the SAME
  // `formatVisitLabel` the picker's own options use, so the chip and the option the
  // select is showing cannot read differently.
  const [visit, setVisit] = useState(() => {
    const linked = visits.find((e) => e.id === record?.encounter_id);
    return linked ? formatVisitLabel(linked, prefs) : "";
  });

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<SkinLesionOpenPanel>({ scopeRef: formRef });

  const summary = skinLesionFactSummary({
    bodyRegion,
    bodySide,
    observedDate,
    status,
    sizeMm,
    abcde,
    recheckDays,
    finding,
    provider,
    visit,
    linkableVisits: visits.length > 0,
    notes,
    prefs,
  });

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
    if (!editing) {
      formRef.current?.reset();
      setBodyRegion("");
      setBodySide("");
      setObservedDate("");
      setStatus("active");
      setSizeMm("");
      setAbcde({ ...EMPTY_ABCDE });
      setRecheckDays("");
      setFinding("");
      setProvider("");
      setVisit("");
      setNotes("");
      closePanel();
      closeEntryModal?.();
    }
    onDone?.();
  }

  const uid = record?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="skin-lesion-form"
    >
      {editing && <input type="hidden" name="id" value={record!.id} />}
      {/* THE RECORD'S OWN NAME IS THE HEADING ON A PAGE-HOSTED EDIT (#5300 rule 6);
          the add door is a dialog and takes "Add skin lesion" from its host. It states
          the lesion AS STORED — the field below states what Save will write. */}
      {editing && record!.label && (
        <h3
          data-testid="skin-lesion-form-heading"
          className="font-semibold text-slate-800 dark:text-slate-100"
        >
          {record!.label}
        </h3>
      )}
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

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {openEditor == null && (
        <RecordFactRow
          prefix="skin-lesion"
          summary={summary}
          nouns={SKIN_LESION_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(panel, focusKey) =>
            openPanel(panel as SkinLesionOpenPanel, focusKey)
          }
        />
      )}

      <FactEditorHost
        testId="skin-lesion-editor"
        doneTestId="skin-lesion-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        // Hidden rather than unmounted — see the header: this form is DOM-collected,
        // so an unmounted field is a cleared field.
        className={openEditor == null ? "hidden" : undefined}
      >
        {/* THE REGION AND THE SIDE ARE ONE FACT over one editor: they are two of the
            three components of the #482 lesion identity and `bodyMapLabel` already
            reads them back as one line ("Left forearm"). Two chips would state one
            place twice. */}
        <div hidden={openEditor !== "location"}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={`sl-region-${uid}`}>
                Region
              </label>
              <select
                id={`sl-region-${uid}`}
                name="body_region"
                className="input"
                defaultValue={record?.body_region ?? ""}
                onChange={(e) => setBodyRegion(e.target.value)}
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
                onChange={(e) => setBodySide(e.target.value)}
              >
                <option value="">—</option>
                {BODY_SIDES.map((s) => (
                  <option key={s} value={s}>
                    {bodySideLabel(s)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div hidden={openEditor !== "observed"}>
          <label className="label" htmlFor={`sl-date-${uid}`}>
            Observed
          </label>
          <DateField
            id={`sl-date-${uid}`}
            name="observed_date"
            value={observedDate}
            onChange={setObservedDate}
          />
        </div>

        <div hidden={openEditor !== "status"}>
          <label className="label" htmlFor={`sl-status-${uid}`}>
            Status
          </label>
          <select
            id={`sl-status-${uid}`}
            name="status"
            className="input"
            defaultValue={record?.status ?? "active"}
            onChange={(e) => setStatus(e.target.value as SkinLesion["status"])}
          >
            {SKIN_LESION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {skinLesionStatusLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div hidden={openEditor !== "size"}>
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
            onChange={(e) => setSizeMm(e.target.value)}
            placeholder="e.g. 5"
          />
        </div>

        {/* THE FIVE ABCDE OBSERVATIONS ARE ONE FACT over one editor: `abcdeLetters`
            already reads them back as one neutral list ("A·B·E") everywhere else, and
            five chips would state one set of observations five times. */}
        <div hidden={openEditor !== "abcde"}>
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
                    onChange={(e) =>
                      setAbcde((prev) => ({
                        ...prev,
                        [d.key]: e.target.checked,
                      }))
                    }
                  />
                  <span>
                    <span className="font-semibold">{d.letter}</span> —{" "}
                    {d.label}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div hidden={openEditor !== "recheck"}>
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
            onChange={(e) => setRecheckDays(e.target.value)}
            placeholder="e.g. 90"
          />
        </div>

        <div hidden={openEditor !== "finding"}>
          <label className="label" htmlFor={`sl-finding-${uid}`}>
            Finding / note
          </label>
          <textarea
            id={`sl-finding-${uid}`}
            name="finding"
            className="input min-h-16"
            defaultValue={record?.finding ?? ""}
            onChange={(e) => setFinding(e.target.value)}
            placeholder="Free-text notes, e.g. slightly raised, dark brown, unchanged since last check"
          />
        </div>

        <div hidden={openEditor !== "provider"}>
          <label className="label" htmlFor={`sl-provider-${uid}`}>
            Provider
          </label>
          {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
          <ProviderCombobox
            id={`sl-provider-${uid}`}
            name="provider"
            defaultValue={record?.provider_name ?? ""}
            onChange={setProvider}
            placeholder="e.g. Dr. Okafor (dermatologist)"
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

        {/* The visit this was checked at (#1526), beside the provider it names — the
            finding above is a dermatologist's judgment, so the visit that produced it
            is part of the record. Renders nothing when the profile has no visits yet,
            which is also why the row does not offer the fact then. */}
        <div hidden={openEditor !== "visit"}>
          <EncounterField
            uid={uid}
            label="Checked at visit"
            defaultValue={record?.encounter_id ?? null}
            onChange={setVisit}
            testid={`sl-encounter-${uid}`}
          />
        </div>

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`sl-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`sl-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={record?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="skin-lesion"
            more={summary.more}
            nouns={SKIN_LESION_FACT_NOUNS}
            onOpen={(panel) => openPanel(panel as SkinLesionOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="skin-lesion-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="skin-lesion-primary-action"
        >
          <SubmitButton pendingLabel="Saving…" variant="primary">
            {editing ? "Save" : "Add"}
          </SubmitButton>
        </div>
        {editing && onDone && (
          // Quiet beside the form's filled commit (ruling 6, #4978); the drop to
          // the control box's 12px ends the "Cancel larger than Add" inversion.
          <Button onClick={onDone}>Cancel</Button>
        )}
      </div>
    </form>
  );
}
