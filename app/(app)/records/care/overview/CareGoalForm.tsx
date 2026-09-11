"use client";

import { useRef, useState } from "react";
import DateField from "@/components/DateField";
import Button from "@/components/Button";
import SubmitButton from "@/components/SubmitButton";
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
  careGoalFactSummary,
  CARE_GOAL_FACT_NOUNS,
  type CareGoalFactKey,
} from "@/lib/care-goal-facts";
import type { CareGoal, FormResult } from "@/lib/types";
import InlineError from "@/components/InlineError";

// WHICH PANELS EXIST is the fact keys plus the trailing affordance's own menu — the
// intake form's shape (#3216).
type CareGoalOpenPanel = CareGoalFactKey | "more";

// Shared add/edit care-goal form, on the facts-with-editors primitive (#5302, over
// #3218 and #5300's grammar) — the second of the three care-overview forms and the
// smallest of the thirteen.
//
// WHAT CHANGED, and what deliberately did not. Five labelled controls stood open for
// a record whose statement is the goal. Now the GOAL is rule 1's one identifying
// field, the row states the target date and the status — the two facts a goal is
// read by, and the two columns the list gives their own space to — and the code and
// notes live behind the one trailing affordance. The write is untouched: the same
// `<form action={…}>` posts the same named fields to the same Server Action, and the
// status stays a FREE-TEXT input because `care_goals.status` is free-form by design
// (#328) and an enum here would drop real imported record data.
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden; an unmounted field is a field the form CLEARS
// (#2359) and one the dirty-form registry cannot see. See ConditionForm's header for
// the same reading at the sibling address.
export default function CareGoalForm({
  action,
  goal,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  goal?: CareGoal;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const prefs = useFormatPrefs();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!goal;
  const [error, setError] = useState<string | null>(null);
  // The chips' copies of the DOM-owned fields: `defaultValue` keeps the browser's
  // value the one that posts, and these only draw the sentence. The date is
  // controlled because `DateField` has no uncontrolled change callback, and its named
  // input is `type="hidden"`, which the dirty-form registry excludes anyway.
  const [targetDate, setTargetDate] = useState(goal?.target_date ?? "");
  const [status, setStatus] = useState(goal?.status ?? "");
  const [code, setCode] = useState(goal?.code ?? "");
  const [codeSystem, setCodeSystem] = useState(goal?.code_system ?? "");
  const [notes, setNotes] = useState(goal?.notes ?? "");

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<CareGoalOpenPanel>({ scopeRef: formRef });

  const summary = careGoalFactSummary({
    targetDate,
    status,
    code,
    codeSystem,
    notes,
    prefs,
  });

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("description") ?? "").trim()) {
      setError("Enter the goal.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this goal. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Goal updated" : "Goal saved");
    if (!editing) {
      formRef.current?.reset();
      setTargetDate("");
      setStatus("");
      setCode("");
      setCodeSystem("");
      setNotes("");
      closePanel();
      closeEntryModal?.();
    }
    onDone?.();
  }

  const uid = goal?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="care-goal-form"
    >
      {editing && <input type="hidden" name="id" value={goal!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      {/* THE RECORD'S OWN NAME IS THE HEADING ON A PAGE-HOSTED EDIT (#5300 rule 6);
          the add door is a dialog and takes "Add health goal" from its host. It
          states the goal AS STORED — the field below states what Save will write. */}
      {editing && (
        <h3
          data-testid="care-goal-form-heading"
          className="font-semibold text-slate-800 dark:text-slate-100"
        >
          {goal!.description}
        </h3>
      )}
      <div>
        <label className="label" htmlFor={`cg-desc-${uid}`}>
          Goal
        </label>
        <input
          id={`cg-desc-${uid}`}
          name="description"
          className="input"
          defaultValue={goal?.description ?? ""}
          placeholder="e.g. A1c below 7.0%, BP under 130/80"
          required
        />
      </div>

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {openEditor == null && (
        <RecordFactRow
          prefix="care-goal"
          summary={summary}
          nouns={CARE_GOAL_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(panel, focusKey) =>
            openPanel(panel as CareGoalOpenPanel, focusKey)
          }
        />
      )}

      <FactEditorHost
        testId="care-goal-editor"
        doneTestId="care-goal-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        // Hidden rather than unmounted — see the header: this form is DOM-collected,
        // so an unmounted field is a cleared field.
        className={openEditor == null ? "hidden" : undefined}
      >
        <div hidden={openEditor !== "target"}>
          <label className="label" htmlFor={`cg-date-${uid}`}>
            Target date
          </label>
          <DateField
            id={`cg-date-${uid}`}
            name="target_date"
            value={targetDate}
            onChange={setTargetDate}
          />
        </div>

        <div hidden={openEditor !== "status"}>
          <label className="label" htmlFor={`cg-status-${uid}`}>
            Status
          </label>
          {/* Free TEXT by design (#328): the importers pass FHIR lifecycle codes
              through verbatim, so a closed enum here would drop or mangle real
              record data. The placeholder is the vocabulary. */}
          <input
            id={`cg-status-${uid}`}
            name="status"
            className="input"
            defaultValue={goal?.status ?? ""}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="proposed / active / achieved"
          />
        </div>

        <div hidden={openEditor !== "code"}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={`cg-code-${uid}`}>
                Code
              </label>
              <input
                id={`cg-code-${uid}`}
                name="code"
                className="input"
                defaultValue={goal?.code ?? ""}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. 4548-4"
              />
            </div>
            <div>
              <label className="label" htmlFor={`cg-codesys-${uid}`}>
                Code system
              </label>
              <input
                id={`cg-codesys-${uid}`}
                name="code_system"
                className="input"
                defaultValue={goal?.code_system ?? ""}
                onChange={(e) => setCodeSystem(e.target.value)}
                placeholder="LOINC / SNOMED CT"
              />
            </div>
          </div>
        </div>

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`cg-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`cg-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={goal?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="care-goal"
            more={summary.more}
            nouns={CARE_GOAL_FACT_NOUNS}
            onOpen={(panel) => openPanel(panel as CareGoalOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="care-goal-form-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="care-goal-form-primary-action"
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
