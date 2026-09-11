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
  carePlanFactSummary,
  CARE_PLAN_FACT_NOUNS,
  type CarePlanFactKey,
} from "@/lib/care-plan-facts";
import {
  CARE_PLAN_CATEGORIES,
  CARE_PLAN_CATEGORY_LABELS,
  CARE_PLAN_CLOSED_STATUS_LIST,
  CARE_PLAN_OPEN_STATUSES,
  isRecognizedCarePlanStatus,
} from "@/lib/care-plan-upcoming";
import type { CarePlanItem, FormResult } from "@/lib/types";
import InlineError from "@/components/InlineError";

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

// WHICH PANELS EXIST is the fact keys plus the trailing affordance's own menu — the
// intake form's shape (#3216), so opening "more" still leaves exactly one editor on
// screen.
type CarePlanOpenPanel = CarePlanFactKey | "more";

// Shared add/edit care-plan form, on the facts-with-editors primitive (#5302, over
// #3218 and #5300's grammar) — the first of the three care-overview forms, adopting
// the shape lib/condition-facts.ts and components/records/RecordFactRow.tsx set.
//
// WHAT CHANGED, and what deliberately did not. Seven labelled controls stood open,
// with a standing paragraph about unrecognized statuses underneath them. Now the
// PLANNED ITEM is rule 1's one identifying field, the row states the planned date, and
// everything else lives behind the one trailing affordance until someone wants it. The
// write is untouched: the same `<form action={…}>` posts the same named fields —
// including the hidden `category`/`status` inputs the pickers' free-text escape
// switches between — to the same Server Action.
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden. A field that unmounts when its panel closes is
// a field the form CLEARS (#2359), and it is invisible to the dirty-form registry,
// which skips anything where `!field.isConnected`. See ConditionForm's header for the
// same reading at the sibling address.
//
// NO STANDING PROSE. The unrecognized-status notice — "this item keeps counting as
// open and keeps appearing in Upcoming" — is what the chosen VALUE means, so it moved
// inside the status editor, which is where someone typing that status is already
// looking (#5300 rule 4, the allergy form's refuted sentence at this address).
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
  const closeEntryModal = useAddEntryModalClose();
  const prefs = useFormatPrefs();
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
  // The chips' copies of the DOM-owned fields: `defaultValue` keeps the browser's
  // value the one that posts, and these only draw the sentence. The date is
  // controlled because `DateField` has no uncontrolled change callback, and its named
  // input is `type="hidden"`, which the dirty-form registry excludes anyway.
  const [plannedDate, setPlannedDate] = useState(item?.planned_date ?? "");
  const [code, setCode] = useState(item?.code ?? "");
  const [codeSystem, setCodeSystem] = useState(item?.code_system ?? "");
  const [provider, setProvider] = useState(item?.provider_name ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<CarePlanOpenPanel>({ scopeRef: formRef });

  // What the form will POST, which is what the chips must state: the picker's own
  // value is a sentinel while the free-text escape is open.
  const postedCategory = category === OTHER ? categoryOther : category;
  const postedStatus = status === OTHER ? statusOther : status;

  const summary = carePlanFactSummary({
    category: postedCategory,
    status: postedStatus,
    code,
    codeSystem,
    plannedDate,
    provider,
    notes,
    prefs,
  });

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
      setPlannedDate("");
      setCode("");
      setCodeSystem("");
      setProvider("");
      setNotes("");
      closePanel();
      closeEntryModal?.();
    }
    onDone?.();
  }

  const uid = item?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="care-plan-form"
    >
      {editing && <input type="hidden" name="id" value={item!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      {/* THE RECORD'S OWN NAME IS THE HEADING ON A PAGE-HOSTED EDIT (#5300 rule 6).
          The add door is a dialog and takes "Add care-plan item" from its host; an
          edit opens inside the list row, where nothing else says which item is being
          changed. It states the item AS STORED — the field below states what Save
          will write. */}
      {editing && (
        <h3
          data-testid="care-plan-form-heading"
          className="font-semibold text-slate-800 dark:text-slate-100"
        >
          {item!.description}
        </h3>
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

      {/* THE SENTENCE, and the one open editor behind it (#3218). At most one editor
          is on screen: the row is unmounted while a panel is open, and the host is
          display:none while none is. */}
      {openEditor == null && (
        <RecordFactRow
          prefix="care-plan"
          summary={summary}
          nouns={CARE_PLAN_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(panel, focusKey) =>
            openPanel(panel as CarePlanOpenPanel, focusKey)
          }
        />
      )}

      <FactEditorHost
        testId="care-plan-editor"
        doneTestId="care-plan-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        // Hidden rather than unmounted — see the header: this form is DOM-collected,
        // so an unmounted field is a cleared field.
        className={openEditor == null ? "hidden" : undefined}
      >
        <div hidden={openEditor !== "planned"}>
          <label className="label" htmlFor={`cp-date-${uid}`}>
            Planned date
          </label>
          <DateField
            id={`cp-date-${uid}`}
            name="planned_date"
            value={plannedDate}
            onChange={setPlannedDate}
          />
        </div>

        <div hidden={openEditor !== "category"}>
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

        <div hidden={openEditor !== "status"}>
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
          {/* The one sentence an open editor may carry (#5300 rule 4): what the
              chosen value MEANS, beside the control that chooses it. An unknown
              status counts as OPEN — the safe direction for a real plan with an odd
              imported status, and unchanged by this issue — which means a free-text
              "finished" does NOT close the item. */}
          {status === OTHER && !isRecognizedCarePlanStatus(statusOther) && (
            <p
              data-testid={`cp-status-unrecognized-${uid}`}
              className="mt-1.5 text-xs text-amber-700 dark:text-amber-400"
            >
              A status outside the list above sits outside the open/closed
              machinery: this item keeps counting as open and keeps appearing in
              Upcoming. Pick a closed status to stop it.
            </p>
          )}
        </div>

        <div hidden={openEditor !== "code"}>
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
                onChange={(e) => setCode(e.target.value)}
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
                onChange={(e) => setCodeSystem(e.target.value)}
                placeholder="CPT / SNOMED CT"
              />
            </div>
          </div>
        </div>

        <div hidden={openEditor !== "provider"}>
          <label className="label" htmlFor={`cp-provider-${uid}`}>
            Provider
          </label>
          {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
          <ProviderCombobox
            id={`cp-provider-${uid}`}
            name="provider"
            defaultValue={item?.provider_name ?? ""}
            onChange={setProvider}
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

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`cp-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`cp-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={item?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="care-plan"
            more={summary.more}
            nouns={CARE_PLAN_FACT_NOUNS}
            onOpen={(panel) => openPanel(panel as CarePlanOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="care-plan-form-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="care-plan-form-primary-action"
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
