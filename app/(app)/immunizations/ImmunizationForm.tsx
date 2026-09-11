"use client";

import { useRef, useState } from "react";
import DateField from "@/components/DateField";
import Combobox from "@/components/Combobox";
import ProviderCombobox from "@/components/ProviderCombobox";
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
import { PICKER_NAMES, vaccineDisplayName } from "@/lib/immunization-catalog";
import {
  immunizationFactSummary,
  IMMUNIZATION_FACT_NOUNS,
  IMMUNIZATION_ROUTE_LABELS,
  type ImmunizationFactKey,
} from "@/lib/immunization-facts";
import InlineError from "@/components/InlineError";
import {
  IMMUNIZATION_ROUTES,
  type FormResult,
  type Immunization,
} from "@/lib/types";

// WHICH PANELS EXIST is the fact keys plus the trailing affordance's own menu — the
// intake form's shape (#3216).
type ImmunizationOpenPanel = ImmunizationFactKey | "more";

// Shared add/edit form, on the facts-with-editors primitive (#5302, over #3218 and
// #5300's grammar) — the first of slice 4's forms. Add mode: no `immunization`. Edit
// mode: pass the row + an `onDone` callback (renders a hidden id and a Cancel button).
// The vaccine field is a free-text combobox seeded from the catalog; the server action
// normalizes the chosen/typed name back to a catalog code on save.
//
// WHAT CHANGED, and what deliberately did not. Nine labelled controls stood open for a
// dose whose statement is the vaccine. Now the VACCINE is rule 1's one identifying
// field, the row states the DATE — the fact both consumers drop the dose over, argued
// in lib/immunization-facts — and the dose label, the three administration columns, the
// reaction, the provider and the notes live behind the one trailing affordance. The
// write is untouched: the same `<form action={…}>` posts the same named fields to the
// same Server Action.
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden; an unmounted field is a field the form CLEARS
// (#2359) and one the dirty-form registry cannot see. See ConditionForm's header for
// the same reading at the sibling address.
export default function ImmunizationForm({
  action,
  immunization,
  profileId,
  onDone,
  defaultDate,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  immunization?: Immunization;
  // Multi-view (#1359): the row's OWN profile, posted so an edit on a non-acting
  // member's dose targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
  defaultDate: string;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const prefs = useFormatPrefs();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!immunization;
  const [vaccine, setVaccine] = useState(
    immunization ? vaccineDisplayName(immunization.vaccine) : ""
  );
  const [error, setError] = useState<string | null>(null);
  // The chips' copies of the DOM-owned fields: `defaultValue` keeps the browser's value
  // the one that posts, and these only draw the sentence. The date is controlled
  // because `DateField` has no uncontrolled change callback, and its named input is
  // `type="hidden"`, which the dirty-form registry excludes anyway.
  const [date, setDate] = useState(immunization?.date ?? defaultDate);
  const [doseLabel, setDoseLabel] = useState(immunization?.dose_label ?? "");
  const [lotNumber, setLotNumber] = useState(immunization?.lot_number ?? "");
  const [route, setRoute] = useState(immunization?.route ?? "");
  const [site, setSite] = useState(immunization?.site ?? "");
  const [reaction, setReaction] = useState(immunization?.reaction ?? "");
  const [provider, setProvider] = useState(immunization?.provider_name ?? "");
  const [notes, setNotes] = useState(immunization?.notes ?? "");

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<ImmunizationOpenPanel>({ scopeRef: formRef });

  const summary = immunizationFactSummary({
    date,
    doseLabel,
    lotNumber,
    route,
    site,
    reaction,
    provider,
    notes,
    prefs,
  });

  async function handle(formData: FormData) {
    setError(null);
    formData.set("vaccine", vaccine);
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      // Keep the form and its input mounted, and surface the failure inline.
      setError("Couldn't save this immunization. Try again.");
      return;
    }
    // A validation guard now answers with a typed error instead of a silent
    // resolve — surface it inline and DON'T toast success or reset (issue #474).
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Immunization updated" : "Immunization saved");
    if (!editing) {
      formRef.current?.reset();
      setVaccine("");
      setDate(defaultDate);
      setDoseLabel("");
      setLotNumber("");
      setRoute("");
      setSite("");
      setReaction("");
      setProvider("");
      setNotes("");
      closePanel();
      closeEntryModal?.();
    }
    onDone?.();
  }

  const uid = immunization?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="immunization-form"
    >
      {editing && <input type="hidden" name="id" value={immunization!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      <div>
        <label className="label">Vaccine</label>
        <Combobox
          value={vaccine}
          onChange={setVaccine}
          options={PICKER_NAMES}
          allowFreeText
          name="vaccine"
          ariaLabel="Vaccine"
          placeholder="e.g. Tdap, MMR, Vaxelis, Yellow Fever"
          freeTextLabel={(q) => <>Use “{q}”</>}
        />
      </div>

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {openEditor == null && (
        <RecordFactRow
          prefix="immunization"
          summary={summary}
          nouns={IMMUNIZATION_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(panel, focusKey) =>
            openPanel(panel as ImmunizationOpenPanel, focusKey)
          }
        />
      )}

      <FactEditorHost
        testId="immunization-editor"
        doneTestId="immunization-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        // Hidden rather than unmounted — see the header: this form is DOM-collected,
        // so an unmounted field is a cleared field.
        className={openEditor == null ? "hidden" : undefined}
      >
        <div hidden={openEditor !== "date"}>
          <label className="label" htmlFor={`imm-date-${uid}`}>
            Date given
          </label>
          {/* NO `required` HERE, and it is the one attribute this adoption could not
              carry across: a `required` control inside a HIDDEN panel is not
              focusable, so the browser refuses the submit it cannot point at. The
              guard did not move — `addImmunization` already answers a blank date with
              `formError("Enter a valid date given.")`, which this form renders inline —
              and the dashed `date` chip is now what asks for it BEFORE the submit. The
              three forms adopted before this one keep `required` only on the
              identifying field, which is never hidden. */}
          <DateField
            id={`imm-date-${uid}`}
            name="date"
            value={date}
            onChange={setDate}
          />
        </div>

        <div hidden={openEditor !== "dose"}>
          <label className="label" htmlFor={`imm-dose-${uid}`}>
            Dose / label
          </label>
          <input
            id={`imm-dose-${uid}`}
            name="dose_label"
            className="input"
            defaultValue={immunization?.dose_label ?? ""}
            onChange={(e) => setDoseLabel(e.target.value)}
            placeholder="e.g. Booster, Dose 1, 2025 seasonal"
          />
        </div>

        {/* Administration details (#1406): lot / route / site are exactly what school,
            travel, camp and employer forms ask for, and had nowhere to live. All
            optional — a blank field stores NULL, not a guess. */}
        <div hidden={openEditor !== "lot"}>
          <label className="label" htmlFor={`imm-lot-${uid}`}>
            Lot number
          </label>
          <input
            id={`imm-lot-${uid}`}
            name="lot_number"
            className="input"
            defaultValue={immunization?.lot_number ?? ""}
            onChange={(e) => setLotNumber(e.target.value)}
            placeholder="e.g. AB1234"
          />
        </div>

        <div hidden={openEditor !== "route"}>
          <label className="label" htmlFor={`imm-route-${uid}`}>
            Route
          </label>
          <select
            id={`imm-route-${uid}`}
            name="route"
            className="input"
            defaultValue={immunization?.route ?? ""}
            onChange={(e) => setRoute(e.target.value)}
          >
            <option value="">Not stated</option>
            {IMMUNIZATION_ROUTES.map((r) => (
              <option key={r} value={r}>
                {IMMUNIZATION_ROUTE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>

        <div hidden={openEditor !== "site"}>
          <label className="label" htmlFor={`imm-site-${uid}`}>
            Site
          </label>
          <input
            id={`imm-site-${uid}`}
            name="site"
            className="input"
            defaultValue={immunization?.site ?? ""}
            onChange={(e) => setSite(e.target.value)}
            placeholder="e.g. Left deltoid"
          />
        </div>

        <div hidden={openEditor !== "reaction"}>
          <label className="label" htmlFor={`imm-reaction-${uid}`}>
            Reaction
          </label>
          {/* An adverse reaction to THIS dose; `notes` is the dose's general note. */}
          <input
            id={`imm-reaction-${uid}`}
            name="reaction"
            className="input"
            defaultValue={immunization?.reaction ?? ""}
            onChange={(e) => setReaction(e.target.value)}
            placeholder="e.g. Sore arm for two days"
          />
        </div>

        <div hidden={openEditor !== "provider"}>
          <label className="label" htmlFor={`imm-provider-${uid}`}>
            Administered by
          </label>
          {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
          <ProviderCombobox
            id={`imm-provider-${uid}`}
            name="provider"
            ariaLabel="Administered by"
            defaultValue={immunization?.provider_name ?? ""}
            onChange={setProvider}
            placeholder="e.g. Example Medical Center, Dr. Smith"
          />
          {/* Round-trip the loaded link so an untouched field keeps its id (#601). */}
          {editing && (
            <>
              <input
                type="hidden"
                name="provider_id"
                value={immunization?.provider_id ?? ""}
              />
              <input
                type="hidden"
                name="provider_loaded"
                value={immunization?.provider_name ?? ""}
              />
            </>
          )}
        </div>

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`imm-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`imm-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={immunization?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="immunization"
            more={summary.more}
            nouns={IMMUNIZATION_FACT_NOUNS}
            onOpen={(panel) => openPanel(panel as ImmunizationOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="immunization-form-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="immunization-form-primary-action"
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
