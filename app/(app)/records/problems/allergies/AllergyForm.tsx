"use client";

import { useRef, useState } from "react";
import DateField from "@/components/DateField";
import Button from "@/components/Button";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import Combobox from "@/components/Combobox";
import EncounterField from "@/components/EncounterField";
import { useEncounterOptions } from "@/components/EncounterOptionsContext";
import { formatVisitLabel } from "@/lib/record-format";
import { useToast } from "@/components/Toast";
import { useAddEntryModalClose } from "@/components/AddEntryPanel";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import InlineError from "@/components/InlineError";
import FactChipRow, {
  FactChip,
  FactMoreChip,
} from "@/components/facts/FactChipRow";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import {
  allergyFactSummary,
  moreAllergyFactsLabel,
  ALLERGY_FACT_NOUNS,
  type AllergyFactKey,
} from "@/lib/allergy-facts";
import {
  ALLERGY_CRITICALITIES,
  ALLERGY_VERIFICATION_STATUSES,
  type Allergy,
  type AllergyCriticality,
  type AllergyStatus,
  type AllergyVerificationStatus,
  type FormResult,
} from "@/lib/types";
import {
  composeAllergyReactions,
  ALLERGY_REACTION_SEVERITIES,
  ALLERGY_REACTION_SEVERITY_LABELS,
  isCanonicalReactionSeverity,
} from "@/lib/allergy-reactions";
import {
  ALLERGEN_OPTIONS,
  allergenSearchTerms,
} from "@/lib/allergen-vocabulary";

// Labels for the two CHECK-pinned safety vocabularies (#1405). "Not stated" is the
// default option in both — an unstated criticality is not "low", and an unstated
// verification is not "confirmed".
const CRITICALITY_OPTIONS: Record<
  (typeof ALLERGY_CRITICALITIES)[number],
  string
> = {
  low: "Low — unlikely to be life-threatening",
  high: "High — could be life-threatening",
  "unable-to-assess": "Not assessable",
};

const VERIFICATION_OPTIONS: Record<
  (typeof ALLERGY_VERIFICATION_STATUSES)[number],
  string
> = {
  unconfirmed: "Unconfirmed",
  suspected: "Suspected",
  confirmed: "Confirmed",
  refuted: "Refuted — ruled out",
  "entered-in-error": "Entered in error",
};

// A blank manifestation row.
const EMPTY_ROW = { manifestation: "", severity: "" };

// WHICH PANELS EXIST. The two essentials are two chips over ONE editor — see
// lib/allergy-facts — so `severity` is not a panel of its own; `more` is the trailing
// affordance's own menu (#3216's shape).
type AllergyOpenPanel = Exclude<AllergyFactKey, "severity"> | "more";

// The panel a chip opens. Everything opens its own editor except the severity, which
// is stated per manifestation row and so opens the reactions editor beside it.
const PANEL_OF_FACT: Record<AllergyFactKey, AllergyOpenPanel> = {
  reaction: "reaction",
  severity: "reaction",
  criticality: "criticality",
  verification: "verification",
  status: "status",
  onset: "onset",
  provider: "provider",
  encounter: "encounter",
  notes: "notes",
};

// Shared add/edit allergy form, on the facts-with-editors primitive (#5302, over
// #3218 and #5300's grammar) — the condition form's sibling, and the second of the
// thirteen clinical record forms to adopt it.
//
// WHAT CHANGED, and what deliberately did not. Nine labelled controls stood open,
// including a repeatable reaction list and a standing sentence about what a refuted
// allergy stops doing. Now the SUBSTANCE is rule 1's one identifying field, the row
// states the reaction, its grade and the status, and the rest live behind the one
// trailing affordance. The write is untouched: the same `<form action={…}>` posts the
// same named fields — including the parallel `reaction_manifestation[]` /
// `reaction_severity[]` pairs — to the same Server Action.
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// closed panels are merely hidden; an unmounted field is a field the form CLEARS
// (#2359) and one the dirty-form registry cannot see. See ConditionForm's header for
// the same reading at the sibling address.
//
// NO STANDING PROSE. "A refuted allergy stays on record but stops gating your
// medications and drops off the emergency card" is what the VALUE means, so it moved
// inside the verification editor — the one sentence #5300 rule 4 allows an open editor
// to carry, where the person choosing the value is already looking.
export default function AllergyForm({
  action,
  allergy,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  allergy?: Allergy;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
}) {
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const prefs = useFormatPrefs();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!allergy;
  const [error, setError] = useState<string | null>(null);
  // Substance is a controlled Combobox over the curated allergen vocabulary (#1676)
  // — form.reset() can't clear it, so the add path clears this state explicitly on a
  // successful save, the way the family-history relation picker does.
  const [substance, setSubstance] = useState(allergy?.substance ?? "");
  // Repeatable manifestation rows (#1405): a peanut allergy that causes BOTH hives
  // AND anaphylaxis is two graded rows, not one string. Seeded through the SAME pure
  // composition every read surface uses, so an imported row whose reactions live
  // only in the parent's cached scalar edits as one row here.
  const [reactions, setReactions] = useState(() => {
    // `allergy.reactions` is already the composed list (getAllergies attaches it);
    // fall back to the parent's cached scalar for any caller that passes a raw row.
    const seeded = composeAllergyReactions(
      allergy ?? { reaction: null, severity: null },
      (allergy?.reactions ?? []).map((r, i) => ({ ...r, position: i }))
    ).map((r) => ({
      manifestation: r.manifestation,
      // Case-fold a canonical grade so it selects in the enum below; a source's own
      // wording ("Life-threatening") is left exactly as recorded and gets its own
      // option.
      severity: isCanonicalReactionSeverity(r.severity)
        ? r.severity!.trim().toLowerCase()
        : (r.severity ?? ""),
    }));
    return seeded.length > 0 ? seeded : [{ ...EMPTY_ROW }];
  });
  // The chips' copies of the DOM-owned fields: `defaultValue` keeps the browser's
  // value the one that posts, and these only draw the sentence.
  const [criticality, setCriticality] = useState<AllergyCriticality | "">(
    allergy?.criticality ?? ""
  );
  const [verification, setVerification] = useState<
    AllergyVerificationStatus | ""
  >(allergy?.verification_status ?? "");
  const [status, setStatus] = useState<AllergyStatus>(
    allergy?.status ?? "active"
  );
  const [onsetDate, setOnsetDate] = useState(allergy?.onset_date ?? "");
  const [provider, setProvider] = useState(allergy?.provider_name ?? "");
  const [notes, setNotes] = useState(allergy?.notes ?? "");
  // The visits this row's profile could be linked to. The picker renders nothing when
  // there are none, so the row must not offer the fact either.
  const visits = useEncounterOptions(profileId);
  // The linked visit's LABEL, mirrored off the picker — the chip states which visit,
  // and the select still posts the id. Seeded on the edit form through the SAME
  // `formatVisitLabel` the picker's own options use, so the chip and the option the
  // select is showing cannot read differently.
  const [encounter, setEncounter] = useState(() => {
    const linked = visits.find((e) => e.id === allergy?.encounter_id);
    return linked ? formatVisitLabel(linked, prefs) : "";
  });

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<AllergyOpenPanel>({ scopeRef: formRef });

  const summary = allergyFactSummary({
    reactions,
    criticality,
    verification,
    status,
    onsetDate,
    provider,
    encounter,
    linkableVisits: visits.length > 0,
    notes,
    prefs,
  });

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("substance") ?? "").trim()) {
      setError("Enter the substance you're allergic to.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this allergy. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Allergy updated" : "Allergy saved");
    if (!editing) {
      formRef.current?.reset();
      setSubstance("");
      setReactions([{ ...EMPTY_ROW }]);
      setCriticality("");
      setVerification("");
      setStatus("active");
      setOnsetDate("");
      setProvider("");
      setEncounter("");
      setNotes("");
      closePanel();
      closeEntryModal?.();
    }
    onDone?.();
  }

  const uid = allergy?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="allergy-form"
    >
      {editing && <input type="hidden" name="id" value={allergy!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      {/* THE RECORD'S OWN NAME IS THE HEADING ON A PAGE-HOSTED EDIT (#5300 rule 6);
          the add door is a dialog and takes "Add allergy" from its host. It states
          the allergy AS STORED — the field below states what Save will write. */}
      {editing && (
        <h3
          data-testid="allergy-form-heading"
          className="font-semibold text-slate-800 dark:text-slate-100"
        >
          {allergy!.substance}
        </h3>
      )}
      <div>
        <label className="label" htmlFor={`allergy-substance-${uid}`}>
          Substance
        </label>
        {/* The substance string is what the drug-allergy cross-check (#1029) and the
            cross-reactivity matcher (#153) key on, so a drifted spelling silently
            defeats both. The picker offers the curated allergen vocabulary (#1676);
            free text still saves, and the action canonicalizes a recognized alias. */}
        <Combobox
          id={`allergy-substance-${uid}`}
          name="substance"
          ariaLabel="Substance"
          value={substance}
          onChange={setSubstance}
          options={ALLERGEN_OPTIONS}
          searchTermsFor={allergenSearchTerms}
          allowFreeText
          placeholder="e.g. Penicillin, Peanut, Latex"
        />
      </div>

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {openEditor == null && (
        <FactChipRow testId="allergy-fact-row">
          {summary.chips.map((chip) => (
            <FactChip
              key={chip.key}
              testId={`allergy-fact-${chip.key}`}
              // The CHIP's own identity, which is not its panel's here: the reaction
              // and the severity are two chips over one editor, so focus has to come
              // back to the one that was tapped (#3311).
              focusKey={chip.key}
              label={chip.label}
              state={chip.state}
              expanded={openEditor === PANEL_OF_FACT[chip.key]}
              onOpen={(focusKey) => openPanel(PANEL_OF_FACT[chip.key], focusKey)}
            />
          ))}
          {summary.more.length > 0 && (
            <FactMoreChip
              testId="allergy-fact-more"
              focusKey="more"
              label={moreAllergyFactsLabel(summary.more)}
              expanded={openEditor === "more"}
              onOpen={(focusKey) => openPanel("more", focusKey)}
            />
          )}
        </FactChipRow>
      )}

      <FactEditorHost
        testId="allergy-editor"
        doneTestId="allergy-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        className={openEditor == null ? "hidden" : undefined}
      >
        <fieldset
          className="space-y-2"
          data-testid={`allergy-reactions-${uid}`}
          hidden={openEditor !== "reaction"}
        >
          <legend className="label">Reactions</legend>
          {reactions.map((r, i) => (
            <div className="grid grid-cols-2 gap-3" key={i}>
              <input
                name="reaction_manifestation"
                className="input"
                aria-label={`Reaction ${i + 1}`}
                data-testid={`allergy-reaction-${uid}-${i}`}
                value={r.manifestation}
                onChange={(e) =>
                  setReactions((rows) =>
                    rows.map((row, j) =>
                      j === i ? { ...row, manifestation: e.target.value } : row
                    )
                  )
                }
                placeholder="e.g. Hives, Anaphylaxis"
              />
              <div className="flex gap-2">
                {/* A grade is an enum at the ENTRY surface (#1676) — the three FHIR
                    reaction.severity values. The column stays free TEXT because
                    importers pass a source's own wording through, so a loaded
                    non-standard grade is preserved as its own option rather than
                    silently rewritten to the nearest canonical one. */}
                <select
                  name="reaction_severity"
                  className="input"
                  aria-label={`Severity ${i + 1}`}
                  data-testid={`allergy-severity-${uid}-${i}`}
                  value={r.severity}
                  onChange={(e) =>
                    setReactions((rows) =>
                      rows.map((row, j) =>
                        j === i ? { ...row, severity: e.target.value } : row
                      )
                    )
                  }
                >
                  <option value="">Not stated</option>
                  {ALLERGY_REACTION_SEVERITIES.map((sev) => (
                    <option key={sev} value={sev}>
                      {ALLERGY_REACTION_SEVERITY_LABELS[sev]}
                    </option>
                  ))}
                  {r.severity && !isCanonicalReactionSeverity(r.severity) && (
                    <option value={r.severity}>
                      {r.severity} — as recorded
                    </option>
                  )}
                </select>
                {reactions.length > 1 && (
                  // A per-row destructive control in a repeated list goes quiet
                  // rather than taking `danger` (ruling 10, #4978) — the same
                  // shape as the activity form's per-set remove.
                  <Button
                    aria-label={`Remove reaction ${i + 1}`}
                    onClick={() =>
                      setReactions((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
          {/* Adding a row is not this form's commit — the filled Save/Add below
              is — so it takes no rank (ruling 6, #4978). */}
          <Button
            data-testid={`allergy-add-reaction-${uid}`}
            onClick={() => setReactions((rows) => [...rows, { ...EMPTY_ROW }])}
          >
            Add reaction
          </Button>
        </fieldset>

        <div hidden={openEditor !== "criticality"}>
          <label className="label" htmlFor={`allergy-criticality-${uid}`}>
            Criticality
          </label>
          <select
            id={`allergy-criticality-${uid}`}
            name="criticality"
            className="input"
            defaultValue={allergy?.criticality ?? ""}
            onChange={(e) =>
              setCriticality(e.target.value as AllergyCriticality | "")
            }
          >
            <option value="">Not stated</option>
            {ALLERGY_CRITICALITIES.map((c) => (
              <option key={c} value={c}>
                {CRITICALITY_OPTIONS[c]}
              </option>
            ))}
          </select>
        </div>

        <div hidden={openEditor !== "verification"}>
          <label className="label" htmlFor={`allergy-verification-${uid}`}>
            Verification
          </label>
          <select
            id={`allergy-verification-${uid}`}
            name="verification_status"
            className="input"
            defaultValue={allergy?.verification_status ?? ""}
            onChange={(e) =>
              setVerification(e.target.value as AllergyVerificationStatus | "")
            }
          >
            <option value="">Not stated</option>
            {ALLERGY_VERIFICATION_STATUSES.map((v) => (
              <option key={v} value={v}>
                {VERIFICATION_OPTIONS[v]}
              </option>
            ))}
          </select>
          {/* The one sentence an open editor may carry (#5300 rule 4): what the
              chosen value MEANS, beside the control that chooses it. */}
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            A refuted allergy stays on record but stops gating your medications
            and drops off the emergency card.
          </p>
        </div>

        <div hidden={openEditor !== "status"}>
          <label className="label" htmlFor={`allergy-status-${uid}`}>
            Status
          </label>
          <select
            id={`allergy-status-${uid}`}
            name="status"
            className="input"
            defaultValue={allergy?.status ?? "active"}
            onChange={(e) => setStatus(e.target.value as AllergyStatus)}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>

        <div hidden={openEditor !== "onset"}>
          <label className="label" htmlFor={`allergy-onset-${uid}`}>
            Onset date
          </label>
          <DateField
            id={`allergy-onset-${uid}`}
            name="onset_date"
            value={onsetDate}
            onChange={setOnsetDate}
          />
        </div>

        {/* Attribution (#1526): who documented this allergy, and at which visit. An
            allergy gates drug warnings and prints on the emergency card, so "who
            confirmed it" is the natural companion to the verification status. */}
        <div hidden={openEditor !== "provider"}>
          <label className="label" htmlFor={`allergy-provider-${uid}`}>
            Documented by
          </label>
          {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
          <ProviderCombobox
            id={`allergy-provider-${uid}`}
            name="provider"
            defaultValue={allergy?.provider_name ?? ""}
            onChange={setProvider}
            placeholder="e.g. Dr. Okafor"
          />
          {editing && (
            <>
              <input
                type="hidden"
                name="provider_id"
                value={allergy?.provider_id ?? ""}
              />
              <input
                type="hidden"
                name="provider_loaded"
                value={allergy?.provider_name ?? ""}
              />
            </>
          )}
        </div>

        <div hidden={openEditor !== "encounter"}>
          <EncounterField
            uid={uid}
            label="Recorded at visit"
            defaultValue={allergy?.encounter_id ?? null}
            profileId={profileId}
            onChange={setEncounter}
            testid={`allergy-encounter-${uid}`}
          />
        </div>

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`allergy-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`allergy-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={allergy?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {/* The trailing affordance's panel is a MENU, not an editor. */}
        <div hidden={openEditor !== "more"}>
          <div className="flex flex-wrap gap-1.5 pointer-coarse:gap-3.5">
            {summary.more.map((key) => (
              <button
                key={key}
                type="button"
                data-testid={`allergy-more-${key}`}
                onClick={() => openPanel(PANEL_OF_FACT[key])}
                data-fact-chip="solo"
                className="rounded-full border border-(--border) px-3 text-sm transition hover:bg-(--ghost-hover)"
              >
                {ALLERGY_FACT_NOUNS[key]}
              </button>
            ))}
          </div>
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="allergy-form-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="allergy-form-primary-action"
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
