"use client";

import { useRef, useState } from "react";
import Button from "@/components/Button";
import SubmitButton from "@/components/SubmitButton";
import Combobox from "@/components/Combobox";
import { useToast } from "@/components/Toast";
import { useAddEntryModalClose } from "@/components/AddEntryPanel";
import InlineError from "@/components/InlineError";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import RecordFactRow, {
  RecordFactMoreMenu,
} from "@/components/records/RecordFactRow";
import {
  familyFactSummary,
  FAMILY_HISTORY_FACT_NOUNS,
  type FamilyHistoryFactKey,
} from "@/lib/family-history-facts";
import {
  icd10CodeForName,
  icd10SearchTerms,
  ICD10_CONDITION_NAMES,
  ICD10_SYSTEM,
} from "@/lib/icd10";
import {
  FAMILY_LINEAGES,
  type FamilyHistory,
  type FamilyLineage,
  type FamilyRelationType,
  type FormResult,
} from "@/lib/types";

// Common relatives, offered as a pick-or-type Combobox (allowFreeText).
const RELATIONS = [
  "Mother",
  "Father",
  "Sister",
  "Brother",
  "Sibling",
  "Daughter",
  "Son",
  "Maternal grandmother",
  "Maternal grandfather",
  "Paternal grandmother",
  "Paternal grandfather",
  "Aunt",
  "Uncle",
  "Cousin",
];

// WHICH PANELS EXIST. The three death fields are ONE fact over ONE editor — see
// lib/family-history-facts — so there is no `deceased` or `cause` panel; `more` is the
// trailing affordance's own menu (#3216's shape).
type FamilyOpenPanel = FamilyHistoryFactKey | "more";

// Shared add/edit family-history form, on the facts-with-editors primitive (#5302,
// over #3218 and #5300's grammar) — the third of the three care-overview forms.
//
// WHAT CHANGED, and what deliberately did not. Ten labelled controls stood open for a
// record whose ICD-10-CM pick already answers the code. Now the CONDITION is rule 1's
// one identifying field — it is also the form's required value — the row states the
// relative and the code, and the genetic axis, the onset age, the death facts and the
// notes live behind the one trailing affordance until someone wants them. The write is
// untouched: the same `<form action={…}>` posts the same named fields to the same
// Server Action, and nothing about what a family-history row stores moved.
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden. A field that unmounts when its panel closes is
// a field the form CLEARS (#2359), and it is invisible to the dirty-form registry,
// which skips anything where `!field.isConnected`. See ConditionForm's header for the
// same reading at the sibling address.
//
// THE THREE DEATH CONTROLS SHARE ONE EDITOR because they describe one event and are
// read back as one line: "Died at 52 — Myocardial infarction" (`familyDeathLabel`).
// Splitting them into three chips would state one fact three times.
export default function FamilyHistoryForm({
  action,
  entry,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  entry?: FamilyHistory;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!entry;
  const [error, setError] = useState<string | null>(null);
  // Relation is a controlled Combobox (#1177) — form.reset() can't clear it, so the
  // add path clears this state explicitly on a successful save.
  const [relation, setRelation] = useState(entry?.relation ?? "");
  // Condition draws on the SAME curated ICD-10-CM vocabulary the conditions form
  // does (#1676) — lib/condition-codes' recognizers read family-history names too,
  // and this field previously offered no suggestion at all.
  const [condition, setCondition] = useState(entry?.condition ?? "");
  // Code and code system are controlled so a catalog PICK can fill them, per the
  // owner's ruling that a pick applies its code the way the medication form's
  // RxNorm confirm does. Same picker, same two fields, same behaviour as
  // ConditionForm — the ruling is about the pick, not about which form it is in.
  const [code, setCode] = useState(entry?.code ?? "");
  const [codeSystem, setCodeSystem] = useState(entry?.code_system ?? "");
  // Whether the code on screen was supplied FOR the person by the catalog pick
  // rather than typed (#846). The chip says so, and a typed character takes the
  // marking off — the condition form's reading at this address.
  const [codeSuggested, setCodeSuggested] = useState(false);
  // The code THIS form applied from a pick, so a later name edit can retract it
  // without ever touching a code the user typed or an import carried in
  // (ConditionForm's pickedCode, itself the medication form's rxcuiRef).
  const pickedCode = useRef<string | null>(null);
  // The chips' copies of the DOM-owned fields; see the header.
  const [relationship, setRelationship] = useState<FamilyRelationType | "">(
    entry?.relation_type ?? ""
  );
  const [lineage, setLineage] = useState<FamilyLineage | "">(
    entry?.lineage ?? ""
  );
  const [onsetAge, setOnsetAge] = useState(
    entry?.onset_age == null ? "" : String(entry.onset_age)
  );
  const [deceased, setDeceased] = useState(entry?.deceased === 1);
  const [ageAtDeath, setAgeAtDeath] = useState(
    entry?.age_at_death == null ? "" : String(entry.age_at_death)
  );
  const [causeOfDeath, setCauseOfDeath] = useState(entry?.cause_of_death ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<FamilyOpenPanel>({ scopeRef: formRef });

  const summary = familyFactSummary({
    relation,
    code,
    codeSystem,
    codeSuggested,
    relationship,
    lineage,
    onsetAge,
    deceased,
    ageAtDeath,
    causeOfDeath,
    notes,
  });

  // An explicit pick applies that entry's curated code immediately. Nothing here
  // fires for typed text: unlike the conditions form, family history has no
  // confirm-to-apply chip, so a typed condition simply carries no code — exactly as
  // it did before.
  function onPickCondition(picked: string) {
    const picked10 = icd10CodeForName(picked);
    if (!picked10) return; // free-text row: nothing curated to apply
    pickedCode.current = picked10;
    setCode(picked10);
    setCodeSystem(ICD10_SYSTEM);
    setCodeSuggested(true);
  }

  // Editing the condition away from the picked entry retracts the code the pick
  // applied — and only that code.
  function onConditionChange(next: string) {
    setCondition(next);
    if (pickedCode.current && code === pickedCode.current) {
      pickedCode.current = null;
      setCode("");
      setCodeSystem("");
      setCodeSuggested(false);
    }
  }

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("condition") ?? "").trim()) {
      setError("Enter the condition.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this entry. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Family history updated" : "Family history saved");
    if (!editing) {
      formRef.current?.reset();
      setRelation("");
      setCondition("");
      setCode("");
      setCodeSystem("");
      setCodeSuggested(false);
      setRelationship("");
      setLineage("");
      setOnsetAge("");
      setDeceased(false);
      setAgeAtDeath("");
      setCauseOfDeath("");
      setNotes("");
      pickedCode.current = null;
      closePanel();
      closeEntryModal?.();
    }
    onDone?.();
  }

  const uid = entry?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="family-history-form"
    >
      {editing && <input type="hidden" name="id" value={entry!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      {/* THE RECORD'S OWN NAME IS THE HEADING ON A PAGE-HOSTED EDIT (#5300 rule 6);
          the add door is a dialog and takes "Add family history" from its host. It
          states the entry AS STORED — the field below states what Save will write. */}
      {editing && (
        <h3
          data-testid="family-history-form-heading"
          className="font-semibold text-slate-800 dark:text-slate-100"
        >
          {entry!.condition}
        </h3>
      )}
      <div>
        <label className="label" htmlFor={`fh-condition-${uid}`}>
          Condition
        </label>
        <Combobox
          id={`fh-condition-${uid}`}
          name="condition"
          ariaLabel="Condition"
          value={condition}
          onChange={onConditionChange}
          onPick={onPickCondition}
          options={[...ICD10_CONDITION_NAMES]}
          searchTermsFor={icd10SearchTerms}
          badgeFor={(option) => (
            <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
              {icd10CodeForName(option)}
            </span>
          )}
          allowFreeText
          placeholder="e.g. Type 2 diabetes, Breast cancer"
        />
      </div>

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {openEditor == null && (
        <RecordFactRow
          prefix="family-history"
          summary={summary}
          nouns={FAMILY_HISTORY_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(panel, focusKey) =>
            openPanel(panel as FamilyOpenPanel, focusKey)
          }
        />
      )}

      <FactEditorHost
        testId="family-history-editor"
        doneTestId="family-history-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        // Hidden rather than unmounted — see the header: this form is DOM-collected,
        // so an unmounted field is a cleared field.
        className={openEditor == null ? "hidden" : undefined}
      >
        <div hidden={openEditor !== "relation"}>
          <label className="label" htmlFor={`fh-relation-${uid}`}>
            Relative
          </label>
          <Combobox
            id={`fh-relation-${uid}`}
            name="relation"
            ariaLabel="Relative"
            value={relation}
            onChange={setRelation}
            options={RELATIONS}
            allowFreeText
            placeholder="e.g. Mother, Father, Sibling"
          />
        </div>

        <div hidden={openEditor !== "code"}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={`fh-code-${uid}`}>
                Code
              </label>
              <input
                id={`fh-code-${uid}`}
                name="code"
                className="input"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeSuggested(false);
                }}
                placeholder="e.g. E11.9"
              />
            </div>
            <div>
              <label className="label" htmlFor={`fh-codesys-${uid}`}>
                Code system
              </label>
              <input
                id={`fh-codesys-${uid}`}
                name="code_system"
                className="input"
                value={codeSystem}
                onChange={(e) => setCodeSystem(e.target.value)}
                placeholder="SNOMED CT / ICD-10"
              />
            </div>
          </div>
        </div>

        {/* The genetic axis (#1407). A genetic-risk read that treats an ADOPTED
            parent's history as hereditary is wrong, so the discriminator is a stated
            fact here — left unstated it reads as genetic, which is what every row
            written before this field meant. */}
        <div hidden={openEditor !== "relationship"}>
          <label className="label" htmlFor={`fh-relation-type-${uid}`}>
            Relationship
          </label>
          <select
            id={`fh-relation-type-${uid}`}
            name="relation_type"
            className="input"
            defaultValue={entry?.relation_type ?? ""}
            onChange={(e) =>
              setRelationship(e.target.value as FamilyRelationType | "")
            }
          >
            <option value="">Not stated (genetic)</option>
            <option value="genetic">Genetic (biological)</option>
            <option value="half">Half sibling</option>
            <option value="adopted">Adopted — not genetic</option>
            <option value="step">Step — not genetic</option>
          </select>
        </div>

        <div hidden={openEditor !== "lineage"}>
          <label className="label" htmlFor={`fh-lineage-${uid}`}>
            Family side
          </label>
          <select
            id={`fh-lineage-${uid}`}
            name="lineage"
            className="input"
            defaultValue={entry?.lineage ?? ""}
            onChange={(e) => setLineage(e.target.value as FamilyLineage | "")}
          >
            <option value="">Not stated</option>
            {FAMILY_LINEAGES.map((l) => (
              <option key={l} value={l}>
                {l[0].toUpperCase() + l.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div hidden={openEditor !== "onsetAge"}>
          <label className="label" htmlFor={`fh-age-${uid}`}>
            Age at onset
          </label>
          <input
            id={`fh-age-${uid}`}
            name="onset_age"
            type="number"
            min={0}
            max={130}
            className="input"
            defaultValue={entry?.onset_age ?? ""}
            onChange={(e) => setOnsetAge(e.target.value)}
            placeholder="years"
          />
        </div>

        {/* Age and cause of death (#1407) — "father, MI at 52" is precisely what the
            screening-cadence logic keys on, and neither half had a home before this.
            Filling either states the death, so the checkbox follows them. ONE editor
            for the three, because they describe one event. */}
        <fieldset
          className="space-y-3"
          data-testid={`fh-death-${uid}`}
          hidden={openEditor !== "death"}
        >
          <legend className="label">Death</legend>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={`fh-age-death-${uid}`}>
                Age at death
              </label>
              <input
                id={`fh-age-death-${uid}`}
                name="age_at_death"
                type="number"
                min={0}
                max={130}
                className="input"
                defaultValue={entry?.age_at_death ?? ""}
                onChange={(e) => setAgeAtDeath(e.target.value)}
                placeholder="years"
              />
            </div>
            <div>
              <label className="label" htmlFor={`fh-cause-death-${uid}`}>
                Cause of death
              </label>
              <input
                id={`fh-cause-death-${uid}`}
                name="cause_of_death"
                className="input"
                defaultValue={entry?.cause_of_death ?? ""}
                onChange={(e) => setCauseOfDeath(e.target.value)}
                placeholder="e.g. Myocardial infarction"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              name="deceased"
              type="checkbox"
              defaultChecked={entry?.deceased === 1}
              onChange={(e) => setDeceased(e.target.checked)}
              className="h-4 w-4"
            />
            Deceased
          </label>
        </fieldset>

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`fh-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`fh-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={entry?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="family-history"
            more={summary.more}
            nouns={FAMILY_HISTORY_FACT_NOUNS}
            onOpen={(panel) => openPanel(panel as FamilyOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="family-history-form-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="family-history-form-primary-action"
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
