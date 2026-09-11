"use client";

import { useMemo, useRef, useState } from "react";
import DateField from "@/components/DateField";
import Button from "@/components/Button";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import Combobox from "@/components/Combobox";
import { useAddEntryModalClose } from "@/components/AddEntryPanel";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import InlineError from "@/components/InlineError";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import RecordFactRow, {
  RecordFactMoreMenu,
} from "@/components/records/RecordFactRow";
import {
  bestIcd10Suggestion,
  icd10CodeForName,
  icd10SearchTerms,
  ICD10_CONDITION_NAMES,
  ICD10_SYSTEM,
} from "@/lib/icd10";
import {
  conditionFactSummary,
  CONDITION_FACT_NOUNS,
  type ConditionFactKey,
} from "@/lib/condition-facts";
import { conditionDisplayLabel } from "@/lib/condition-attributes";
import {
  CONDITION_LATERALITIES,
  CONDITION_SEVERITIES,
  type Condition,
  type ConditionLaterality,
  type ConditionSeverity,
  type ConditionStatus,
  type FormResult,
} from "@/lib/types";

// WHICH PANELS EXIST is the fact keys plus the trailing affordance's own menu — the
// intake form's shape (#3216), so opening "more" still leaves exactly one editor on
// screen.
type ConditionOpenPanel = ConditionFactKey | "more";

// Shared add/edit condition form, on the facts-with-editors primitive (#5302, over
// #3218 and #5300's grammar) — the FIRST of the thirteen clinical record forms to
// adopt it, and the shape the other twelve copy.
//
// WHAT CHANGED, and what deliberately did not. Ten labelled controls stood open for a
// record whose ICD-10-CM pick already answers three of them. Now the NAME is rule 1's
// one identifying field, the row states the code and the status, and the other six
// facts live behind the one trailing affordance until someone wants them. The write is
// untouched: the same `<form action={…}>` posts the same named fields to the same
// Server Action, and nothing about what a condition stores moved.
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden. A field that unmounts when its panel closes is a
// field the form CLEARS (#2359), and it is invisible to the dirty-form registry, which
// skips anything where `!field.isConnected` — so dismissing the dialog would throw the
// entry away with no "Discard your changes?" to stop it. That is the protocol form's
// reading of the primitive (#3219) and the one every record form needs.
//
// THE PLAIN FIELDS STAY DOM-OWNED AND MIRROR INTO STATE. `defaultValue` plus an
// `onChange` that only updates the chip's copy: the DOM is still the value the browser
// collects at submit, and React knows enough to draw the sentence. The two dates are
// controlled because `DateField` has no uncontrolled change callback, and its named
// input is `type="hidden"`, which the dirty-form registry excludes anyway.
//
// NO STANDING PROSE. The ICD-10 suggestion — "Suggested code J45.909 (ICD-10-CM)" with
// its Use-code button — used to sit under the name field on every open. It is the
// code's own business, so it moved inside the code editor, which is where someone who
// disagrees with the code is already looking (#5300 rule 4).
export default function ConditionForm({
  action,
  condition,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  condition?: Condition;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const prefs = useFormatPrefs();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!condition;
  const [status, setStatus] = useState<ConditionStatus>(
    condition?.status ?? "active"
  );
  const [error, setError] = useState<string | null>(null);
  // Controlled so the ICD-10-CM suggestion can read the name and, on confirm, fill
  // the code/code-system fields (issue #155).
  const [name, setName] = useState(condition?.name ?? "");
  const [code, setCode] = useState(condition?.code ?? "");
  const [codeSystem, setCodeSystem] = useState(condition?.code_system ?? "");
  // The code THIS form applied from a catalog pick, so a later name edit can retract
  // it without ever touching a code the user typed or an import carried in. Mirrors
  // the medication form's rxcuiRef (components/intake/useIntakeRxcui).
  const pickedCode = useRef<string | null>(null);
  // Whether the code on screen was supplied FOR the person — by the catalog pick or
  // by accepting the suggestion — rather than typed (#846). The chip says so, and a
  // typed character over it takes the marking off.
  const [codeSuggested, setCodeSuggested] = useState(false);
  // The chips' copies of the DOM-owned fields; see the note above.
  const [laterality, setLaterality] = useState<ConditionLaterality | "">(
    condition?.laterality ?? ""
  );
  const [severity, setSeverity] = useState<ConditionSeverity | "">(
    condition?.severity ?? ""
  );
  const [stage, setStage] = useState(condition?.stage ?? "");
  const [notes, setNotes] = useState(condition?.notes ?? "");
  const [onsetDate, setOnsetDate] = useState(condition?.onset_date ?? "");
  const [resolvedDate, setResolvedDate] = useState(
    condition?.resolved_date ?? ""
  );

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<ConditionOpenPanel>({ scopeRef: formRef });

  // Best-effort code suggestion for a code-LESS condition. Only when no code is
  // already present (imported/coded rows keep theirs — never overwritten) and the
  // suggested code differs from what's typed.
  const suggestion = useMemo(() => {
    if (code.trim()) return null;
    return bestIcd10Suggestion(name);
  }, [name, code]);

  const summary = conditionFactSummary({
    code,
    codeSystem,
    codeSuggested,
    status,
    onsetDate,
    laterality,
    severity,
    stage,
    resolvedDate,
    notes,
    prefs,
  });

  function applySuggestion() {
    if (!suggestion) return;
    setCode(suggestion.code);
    setCodeSystem(ICD10_SYSTEM);
    setCodeSuggested(true);
  }

  // An explicit PICK from the catalog applies that entry's code immediately — the
  // owner's ruling, mirroring how the medication form auto-confirms an RxNorm code
  // when a catalog med is chosen (`onPickName` → `rx.autoConfirm`, #851 item 7).
  // A pick is unambiguous by construction here: each catalog name carries exactly one
  // curated code, so there is no candidate list to disambiguate and nothing to
  // degrade to. TYPING is untouched — a typed name still offers the #155
  // confirm-to-apply chip and never writes a code on its own.
  function onPickName(picked: string) {
    const picked10 = icd10CodeForName(picked);
    if (!picked10) return; // free-text row: nothing curated to apply
    pickedCode.current = picked10;
    setCode(picked10);
    setCodeSystem(ICD10_SYSTEM);
    setCodeSuggested(true);
  }

  // Editing the name away from the picked entry retracts the code the pick applied,
  // so the row can never claim a code for a concept it no longer names — the
  // medication form's `onNameChange` invalidation. A code the user typed, or one an
  // import carried in, is left alone: only this form's own pick is retractable.
  function onNameChange(next: string) {
    setName(next);
    if (pickedCode.current && code === pickedCode.current) {
      pickedCode.current = null;
      setCode("");
      setCodeSystem("");
      setCodeSuggested(false);
    }
  }

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("name") ?? "").trim()) {
      setError("Enter the condition name.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this condition. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Condition updated" : "Condition saved");
    if (!editing) {
      formRef.current?.reset();
      setStatus("active");
      setName("");
      setCode("");
      setCodeSystem("");
      setCodeSuggested(false);
      setLaterality("");
      setSeverity("");
      setStage("");
      setNotes("");
      setOnsetDate("");
      setResolvedDate("");
      pickedCode.current = null;
      closePanel();
      closeEntryModal?.();
    }
    onDone?.();
  }

  const uid = condition?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="condition-form"
    >
      {editing && <input type="hidden" name="id" value={condition!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      {/* THE RECORD'S OWN NAME IS THE HEADING ON A PAGE-HOSTED EDIT (#5300 rule 6).
          The add door is a dialog and takes "Add condition" from its host; an edit
          opens inside the list row, where nothing else says which condition is being
          changed. It states the condition AS STORED — the field below states what
          Save will write, and the two differ the moment someone types. */}
      {editing && (
        <h3
          data-testid="condition-form-heading"
          className="font-semibold text-slate-800 dark:text-slate-100"
        >
          {conditionDisplayLabel(condition!)}
        </h3>
      )}
      <div>
        <label className="label" htmlFor={`cond-name-${uid}`}>
          Condition
        </label>
        {/* The curated ICD-10-CM NAMES (#1676). suggestIcd10() has always ranked
            over them, but only the resulting CODE reached the UI — the names
            themselves were invisible, so a typed one-off spelling never became the
            catalog entry the code chip and lib/condition-codes' recognizers want.
            Synonyms ride along as hidden search terms, so "high blood pressure"
            still finds "Essential (primary) hypertension"; free text still saves. */}
        <Combobox
          id={`cond-name-${uid}`}
          name="name"
          ariaLabel="Condition"
          value={name}
          onChange={onNameChange}
          onPick={onPickName}
          options={[...ICD10_CONDITION_NAMES]}
          searchTermsFor={icd10SearchTerms}
          badgeFor={(option) => (
            <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
              {icd10CodeForName(option)}
            </span>
          )}
          allowFreeText
          placeholder="e.g. Asthma, Type 2 diabetes"
        />
      </div>

      {/* THE SENTENCE, and the one open editor behind it (#3218). At most one editor
          is on screen: the row is unmounted while a panel is open, and the host is
          display:none while none is. */}
      {openEditor == null && (
        <RecordFactRow
          prefix="condition"
          summary={summary}
          nouns={CONDITION_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(panel, focusKey) =>
            openPanel(panel as ConditionOpenPanel, focusKey)
          }
        />
      )}

      <FactEditorHost
        testId="condition-editor"
        doneTestId="condition-editor-done"
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
              <label className="label" htmlFor={`cond-code-${uid}`}>
                Code
              </label>
              <input
                id={`cond-code-${uid}`}
                name="code"
                className="input"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeSuggested(false);
                }}
                placeholder="e.g. J45.909"
              />
            </div>
            <div>
              <label className="label" htmlFor={`cond-codesys-${uid}`}>
                Code system
              </label>
              <input
                id={`cond-codesys-${uid}`}
                name="code_system"
                className="input"
                value={codeSystem}
                onChange={(e) => setCodeSystem(e.target.value)}
                placeholder="ICD-10 / SNOMED"
              />
            </div>
          </div>
          {suggestion && (
            <div
              data-testid="icd10-suggestion"
              className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
            >
              <span>
                Suggested code{" "}
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {suggestion.code}
                </span>{" "}
                ({ICD10_SYSTEM})
              </span>
              {/* Filling a field is not the form's commit, so it takes no rank
                  (ruling 6, #4978). */}
              <Button
                data-testid="icd10-suggestion-apply"
                onClick={applySuggestion}
              >
                Use code
              </Button>
            </div>
          )}
        </div>

        <div hidden={openEditor !== "status"}>
          <label className="label" htmlFor={`cond-status-${uid}`}>
            Status
          </label>
          <select
            id={`cond-status-${uid}`}
            name="status"
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as ConditionStatus)}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>

        <div hidden={openEditor !== "onset"}>
          <label className="label" htmlFor={`cond-onset-${uid}`}>
            Onset date
          </label>
          <DateField
            id={`cond-onset-${uid}`}
            name="onset_date"
            value={onsetDate}
            onChange={setOnsetDate}
          />
        </div>

        {/* Side / grade / stage (#1403). All optional: a condition that isn't sided or
            graded simply leaves them unstated — the app never guesses a side. The side
            matters most, because a sided condition is a distinct clinical entity
            (#482) and the problem-list label and dedupe key both read it. */}
        <div hidden={openEditor !== "laterality"}>
          <label className="label" htmlFor={`cond-laterality-${uid}`}>
            Side
          </label>
          <select
            id={`cond-laterality-${uid}`}
            name="laterality"
            className="input"
            value={laterality}
            onChange={(e) =>
              setLaterality(e.target.value as ConditionLaterality | "")
            }
          >
            <option value="">Not stated</option>
            {CONDITION_LATERALITIES.map((l) => (
              <option key={l} value={l}>
                {l[0].toUpperCase() + l.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div hidden={openEditor !== "severity"}>
          <label className="label" htmlFor={`cond-severity-${uid}`}>
            Severity
          </label>
          <select
            id={`cond-severity-${uid}`}
            name="severity"
            className="input"
            value={severity}
            onChange={(e) =>
              setSeverity(e.target.value as ConditionSeverity | "")
            }
          >
            <option value="">Not stated</option>
            {CONDITION_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div hidden={openEditor !== "stage"}>
          <label className="label" htmlFor={`cond-stage-${uid}`}>
            Stage
          </label>
          <input
            id={`cond-stage-${uid}`}
            name="stage"
            className="input"
            defaultValue={condition?.stage ?? ""}
            onChange={(e) => setStage(e.target.value)}
            placeholder="e.g. Stage IIIA, CKD stage 3b"
          />
        </div>

        {/* The resolved date is mounted only while the status is Resolved — the one
            field whose ABSENCE is the write's own rule rather than a panel's. It is a
            controlled DateField, so unmounting it clears nothing the person stated
            about a condition that is no longer resolved. */}
        {status === "resolved" && (
          <div hidden={openEditor !== "resolved"}>
            <label className="label" htmlFor={`cond-resolved-${uid}`}>
              Resolved date
            </label>
            <DateField
              id={`cond-resolved-${uid}`}
              name="resolved_date"
              value={resolvedDate}
              onChange={setResolvedDate}
            />
          </div>
        )}

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`cond-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`cond-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={condition?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="condition"
            more={summary.more}
            nouns={CONDITION_FACT_NOUNS}
            onOpen={(panel) => openPanel(panel as ConditionOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="condition-form-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="condition-form-primary-action"
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
