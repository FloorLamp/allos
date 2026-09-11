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
  procedureFactSummary,
  PROCEDURE_FACT_NOUNS,
  type ProcedureFactKey,
} from "@/lib/procedure-facts";
import type { Procedure, FormResult } from "@/lib/types";
import InlineError from "@/components/InlineError";

// WHICH PANELS EXIST is the fact keys plus the trailing affordance's own menu — the
// intake form's shape (#3216).
type ProcedureOpenPanel = ProcedureFactKey | "more";

// Shared add/edit procedure form, on the facts-with-editors primitive (#5302, over
// #3218 and #5300's grammar) — the third of slice 3's forms. Add mode: no `procedure`.
// Edit mode: pass the row + an `onDone` callback (renders a hidden id + a Cancel
// button). The performer is a create-on-type ProviderCombobox (#1176) over the
// section's shared registry rows.
//
// WHAT CHANGED, and what deliberately did not. Six labelled controls stood open for a
// record whose statement is the procedure. Now the NAME is rule 1's one identifying
// field, the row states the code and the date — the two facts the preventive clock
// reads this record with, argued in lib/procedure-facts — and the provider and the
// notes live behind the one trailing affordance. The write is untouched: the same
// `<form action={…}>` posts the same named fields to the same Server Action.
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden; an unmounted field is a field the form CLEARS
// (#2359) and one the dirty-form registry cannot see. See ConditionForm's header for
// the same reading at the sibling address.
export default function ProcedureForm({
  action,
  procedure,
  profileId,
  onDone,
  prefillName,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  procedure?: Procedure;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
  // Deep-link prefill (#1083, mirrors #662): a preventive procedure-screening row/nudge
  // lands on the procedures page with `?new=1&name=<procedure>`; the add form seeds the
  // name field + focuses it. Add mode only (ignored when editing an existing row).
  prefillName?: string;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const prefs = useFormatPrefs();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!procedure;
  const [error, setError] = useState<string | null>(null);
  // The chips' copies of the DOM-owned fields: `defaultValue` keeps the browser's
  // value the one that posts, and these only draw the sentence. The date is
  // controlled because `DateField` has no uncontrolled change callback, and its named
  // input is `type="hidden"`, which the dirty-form registry excludes anyway.
  const [code, setCode] = useState(procedure?.code ?? "");
  const [codeSystem, setCodeSystem] = useState(procedure?.code_system ?? "");
  const [date, setDate] = useState(procedure?.date ?? "");
  const [provider, setProvider] = useState(procedure?.provider_name ?? "");
  const [notes, setNotes] = useState(procedure?.notes ?? "");

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<ProcedureOpenPanel>({ scopeRef: formRef });

  const summary = procedureFactSummary({
    code,
    codeSystem,
    date,
    provider,
    notes,
    prefs,
  });

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
    if (!editing) {
      formRef.current?.reset();
      setCode("");
      setCodeSystem("");
      setDate("");
      setProvider("");
      setNotes("");
      closePanel();
      closeEntryModal?.();
    }
    onDone?.();
  }

  const uid = procedure?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="procedure-form"
    >
      {editing && <input type="hidden" name="id" value={procedure!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      {/* THE RECORD'S OWN NAME IS THE HEADING ON A PAGE-HOSTED EDIT (#5300 rule 6);
          the add door is a dialog and takes "Add procedure" from its host. It states
          the procedure AS STORED — the field below states what Save will write. */}
      {editing && (
        <h3
          data-testid="procedure-form-heading"
          className="font-semibold text-slate-800 dark:text-slate-100"
        >
          {procedure!.name}
        </h3>
      )}
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

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {openEditor == null && (
        <RecordFactRow
          prefix="procedure"
          summary={summary}
          nouns={PROCEDURE_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(panel, focusKey) =>
            openPanel(panel as ProcedureOpenPanel, focusKey)
          }
        />
      )}

      <FactEditorHost
        testId="procedure-editor"
        doneTestId="procedure-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        // Hidden rather than unmounted — see the header: this form is DOM-collected,
        // so an unmounted field is a cleared field.
        className={openEditor == null ? "hidden" : undefined}
      >
        <div hidden={openEditor !== "code"}>
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
                onChange={(e) => setCode(e.target.value)}
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
                onChange={(e) => setCodeSystem(e.target.value)}
                placeholder="CPT / SNOMED CT"
              />
            </div>
          </div>
        </div>

        <div hidden={openEditor !== "date"}>
          <label className="label" htmlFor={`proc-date-${uid}`}>
            Date
          </label>
          <DateField
            id={`proc-date-${uid}`}
            name="date"
            value={date}
            onChange={setDate}
          />
        </div>

        <div hidden={openEditor !== "provider"}>
          <label className="label" htmlFor={`proc-provider-${uid}`}>
            Provider
          </label>
          {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
          <ProviderCombobox
            id={`proc-provider-${uid}`}
            name="provider"
            defaultValue={procedure?.provider_name ?? ""}
            onChange={setProvider}
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

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`proc-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`proc-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={procedure?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="procedure"
            more={summary.more}
            nouns={PROCEDURE_FACT_NOUNS}
            onOpen={(panel) => openPanel(panel as ProcedureOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="procedure-form-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="procedure-form-primary-action"
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
