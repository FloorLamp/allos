"use client";

import { useMemo, useRef, useState } from "react";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import Combobox from "@/components/Combobox";
import { useProviderOptions } from "@/components/ProviderOptionsContext";
import { useToast } from "@/components/Toast";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import VisitFactRow from "@/components/encounters/VisitFactRow";
import { visitFactSummary, type VisitFactKey } from "@/lib/visit-facts";
import { ENCOUNTER_TYPE_OPTIONS } from "@/lib/encounter-kind";
import type { Encounter, FormResult } from "@/lib/types";

// Shared add/edit visit form, in the facts-with-editors grammar (#3218, #3223). Add
// mode: no `encounter` (blank fields, date seeded to defaultDate). Edit mode: pass the
// row + an `onDone` callback (renders a hidden id + a Cancel button). The date is
// required; provider + facility are create-on-type ProviderCombobox pickers (#1176) over
// the section's shared registry rows.
//
// IT STATES THE SAME SIX FACTS AS THE APPOINTMENT FORM and in the same words — that is
// what #3223 unifies. An encounter's `reason` and an appointment's `title` are one fact,
// as are `type` and `kind`; only the columns and the Server Action behind them differ.
// Read AppointmentForm's header for the two hazards both forms share: this is a
// DOM-COLLECTED `<form action={handle}>`, so its editors are MOUNTED AND HIDDEN rather
// than unmounted (#2359/#2014), and its plain fields stay DOM-OWNED rather than
// controlled so the dirty-form registry can still see them.
//
// ONE FACT MORE THAN THE APPOINTMENT: `diagnoses`, which only a visit that has already
// happened can have. `visitFactSummary` takes it as an optional input for exactly that
// reason, so the shared row does not have to learn which tense it is drawing.
export default function EncounterForm({
  action,
  encounter,
  profileId,
  onDone,
  onSaved,
  defaultDate,
  date,
  onDateChange,
  embedded = false,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  encounter?: Encounter;
  // Multi-view (#1359): the row's OWN profile, posted so an edit on a non-acting
  // member's visit targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
  onSaved?: () => void;
  defaultDate: string;
  // When the single "Add visit" wrapper (issue #566, #3223) owns the date, it passes it
  // controlled — the date is what routes the tense, so the wrapper has to see it.
  // Only used in add mode; edit mode keeps its own stored date.
  date?: string;
  onDateChange?: (v: string) => void;
  // The wrapper renders its own card heading, so it suppresses this form's built-in
  // "Add visit" heading to avoid a doubled title.
  embedded?: boolean;
}) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!encounter;
  const [error, setError] = useState<string | null>(null);
  const prefs = useFormatPrefs();
  const providers = useProviderOptions();

  // A manually added visit carries no class_code, so this free-text type is the ONLY
  // signal encounterKind() has — an unrecognized wording fell to "other" and dropped
  // out of every kind filter (#1676). Controlled, so the add path clears it.
  const [type, setType] = useState(encounter?.type ?? "");

  const uid = encounter?.id ?? "new";
  const storedDate = encounter?.date ?? defaultDate;
  // In add mode the wrapper may drive the date (controlled) so it can route the tense;
  // otherwise this form owns it.
  const controlledDate = !editing && date !== undefined;
  const [ownDate, setOwnDate] = useState(storedDate);
  const currentDate = controlledDate ? (date ?? "") : ownDate;

  // A MIRROR, NOT A SOURCE — see AppointmentForm's header. These values also live in the
  // DOM and the DOM is what submits; this state exists only so a chip can say what a
  // field holds without that field having to be controlled.
  const [mirror, setMirror] = useState(() => ({
    reason: encounter?.reason ?? "",
    diagnoses: encounter?.diagnoses ?? "",
    provider: encounter?.provider_name ?? "",
    location: encounter?.location_name ?? "",
    notes: encounter?.notes ?? "",
    endDate: encounter?.end_date ?? "",
  }));
  const [seeded, setSeeded] = useState<Partial<Record<VisitFactKey, boolean>>>(
    {}
  );

  const factScopeRef = useRef<HTMLDivElement>(null);
  const {
    openEditor,
    open: openFact,
    close: closeFact,
    onKeyDown: onFactKeyDown,
  } = useFactEditor<VisitFactKey>({ scopeRef: factScopeRef });

  const summary = useMemo(
    () =>
      visitFactSummary({
        tense: "past",
        date: currentDate,
        // A past visit has no clock column — its second date is an END DAY, and the
        // when-chip states the span rather than inventing a time of day (#2234).
        time: "",
        reason: mirror.reason,
        kind: type,
        provider: mirror.provider,
        location: mirror.location,
        notes: mirror.notes,
        diagnoses: mirror.diagnoses,
        seeded,
        prefs,
      }),
    [currentDate, mirror, type, seeded, prefs]
  );

  function setDate(v: string) {
    if (controlledDate) onDateChange?.(v);
    else setOwnDate(v);
  }

  // THE SEEDING PICK, narrower here than on the appointment branch and deliberately so.
  // A provider's ADDRESS is the facility, so picking one proposes the location. Its
  // SPECIALTY is not proposed as the visit type: `type` answers "what kind of encounter"
  // ("Office Visit", "Emergency") and a specialty answers "who you saw", so seeding
  // "Dermatology" there would put a word in the person's mouth that the kind filter
  // (#1676) would then have to make sense of.
  const locationRef = useRef<HTMLInputElement>(null);
  function pickProvider(name: string) {
    setMirror((m) => ({ ...m, provider: name }));
    const row = providers.find(
      (p) => p.name.toLowerCase() === name.trim().toLowerCase()
    );
    const address = row?.address?.trim();
    // Fills a blank only: a location already on the form is the person's.
    if (!address || !locationRef.current || locationRef.current.value) return;
    locationRef.current.value = address;
    setMirror((m) => ({ ...m, location: address }));
    setSeeded((s) => ({ ...s, location: true }));
  }

  function edited(key: VisitFactKey, patch: Partial<typeof mirror>) {
    setMirror((m) => ({ ...m, ...patch }));
    setSeeded((s) => (s[key] ? { ...s, [key]: false } : s));
  }

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("date") ?? "").trim()) {
      setError("Pick a date for this visit.");
      openFact("when");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this visit. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Visit updated" : "Visit saved");
    if (!editing) {
      formRef.current?.reset();
      setType("");
      // `reset()` returns every DOM-owned field to its default; the mirror has to follow
      // or the chips would keep stating a visit that is no longer in the form.
      setMirror({
        reason: "",
        diagnoses: "",
        provider: "",
        location: "",
        notes: "",
        endDate: "",
      });
      setSeeded({});
      setOwnDate(storedDate);
      closeFact();
    }
    onDone?.();
    onSaved?.();
  }

  const editorOpen = openEditor !== null;

  return (
    <form
      ref={formRef}
      action={handle}
      className={`${embedded ? "" : "card "}space-y-3`}
    >
      {!editing && !embedded && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add visit
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={encounter!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      {/* Round-trip the loaded provider and facility links so an untouched field keeps
          its id (#601). Hidden inputs: neither chips nor registry-tracked, and outside
          the panels so they post on every save. */}
      {editing && (
        <>
          <input
            type="hidden"
            name="provider_id"
            value={encounter?.provider_id ?? ""}
          />
          <input
            type="hidden"
            name="provider_loaded"
            value={encounter?.provider_name ?? ""}
          />
          <input
            type="hidden"
            name="location_provider_id"
            value={encounter?.location_provider_id ?? ""}
          />
          <input
            type="hidden"
            name="location_loaded"
            value={encounter?.location_name ?? ""}
          />
        </>
      )}

      {/* The scope the chips and the one editor share (#3311, #3222). */}
      <div ref={factScopeRef} onKeyDown={onFactKeyDown}>
        {!editorOpen && (
          <VisitFactRow
            testId="encounter-fact-row"
            summary={summary}
            openEditor={openEditor}
            onOpen={openFact}
          />
        )}

        {/* MOUNTED ALWAYS, hidden when nothing is open — a field the browser cannot see
            is a field this whole-row write CLEARS (#2359). */}
        <FactEditorHost
          testId="encounter-fact-editor"
          doneTestId="encounter-fact-editor-done"
          panel={openEditor ?? undefined}
          className={
            editorOpen
              ? "rounded-lg border border-(--border) bg-surface p-3"
              : "hidden"
          }
          onDone={closeFact}
        >
          <div hidden={openEditor !== "provider"}>
            <label className="label" htmlFor={`enc-provider-${uid}`}>
              Provider
            </label>
            {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
            <ProviderCombobox
              id={`enc-provider-${uid}`}
              name="provider"
              defaultValue={encounter?.provider_name ?? ""}
              placeholder="e.g. Dr. Smith"
              onChange={pickProvider}
            />
          </div>

          <div hidden={openEditor !== "kind"}>
            <label className="label" htmlFor={`enc-type-${uid}`}>
              Visit type
            </label>
            <Combobox
              id={`enc-type-${uid}`}
              name="type"
              ariaLabel="Visit type"
              value={type}
              onChange={setType}
              options={[...ENCOUNTER_TYPE_OPTIONS]}
              allowFreeText
              placeholder="e.g. Office Visit, Emergency, Hospitalization"
            />
          </div>

          <div hidden={openEditor !== "when"}>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor={`enc-date-${uid}`}>
                  Date
                </label>
                <DateField
                  id={`enc-date-${uid}`}
                  name="date"
                  value={currentDate}
                  onChange={setDate}
                />
              </div>
              <div>
                <label className="label" htmlFor={`enc-end-${uid}`}>
                  End date (optional)
                </label>
                <DateField
                  id={`enc-end-${uid}`}
                  name="end_date"
                  value={mirror.endDate}
                  onChange={(v) => edited("when", { endDate: v })}
                />
              </div>
            </div>
          </div>

          <div hidden={openEditor !== "reason"}>
            <label className="label" htmlFor={`enc-reason-${uid}`}>
              Reason (chief complaint)
            </label>
            <input
              id={`enc-reason-${uid}`}
              name="reason"
              className="input"
              defaultValue={encounter?.reason ?? ""}
              placeholder="e.g. Annual physical, Chest pain"
              onChange={(e) => edited("reason", { reason: e.target.value })}
            />
          </div>

          <div hidden={openEditor !== "location"}>
            <label className="label" htmlFor={`enc-location-${uid}`}>
              Facility / location
            </label>
            <ProviderCombobox
              id={`enc-location-${uid}`}
              name="location"
              ariaLabel="Facility"
              defaultValue={encounter?.location_name ?? ""}
              placeholder="e.g. Example Medical Center, telehealth"
              onChange={(v) => edited("location", { location: v })}
            />
          </div>

          <div hidden={openEditor !== "diagnoses"}>
            <label className="label" htmlFor={`enc-diagnoses-${uid}`}>
              Diagnoses
            </label>
            <input
              id={`enc-diagnoses-${uid}`}
              name="diagnoses"
              className="input"
              defaultValue={encounter?.diagnoses ?? ""}
              placeholder="Separate multiple with “; ”"
              onChange={(e) =>
                edited("diagnoses", { diagnoses: e.target.value })
              }
            />
          </div>

          <div hidden={openEditor !== "notes"}>
            <label className="label" htmlFor={`enc-notes-${uid}`}>
              Notes
            </label>
            <input
              id={`enc-notes-${uid}`}
              name="notes"
              className="input"
              defaultValue={encounter?.notes ?? ""}
              onChange={(e) => edited("notes", { notes: e.target.value })}
            />
          </div>
        </FactEditorHost>
      </div>

      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <SubmitButton className="btn w-full" pendingLabel="Saving…">
          {editing ? "Save" : "Add"}
        </SubmitButton>
        {editing && onDone && (
          <button type="button" className="btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
