"use client";

import { useMemo, useRef, useState } from "react";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import { useProviderOptions } from "@/components/ProviderOptionsContext";
import { useToast } from "@/components/Toast";
import { useFocusFormOnParam } from "@/components/useFocusFormOnParam";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import VisitFactRow from "@/components/encounters/VisitFactRow";
import {
  specialtyToAppointmentKind,
  visitFactSummary,
  type VisitFactKey,
} from "@/lib/visit-facts";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
  APPOINTMENT_KINDS,
  APPOINTMENT_KIND_LABELS,
} from "@/lib/preventive-appointment";
import type { Appointment, FormResult } from "@/lib/types";
import InlineError from "@/components/InlineError";

// Shared add/edit form for a scheduled visit, in the facts-with-editors grammar (#3218,
// #3223). Add mode: no `appointment`. Edit mode: pass the row + `onDone` (renders a
// hidden id + a Cancel button). `prefill` seeds a NEW (create) form from a completed
// visit for a follow-up — same provider/reason/location, blank (defaultDate) date — and
// is ignored in edit mode. The date is required; the optional time submits as its own
// `time` field beside `date` (#2234 — the two columns the row stores, never folded into
// one string). Provider is a create-on-type ProviderCombobox (#1176) over the section's
// shared registry rows.
//
// ── TWO THINGS THIS FILE HAS TO GET RIGHT, AND BOTH FAIL SILENTLY ────────────
//
// 1. THIS IS A DOM-COLLECTED FORM. `<form action={handle}>` means the BROWSER gathers
//    the FormData from the mounted named inputs, and `updateAppointment` writes the whole
//    row — so a field the form omits is a field it CLEARS (#2359). A fact moved behind a
//    disclosure would vanish from the submission the moment its panel closed. So the
//    editors are MOUNTED AND HIDDEN, never unmounted: `display:none` hides a control from
//    the person and changes nothing about what the browser submits. That is also exactly
//    what the primitive's own contract asks for — "the editor is HIDDEN, not unmounted,
//    so the value still posts with the form (#2014)". The activity editor may unmount its
//    closed editor and says so in its own comment; that is a fact about THAT form (it
//    hand-builds its FormData), not about the pattern.
//
// 2. THE PLAIN FIELDS STAY DOM-OWNED. `serverValue()` in the dirty-form registry reads
//    `field.defaultValue`, and React syncs `defaultValue` onto a CONTROLLED field to
//    match its `value` — so a controlled field inside a named <form> reports
//    current === serverValue forever and can NEVER be dirty
//    (components/DirtyFormRegistry.tsx, lib/dirty-forms.ts). Binding `title` to React
//    state to feed its chip would therefore switch off the unsaved-input guard for it
//    with nothing on screen to show for it, and every test would still pass. So
//    `title`, `time`, `kind`, `location` and `notes` keep `defaultValue` + an onChange
//    MIRROR that feeds the chip label only; the mirror is never the source of what
//    submits. `date` and `provider` are DateField and ProviderCombobox, which hold their
//    own state internally and were never registry-visible — they lose nothing.
//
//    e2e/dirty-form-refresh.spec.ts is the pin, and it is this form: all three of its
//    #1878 tests type into "Reason / title" here.
//
// AND `required` CAME OFF THE DATE INPUT, deliberately. A `required` control inside a
// `display:none` panel makes the browser refuse the submit it cannot focus, which would
// break saving outright. The date guard in `handle` below already existed and already
// carries the message; the chip states the same absence as a dashed MISSING fact.
export default function AppointmentForm({
  action,
  appointment,
  onDone,
  onSaved,
  defaultDate,
  prefill,
  date,
  onDateChange,
  embedded = false,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  appointment?: Appointment;
  onDone?: () => void;
  onSaved?: () => void;
  defaultDate: string;
  prefill?: {
    title: string | null;
    provider: string | null;
    location: string | null;
    kind?: string | null;
  };
  // When the single "Add visit" wrapper (issue #566, #3223) owns the date, it passes it
  // controlled — the date is what routes the tense, so the wrapper has to see it.
  // Only used in add mode; edit mode keeps its own stored date.
  date?: string;
  onDateChange?: (v: string) => void;
  // The single "Add visit" wrapper renders its own card heading, so it suppresses this
  // form's built-in "Add appointment" heading.
  embedded?: boolean;
}) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!appointment;
  const [error, setError] = useState<string | null>(null);
  const prefs = useFormatPrefs();
  const providers = useProviderOptions();

  // The primary create form focuses itself when reached with ?new=1 — from the
  // command palette's "Add appointment" (issue #29) or a preventive "Book" CTA
  // (issue #85), which also prefills title/kind/date. The follow-up prefill form
  // (distinguished by its `onDone` Cancel handler) opts out so it never steals
  // focus from the main form.
  useFocusFormOnParam(formRef, "new", undefined, !editing && !onDone);

  // In add mode the wrapper may drive the date (controlled) so it can route the tense;
  // otherwise this form owns it.
  const controlledDate = !editing && date !== undefined;

  // The stored halves seed the edit fields directly (#2234).
  const storedDate = appointment?.date ?? defaultDate;
  const storedTime = appointment?.time_of_day ?? "";

  const uid = appointment?.id ?? "new";

  // ── The chip row's view of the form ────────────────────────────────────────
  //
  // A MIRROR, NOT A SOURCE. Every value below also lives in the DOM, and the DOM is what
  // submits (see note 2 in the header). This state exists so a chip can SAY what the
  // field holds without the field having to be controlled.
  const [ownDate, setOwnDate] = useState(storedDate);
  const [mirror, setMirror] = useState(() => ({
    title: appointment?.title ?? prefill?.title ?? "",
    time: storedTime,
    kind: appointment?.kind ?? prefill?.kind ?? "",
    provider: appointment?.provider_name ?? prefill?.provider ?? "",
    location: appointment?.location ?? prefill?.location ?? "",
    notes: appointment?.notes ?? "",
  }));
  // Which facts the app proposed rather than the person stating them (#846). Cleared per
  // fact the moment they touch it — a value they have edited is theirs.
  const [seeded, setSeeded] = useState<Partial<Record<VisitFactKey, boolean>>>(
    {}
  );

  // The DOM-owned fields the provider pick can seed. Seeding writes through the ref
  // rather than through React state precisely so these inputs stay uncontrolled.
  const kindRef = useRef<HTMLSelectElement>(null);
  const locationRef = useRef<HTMLInputElement>(null);

  const currentDate = controlledDate ? (date ?? "") : ownDate;

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
        tense: "upcoming",
        date: currentDate,
        time: mirror.time,
        reason: mirror.title,
        kind: mirror.kind,
        provider: mirror.provider,
        location: mirror.location,
        notes: mirror.notes,
        seeded,
        prefs,
      }),
    [currentDate, mirror, seeded, prefs]
  );

  function setDate(v: string) {
    if (controlledDate) onDateChange?.(v);
    else setOwnDate(v);
  }

  // THE SEEDING PICK (#3218's contract, #3223's acceptance criterion). A provider row
  // carries a specialty and an address, so choosing one proposes the kind and the
  // location — the two-tap confirm. It only ever FILLS A BLANK: a value already on the
  // form is the person's, and overwriting it would make the pick destructive.
  function pickProvider(name: string) {
    setMirror((m) => ({ ...m, provider: name }));
    const row = providers.find(
      (p) => p.name.toLowerCase() === name.trim().toLowerCase()
    );
    if (!row) return;
    const patch: Partial<typeof mirror> = {};
    const marks: Partial<Record<VisitFactKey, boolean>> = {};
    const kind = specialtyToAppointmentKind(row.specialty);
    if (kind && kindRef.current && !kindRef.current.value) {
      kindRef.current.value = kind;
      patch.kind = kind;
      marks.kind = true;
    }
    const address = row.address?.trim();
    if (address && locationRef.current && !locationRef.current.value) {
      locationRef.current.value = address;
      patch.location = address;
      marks.location = true;
    }
    if (Object.keys(patch).length === 0) return;
    setMirror((m) => ({ ...m, ...patch }));
    setSeeded((s) => ({ ...s, ...marks }));
  }

  // One field edited by hand: mirror it for the chip, and it is no longer a suggestion.
  function edited(key: VisitFactKey, patch: Partial<typeof mirror>) {
    setMirror((m) => ({ ...m, ...patch }));
    setSeeded((s) => (s[key] ? { ...s, [key]: false } : s));
  }

  async function handle(formData: FormData) {
    setError(null);
    const date = String(formData.get("date") ?? "").trim();
    if (!date) {
      setError("Pick a date for this appointment.");
      // Put the person where the missing fact is, rather than beside an error about a
      // field they cannot see.
      openFact("when");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this appointment. Try again.");
      return;
    }
    // A validation guard now answers with a typed error instead of a silent
    // resolve — surface it inline and DON'T toast success or reset (issue #474).
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Appointment updated" : "Appointment saved");
    if (!editing) {
      formRef.current?.reset();
      // `reset()` returns every DOM-owned field to its default; the mirror has to follow
      // or the chips would keep stating a visit that is no longer in the form.
      setMirror({
        title: "",
        time: "",
        kind: "",
        provider: "",
        location: "",
        notes: "",
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
          {onDone ? "Schedule follow-up" : "Add appointment"}
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={appointment!.id} />}
      {/* Round-trip the loaded link so an untouched field keeps its id (#601). Hidden
          inputs, so they are neither chips nor registry-tracked; they sit outside the
          panels and post on every save. */}
      {editing && (
        <>
          <input
            type="hidden"
            name="provider_id"
            value={appointment?.provider_id ?? ""}
          />
          <input
            type="hidden"
            name="provider_loaded"
            value={appointment?.provider_name ?? ""}
          />
        </>
      )}

      {/* The scope the chips and the one editor share — the region useFactEditor puts
          focus back inside, and the element that answers Escape (#3311, #3222). */}
      <div ref={factScopeRef} onKeyDown={onFactKeyDown}>
        {!editorOpen && (
          <VisitFactRow
            testId="visit-fact-row"
            summary={summary}
            openEditor={openEditor}
            onOpen={openFact}
          />
        )}

        {/* MOUNTED ALWAYS, hidden when nothing is open — see note 1 in the header. Every
            named input below is in the FormData of every save regardless of which
            editors were opened, and stays visible to the dirty-form registry. */}
        <FactEditorHost
          testId="visit-fact-editor"
          doneTestId="visit-fact-editor-done"
          panel={openEditor}
          className={
            editorOpen
              ? "rounded-lg border border-(--border) bg-surface p-3"
              : "hidden"
          }
          onDone={closeFact}
        >
          <div hidden={openEditor !== "provider"}>
            <label className="label" htmlFor={`appt-provider-${uid}`}>
              Provider
            </label>
            {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
            <ProviderCombobox
              id={`appt-provider-${uid}`}
              name="provider"
              defaultValue={
                appointment?.provider_name ?? prefill?.provider ?? ""
              }
              placeholder="e.g. Example Medical Center, Dr. Smith"
              onChange={pickProvider}
            />
          </div>

          <div hidden={openEditor !== "kind"}>
            <label className="label" htmlFor={`appt-kind-${uid}`}>
              Kind (optional)
            </label>
            {/* Optional visit category (issue #85). A matching kind lets a preventive
                reminder quiet to "Scheduled" and, once completed, offer to mark that
                care done. Blank stays unset and never matches. */}
            <select
              ref={kindRef}
              id={`appt-kind-${uid}`}
              name="kind"
              className="input"
              defaultValue={appointment?.kind ?? prefill?.kind ?? ""}
              onChange={(e) => edited("kind", { kind: e.target.value })}
            >
              <option value="">Unspecified</option>
              {APPOINTMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {APPOINTMENT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>

          <div hidden={openEditor !== "when"}>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor={`appt-date-${uid}`}>
                  Date
                </label>
                <DateField
                  id={`appt-date-${uid}`}
                  name="date"
                  value={currentDate}
                  onChange={setDate}
                />
              </div>
              <div>
                <label className="label" htmlFor={`appt-time-${uid}`}>
                  Time (optional)
                </label>
                {/* Its own column, never folded into the date (#2234): blank stores a
                    bare day rather than a fabricated midnight. */}
                <input
                  id={`appt-time-${uid}`}
                  name="time"
                  type="time"
                  className="input"
                  defaultValue={storedTime}
                  onChange={(e) => edited("when", { time: e.target.value })}
                />
              </div>
            </div>
          </div>

          <div hidden={openEditor !== "reason"}>
            <label className="label" htmlFor={`appt-title-${uid}`}>
              Reason / title
            </label>
            <input
              id={`appt-title-${uid}`}
              name="title"
              className="input"
              defaultValue={appointment?.title ?? prefill?.title ?? ""}
              placeholder="e.g. Annual physical, Dermatology follow-up"
              onChange={(e) => edited("reason", { title: e.target.value })}
            />
          </div>

          <div hidden={openEditor !== "location"}>
            <label className="label" htmlFor={`appt-location-${uid}`}>
              Location (optional)
            </label>
            <input
              ref={locationRef}
              id={`appt-location-${uid}`}
              name="location"
              className="input"
              defaultValue={appointment?.location ?? prefill?.location ?? ""}
              placeholder="e.g. Clinic address, telehealth"
              onChange={(e) => edited("location", { location: e.target.value })}
            />
          </div>

          <div hidden={openEditor !== "notes"}>
            <label className="label" htmlFor={`appt-notes-${uid}`}>
              Notes
            </label>
            <input
              id={`appt-notes-${uid}`}
              name="notes"
              className="input"
              defaultValue={appointment?.notes ?? ""}
              onChange={(e) => edited("notes", { notes: e.target.value })}
            />
          </div>
        </FactEditorHost>
      </div>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="appointment-form-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="appointment-form-primary-action"
        >
          <SubmitButton pendingLabel="Saving…">
            {editing ? "Save" : onDone ? "Schedule" : "Add"}
          </SubmitButton>
        </div>
        {onDone && (
          <button type="button" className="btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
