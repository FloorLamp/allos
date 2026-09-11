"use client";

import { useRef, useState } from "react";
import DateField from "@/components/DateField";
import Button from "@/components/Button";
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
  dentalFactSummary,
  DENTAL_PROCEDURE_FACT_NOUNS,
  type DentalProcedureFactKey,
} from "@/lib/dental-procedure-facts";
import {
  DENTAL_STATUSES,
  TOOTH_SYSTEMS,
  dentalStatusLabel,
} from "@/lib/dental";
import type { DentalProcedure, ToothSystem, FormResult } from "@/lib/types";
import InlineError from "@/components/InlineError";

const TOOTH_SYSTEM_LABEL: Record<ToothSystem, string> = {
  universal: "Universal (1–32)",
  fdi: "FDI / ISO",
  palmer: "Palmer",
};

// WHICH PANELS EXIST is the fact keys plus the trailing affordance's own menu — the
// intake form's shape (#3216).
type DentalOpenPanel = DentalProcedureFactKey | "more";

// Shared add/edit dental-procedure form, on the facts-with-editors primitive (#5302,
// over #3218 and #5300's grammar) — the second of slice 3's forms. Add mode: no
// `record`. Edit mode: pass the row + an `onDone` callback (renders a hidden id + a
// Cancel button). Periodontal MEASUREMENTS are captured as analytes under Clinical
// results, not here — this is the procedure/finding.
//
// WHAT CHANGED, and what deliberately did not. Eleven labelled controls stood open for
// a record whose statement is the procedure. Now the NAME is rule 1's one identifying
// field, the row states the date, the status and the CDT code — the three facts the
// #704 safety cross-check and the #82 preventive clock read this record with, argued in
// lib/dental-procedure-facts — and the tooth, the recheck interval, the finding, the
// provider and the notes live behind the one trailing affordance. The write is
// untouched: the same `<form action={…}>` posts the same named fields to the same
// Server Action, and the enum fields stay <select>s so a value can never miss the DB
// CHECK set (the action still re-normalizes on the server).
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden; an unmounted field is a field the form CLEARS
// (#2359) and one the dirty-form registry cannot see. See ConditionForm's header for
// the same reading at the sibling address.
export default function DentalProcedureForm({
  action,
  record,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  record?: DentalProcedure;
  // Multi-view (#2557): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
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
  const [status, setStatus] = useState(record?.status ?? "completed");
  const [procedureDate, setProcedureDate] = useState(
    record?.procedure_date ?? ""
  );
  const [cdtCode, setCdtCode] = useState(record?.cdt_code ?? "");
  const [tooth, setTooth] = useState(record?.tooth ?? "");
  const [surface, setSurface] = useState(record?.surface ?? "");
  const [recheckDays, setRecheckDays] = useState(
    record?.follow_up_interval_days != null
      ? String(record.follow_up_interval_days)
      : ""
  );
  const [finding, setFinding] = useState(record?.finding ?? "");
  const [provider, setProvider] = useState(record?.provider_name ?? "");
  const [notes, setNotes] = useState(record?.notes ?? "");

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<DentalOpenPanel>({ scopeRef: formRef });

  const summary = dentalFactSummary({
    procedureDate,
    status,
    cdtCode,
    tooth,
    surface,
    recheckDays,
    finding,
    provider,
    notes,
    prefs,
  });

  async function handle(formData: FormData) {
    setError(null);
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this record. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Record updated" : "Record saved");
    if (!editing) {
      formRef.current?.reset();
      setStatus("completed");
      setProcedureDate("");
      setCdtCode("");
      setTooth("");
      setSurface("");
      setRecheckDays("");
      setFinding("");
      setProvider("");
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
      data-testid="dental-procedure-form"
    >
      {editing && <input type="hidden" name="id" value={record!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      {/* THE RECORD'S OWN NAME IS THE HEADING ON A PAGE-HOSTED EDIT (#5300 rule 6);
          the add door is a dialog and takes "Add dental record" from its host. It
          states the record AS STORED — the field below states what Save will write. */}
      {editing && (
        <h3
          data-testid="dental-procedure-form-heading"
          className="font-semibold text-slate-800 dark:text-slate-100"
        >
          {record!.name}
        </h3>
      )}
      <div>
        <label className="label" htmlFor={`dp-name-${uid}`}>
          Procedure / finding
        </label>
        <input
          id={`dp-name-${uid}`}
          name="name"
          className="input"
          required
          defaultValue={record?.name ?? ""}
          placeholder="e.g. Composite filling, Extraction, Caries watch"
        />
      </div>

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {openEditor == null && (
        <RecordFactRow
          prefix="dental-procedure"
          summary={summary}
          nouns={DENTAL_PROCEDURE_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(panel, focusKey) =>
            openPanel(panel as DentalOpenPanel, focusKey)
          }
        />
      )}

      <FactEditorHost
        testId="dental-procedure-editor"
        doneTestId="dental-procedure-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        // Hidden rather than unmounted — see the header: this form is DOM-collected,
        // so an unmounted field is a cleared field.
        className={openEditor == null ? "hidden" : undefined}
      >
        <div hidden={openEditor !== "date"}>
          <label className="label" htmlFor={`dp-date-${uid}`}>
            Date
          </label>
          <DateField
            id={`dp-date-${uid}`}
            name="procedure_date"
            value={procedureDate}
            onChange={setProcedureDate}
          />
        </div>

        <div hidden={openEditor !== "status"}>
          <label className="label" htmlFor={`dp-status-${uid}`}>
            Status
          </label>
          <select
            id={`dp-status-${uid}`}
            name="status"
            className="input"
            defaultValue={record?.status ?? "completed"}
            onChange={(e) =>
              setStatus(e.target.value as DentalProcedure["status"])
            }
          >
            {DENTAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {dentalStatusLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div hidden={openEditor !== "cdt"}>
          <label className="label" htmlFor={`dp-cdt-${uid}`}>
            CDT code
          </label>
          <input
            id={`dp-cdt-${uid}`}
            name="cdt_code"
            className="input"
            defaultValue={record?.cdt_code ?? ""}
            onChange={(e) => setCdtCode(e.target.value)}
            placeholder="e.g. D2392"
          />
        </div>

        {/* THE TOOTH, ITS NUMBERING SYSTEM AND ITS SURFACE ARE ONE FACT over one
            editor: they describe a single site and `toothLabel` already reads them
            back as one line ("#14 MOD"). Three chips would state one place three
            times. */}
        <div hidden={openEditor !== "tooth"}>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor={`dp-tooth-${uid}`}>
                Tooth
              </label>
              <input
                id={`dp-tooth-${uid}`}
                name="tooth"
                className="input"
                defaultValue={record?.tooth ?? ""}
                onChange={(e) => setTooth(e.target.value)}
                placeholder="e.g. 14"
              />
            </div>
            <div>
              <label className="label" htmlFor={`dp-system-${uid}`}>
                System
              </label>
              <select
                id={`dp-system-${uid}`}
                name="tooth_system"
                className="input"
                defaultValue={record?.tooth_system ?? ""}
              >
                <option value="">—</option>
                {TOOTH_SYSTEMS.map((t) => (
                  <option key={t} value={t}>
                    {TOOTH_SYSTEM_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor={`dp-surface-${uid}`}>
                Surface
              </label>
              <input
                id={`dp-surface-${uid}`}
                name="surface"
                className="input"
                defaultValue={record?.surface ?? ""}
                onChange={(e) => setSurface(e.target.value)}
                placeholder="e.g. MOD"
              />
            </div>
          </div>
        </div>

        <div hidden={openEditor !== "recheck"}>
          <label className="label" htmlFor={`dp-followup-${uid}`}>
            Recheck in (days)
          </label>
          <input
            id={`dp-followup-${uid}`}
            name="follow_up_interval_days"
            type="number"
            min="1"
            className="input"
            defaultValue={record?.follow_up_interval_days ?? ""}
            onChange={(e) => setRecheckDays(e.target.value)}
            placeholder="e.g. 180"
          />
        </div>

        <div hidden={openEditor !== "finding"}>
          <label className="label" htmlFor={`dp-finding-${uid}`}>
            Finding / note
          </label>
          <textarea
            id={`dp-finding-${uid}`}
            name="finding"
            className="input min-h-16"
            defaultValue={record?.finding ?? ""}
            onChange={(e) => setFinding(e.target.value)}
            placeholder="Free-text clinical impression, e.g. watch mesial #14 for recurrent decay"
          />
        </div>

        <div hidden={openEditor !== "provider"}>
          <label className="label" htmlFor={`dp-provider-${uid}`}>
            Provider
          </label>
          {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
          <ProviderCombobox
            id={`dp-provider-${uid}`}
            name="provider"
            defaultValue={record?.provider_name ?? ""}
            onChange={setProvider}
            placeholder="e.g. Dr. Rivera (dentist)"
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

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`dp-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`dp-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={record?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="dental-procedure"
            more={summary.more}
            nouns={DENTAL_PROCEDURE_FACT_NOUNS}
            onOpen={(panel) => openPanel(panel as DentalOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="dental-procedure-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="dental-procedure-primary-action"
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
