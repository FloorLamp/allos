"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import ProtocolOutcomePicker from "./ProtocolOutcomePicker";
import type { Protocol, Equipment } from "@/lib/types";
import type {
  OutcomeOption,
  ProtocolPractice,
  IntakeItemOption,
} from "@/lib/queries/protocols";
import {
  PRACTICE_TYPES,
  practiceSelectValue,
  scopeAcceptsPerWeekMax,
  CUSTOM_PRACTICE_VALUE,
} from "@/lib/protocol-practice";
import { PRACTICE_STARTER_LIST } from "@/lib/practice";
import { FOOD_GROUPS } from "@/lib/food-groups";
import {
  PROTOCOL_TEMPLATES,
  protocolTemplateById,
  type ProtocolTemplate,
} from "@/lib/protocol-templates";
import { protocolRelevantPanels } from "@/lib/protocol-outcome-picker";
import DraftRestoreBanner from "@/components/DraftRestoreBanner";
import { useFormDraft } from "@/components/useFormDraft";
import Combobox from "@/components/Combobox";
import { useSituationOptions } from "@/components/SituationOptionsContext";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import ProtocolFactRow, {
  type ProtocolOpenPanel,
} from "@/components/protocols/ProtocolFactRow";
import { PROTOCOL_FACT_NOUNS, protocolFactSummary } from "@/lib/protocol-facts";
import InlineError from "@/components/InlineError";

export type ProtocolFormResult =
  | { ok: true; redirectTo?: `/protocols/${number}` }
  | { ok: false; error: string };

// The protocol's "Activate situation" field. Same vocabulary, same widget, same
// context as the situation picker on the supplement and medication forms (#1676):
// they name the same thing, and the #221 rule says they read one options source.
//
// CONTROLLED BY THE FORM since #3219: its value is one of the facts the chip row
// states, so the form has to know it. It used to own the value itself and rely on the
// template-seed remount to reset it — a remount this form no longer has (see
// `resetToTemplate`).
function SituationField({
  uid,
  value,
  onChange,
}: {
  uid: string | number;
  value: string;
  onChange: (next: string) => void;
}) {
  const options = useSituationOptions();
  return (
    <Combobox
      id={`pr-situation-${uid}`}
      name="situation"
      ariaLabel="Situation"
      value={value}
      onChange={onChange}
      options={options}
      allowFreeText
      closeStopsPropagation
      placeholder="e.g. Creatine loading"
    />
  );
}

const PRACTICE_TYPE_LABELS: Record<string, string> = {
  strength: "Strength",
  cardio: "Cardio",
  sport: "Sport",
};

function ProtocolFormSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 border-b border-black/5 pb-5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6 dark:border-white/10">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h3>
        <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
          {description}
        </p>
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}

function practiceDefaults(
  practice: ProtocolPractice | null,
  template: ProtocolTemplate | null
): { selection: string; custom: string } {
  const isCurated =
    practice?.scopeKind === "practice" &&
    (PRACTICE_STARTER_LIST as readonly string[]).includes(practice.value);
  return {
    selection: practice
      ? practice.scopeKind === "practice" && !isCurated
        ? CUSTOM_PRACTICE_VALUE
        : practiceSelectValue(practice.scopeKind, practice.value)
      : (template?.practiceType ?? ""),
    custom:
      practice?.scopeKind === "practice" && !isCurated ? practice.value : "",
  };
}

/** The number a numeric field holds, or null when it is blank or out of range. */
function positiveInt(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

/**
 * The practice the row should state, or null when there is not one yet.
 *
 * Mirrors `parseScopedPractice`'s own verdict rather than the select's raw value: the
 * custom sentinel with no name typed writes NO practice, so the row must not claim one.
 */
function practiceScope(
  selection: string,
  custom: string
): { scopeKind: "type" | "food_group" | "practice"; value: string } | null {
  if (!selection) return null;
  if (selection === CUSTOM_PRACTICE_VALUE) {
    const trimmed = custom.trim();
    return trimmed ? { scopeKind: "practice", value: trimmed } : null;
  }
  if (selection.startsWith("food_group:"))
    return {
      scopeKind: "food_group",
      value: selection.slice("food_group:".length),
    };
  if (selection.startsWith("practice:"))
    return {
      scopeKind: "practice",
      value: selection.slice("practice:".length),
    };
  return { scopeKind: "type", value: selection };
}

// Shared add/edit protocol form. Add mode: no `protocol`. Edit mode: pass the row
// (renders a hidden id + Cancel). `options` is the outcome-metric picker (fixed
// body/index metrics + the profile's tracked and derived biomarkers).
// `equipment` powers the optional recovery-gear reference; `practice` seeds the
// optional adherence practice (activity type × N/week) in edit mode (issue #344).
export interface ProtocolFormProps {
  action: (formData: FormData) => Promise<ProtocolFormResult>;
  options: OutcomeOption[];
  equipment: Equipment[];
  // The profile's supplements + medications, for the direct intervention link
  // (issue #660 — the creatine case).
  intakeItems: IntakeItemOption[];
  protocol?: Protocol;
  practice?: ProtocolPractice | null;
  // A starter template (issue #571) whose defaults seed the ADD form (name, notes,
  // outcome keys, situation, practice). Ignored in edit mode. The user edits
  // everything before saving — a template never creates a protocol on its own.
  template?: ProtocolTemplate | null;
  onDone?: () => void;
}

export default function ProtocolForm({
  action,
  options,
  equipment,
  intakeItems,
  protocol,
  practice = null,
  template = null,
  onDone,
}: ProtocolFormProps) {
  const router = useRouter();
  const toast = useToast();
  const formatPrefs = useFormatPrefs();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!protocol;
  const initialTemplate = editing ? null : template;
  const initialPractice = practiceDefaults(practice, initialTemplate);
  const [error, setError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState(initialTemplate?.id ?? "");
  const [selectedKeys, setSelectedKeys] = useState(() => {
    const available = new Set(options.map((option) => option.key));
    return (protocol?.outcomeKeys ?? initialTemplate?.outcomeKeys ?? []).filter(
      (key) => available.has(key)
    );
  });

  // THE ROW NEEDS EVERY VALUE AS IT CHANGES, because it states what Save will write
  // and a chip reading a stale default is worse than no chip at all. But WHO OWNS the
  // value is a separate question from who reads it, and the answer here is: the DOM
  // still does, for every plain field.
  //
  // A CONTROLLED FIELD USED TO BE INVISIBLE TO THE DIRTY-FORM REGISTRY, which cost
  // #3219 a round to find and is fixed in the registry itself now (#3352). Kept here
  // because the reasoning still decides how this form is written, and because a
  // reader who meets `onChange` mirroring into state will otherwise ask why.
  //
  // WHAT IT WAS. `fieldHoldsUnsavedInput` ends at `current !== serverValue`, and
  // `serverValue` was the DOM `defaultValue` — which React KEEPS IN SYNC with
  // `value` on a controlled input. So a controlled field reported
  // current === serverValue forever, the registry read that as "saved, not pending",
  // and ModalShell's "Discard your changes?" guard never fired. Measured in the
  // browser, not reasoned about: with `value={notes}` the textarea reported `value`
  // and `defaultValue` both equal to the typed text while `isConnected` was true —
  // mounted exactly as intended, and still invisible.
  //
  // WHAT IT IS NOW. The registry snapshots each field's DOM default at registration
  // and stops trusting the LIVE default once it has moved onto exactly what the user
  // typed — which only React mirroring a controlled `value` does — so
  // CONVERTING ANY FIELD BELOW TO CONTROLLED STATE NO LONGER DISARMS ITS GUARD. That
  // tidy-up is safe; it is simply not needed. These five stay DOM-owned because that
  // is the cheaper shape — `defaultValue` seeds them, the DOM holds the value, and
  // `onChange` mirrors into state that only the chips read — and because keeping one
  // genuinely DOM-owned field in this form is what lets e2e/protocol-facts.spec.ts
  // measure both ownerships against the same guard.
  //
  // THE TWO OTHER FIELD KINDS IN THIS FORM ARE NOT THE SAME AS EACH OTHER, and the
  // difference is the one that decides all of this:
  //   * a Combobox's named input is VISIBLE and React-controlled, so it is tracked —
  //     and before #3352 it was tracked-but-permanently-clean;
  //   * a DateField's named input is `type="hidden"`, which the registry excludes
  //     outright (NON_INPUT_TYPES), so it is not tracked at all and #3352 does not
  //     reach it.
  const [practiceSelection, setPracticeSelection] = useState(
    initialPractice.selection
  );
  const [practiceCustom, setPracticeCustom] = useState(initialPractice.custom);
  const [perWeek, setPerWeek] = useState(
    String(practice?.perWeek ?? initialTemplate?.practicePerWeek ?? "")
  );
  const [perWeekMax, setPerWeekMax] = useState(
    String(practice?.perWeekMax ?? "")
  );
  const [startDate, setStartDate] = useState(protocol?.start_date ?? "");
  const [endDate, setEndDate] = useState(protocol?.end_date ?? "");
  const [equipmentId, setEquipmentId] = useState(
    protocol?.equipment_id == null ? "" : String(protocol.equipment_id)
  );
  const [intakeItemId, setIntakeItemId] = useState(
    protocol?.intake_item_id == null ? "" : String(protocol.intake_item_id)
  );
  const [situation, setSituation] = useState(
    protocol?.situation ?? initialTemplate?.situation ?? ""
  );
  const [notes, setNotes] = useState(
    protocol?.notes ?? initialTemplate?.notes ?? ""
  );

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<ProtocolOpenPanel>({ scopeRef: formRef });

  const activeTemplate = editing ? null : protocolTemplateById(templateId);
  const activeIntake = intakeItems.find(
    (item) => String(item.id) === intakeItemId
  );
  const activeEquipment = equipment.find((e) => String(e.id) === equipmentId);
  const relevantPanels = useMemo(
    () =>
      protocolRelevantPanels({
        templateOutcomeKeys: activeTemplate?.outcomeKeys,
        practice: `${practiceSelection} ${practiceCustom}`,
        intakeItemName: activeIntake?.name,
      }),
    [
      activeIntake?.name,
      activeTemplate?.outcomeKeys,
      practiceCustom,
      practiceSelection,
    ]
  );

  // WHAT THE ROW STATES IS WHAT THE ACTION WILL PARSE, derived the same way
  // `parseScopedPractice` derives it: a custom practice with no name typed is not a
  // practice, and a cadence of nothing is not a cadence. So a chip never claims a
  // value the write would discard.
  const summary = protocolFactSummary(
    {
      practice: practiceScope(practiceSelection, practiceCustom),
      perWeek: positiveInt(perWeek),
      // …including the ceiling, which the parse keeps for a wellness practice and
      // drops everywhere else (#3353). Without the scope question the live chip read
      // "3–5×/week" over a sport protocol that was about to store "3×/week" — the
      // same silent discard as the field above, one line further along.
      perWeekMax: scopeAcceptsPerWeekMax(practiceSelection)
        ? positiveInt(perWeekMax)
        : null,
      startDate,
      endDate,
      intakeItemName: activeIntake?.name ?? null,
      equipmentName: activeEquipment?.name ?? null,
      situation,
      notes,
    },
    formatPrefs
  );

  // Local draft (#1699): every fact still rides as a NAMED FIELD in the form, because
  // the closed editors stay mounted — so the draft keeps collecting them exactly as it
  // did. The pickers with no field of their own remain `extra`.
  const draftExtra = useMemo(
    () => ({ templateId, selectedKeys }),
    [templateId, selectedKeys]
  );
  type ProtocolDraft = typeof draftExtra;
  const draft = useFormDraft<ProtocolDraft>({
    formKey: "protocol",
    recordId: protocol?.id ?? null,
    formRef,
    extra: draftExtra,
    onRestore: (d) => {
      setTemplateId(d.templateId);
      setSelectedKeys(d.selectedKeys);
    },
  });

  // Seeding a template remounts the field block (the `key` below), which re-applies
  // every `defaultValue`; this resets the MIRRORS and the controlled pickers to match,
  // so the chips state the seeded protocol rather than the previous one.
  function resetToTemplate(id: string) {
    const next = protocolTemplateById(id);
    const available = new Set(options.map((option) => option.key));
    const defaults = practiceDefaults(null, next);
    setTemplateId(id);
    setSelectedKeys(
      (next?.outcomeKeys ?? []).filter((key) => available.has(key))
    );
    setPracticeSelection(defaults.selection);
    setPracticeCustom(defaults.custom);
    setPerWeek(String(next?.practicePerWeek ?? ""));
    setPerWeekMax("");
    setStartDate("");
    setEndDate("");
    setEquipmentId("");
    setIntakeItemId("");
    setSituation(next?.situation ?? "");
    setNotes(next?.notes ?? "");
    closePanel();
    setError(null);
  }

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("name") ?? "").trim()) {
      setError("Name your protocol.");
      return;
    }
    let result: ProtocolFormResult;
    try {
      result = await action(formData);
    } catch (e) {
      setError("Couldn't save this protocol. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Written — the draft must not survive to re-offer it (#1699).
    draft.clear();
    toast(editing ? "Protocol updated" : "Protocol created");
    if (!editing && result.redirectTo) {
      // Navigate from the client after the action resolves. A server-side
      // redirect is represented as a thrown NEXT_REDIRECT sentinel; proxy and
      // production transport failures can turn that successful write into the
      // form's generic catch state. An explicit destination keeps create a
      // normal typed success response.
      router.push(result.redirectTo);
      return;
    }
    if (!editing) {
      // The uncontrolled fields go back to their defaults the way they always did;
      // `resetToTemplate` takes the mirrors and the pickers with them.
      formRef.current?.reset();
      resetToTemplate("");
    }
    onDone?.();
  }

  const uid = protocol?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      // FULL-BLEED FROM `md`, WHICH IS EXACTLY WHERE THE HOST LETS A BLEED PAINT
      // (#4534). Both mounts are ModalShell, whose panel pads `px-4` and steps to
      // `px-6` at `md` (components/BottomSheet.tsx, `presentation="dialog"`) — so
      // the bleed and every re-inset below step at `md` and not at `sm`, or they
      // over-pull half a rem per side through the whole sm..md band and the
      // footer's edge sits past the panel's (#3361).
      //
      // BELOW `md` THERE IS NO BLEED AT ALL, because the sheet's content region
      // declares `overflow-x-hidden` there on purpose (#3360: a bleed handed that
      // region real horizontal overflow and one thumb drag parked the whole sheet
      // sideways). A base `-mx-4` therefore bought nothing and cost the truth: the
      // form's box ran the full 390px while only the panel's 358 were ever
      // painted, so the actions bar's border stopped 16px short of each edge while
      // the markup claimed it spanned them. From `md` up the same region is
      // `md:overflow-visible`, so there the bleed is real and the border does span
      // the panel. The vertical pull stays at both sizes — `overflow-y` scrolls
      // rather than clips, so it was never the dead half. The old `mt-4` is gone
      // too: the host's content region already gives the title gap (#3361).
      className="-mb-4 flex min-h-0 flex-1 flex-col md:-mx-6 md:-mb-6"
      data-testid="protocol-form"
    >
      {editing && <input type="hidden" name="id" value={protocol!.id} />}
      <DraftRestoreBanner draft={draft} noun="protocol" className="md:mx-6" />
      {/* THE TEMPLATE-SEED REMOUNT STAYS (#571), and #3219 needs it more than
          before. The five plain fields below are uncontrolled on purpose — see the
          state block — so a new template's `defaultValue` only lands when they
          remount. `resetToTemplate` resets the mirrors in the same gesture, which is
          what keeps the chips and the DOM saying the same thing. */}
      <div
        key={editing ? "editing" : templateId || "blank"}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-5 md:px-6"
        data-testid="protocol-form-scroll"
      >
        {!editing && (
          <ProtocolFormSection
            title="Starting point"
            description="Use a template or begin with a blank protocol."
          >
            <div>
              <label className="label" htmlFor="protocol-template">
                Template <span className="text-slate-400">(optional)</span>
              </label>
              <select
                id="protocol-template"
                className="input"
                value={templateId}
                onChange={(event) => resetToTemplate(event.target.value)}
                data-testid="protocol-template-picker"
              >
                <option value="">Blank protocol</option>
                {PROTOCOL_TEMPLATES.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </select>
              {activeTemplate && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {activeTemplate.blurb}
                </p>
              )}
            </div>
          </ProtocolFormSection>
        )}

        <ProtocolFormSection
          title="Details"
          description="Name it, then tap any fact to change it."
        >
          <div>
            <label className="label" htmlFor={`pr-name-${uid}`}>
              Name
            </label>
            <input
              id={`pr-name-${uid}`}
              name="name"
              className="input"
              defaultValue={protocol?.name ?? activeTemplate?.name ?? ""}
              placeholder="e.g. Creatine 5 g/day, Sauna 4×/week"
              required
            />
          </div>

          {/* THE SENTENCE, and the one open editor behind it (#3218/#3219). At most
              one editor is on screen: the row is unmounted while a panel is open, and
              the host is display:none while none is. */}
          {openEditor == null && (
            <ProtocolFactRow
              summary={summary}
              openEditor={openEditor}
              onOpen={(key, focusKey) => openPanel(key, focusKey)}
            />
          )}
          <FactEditorHost
            testId="protocol-editor"
            doneTestId="protocol-editor-done"
            panel={openEditor}
            onDone={closePanel}
            bodyClassName="space-y-3"
            // HIDDEN RATHER THAN UNMOUNTED, and this is the write-path decision of
            // #3219 rather than a styling choice.
            //
            // This form is DOM-COLLECTED: `<form action={handle}>` hands the action
            // whatever FormData the browser gathers from the inputs mounted AT
            // SUBMIT. A field that unmounts when its panel closes is therefore a
            // field the form CLEARS (#2359) — someone edits a fact behind a chip,
            // taps Done, saves, and the value is gone with nothing on screen to say
            // so.
            //
            // It is also invisible to the dirty-form registry, which skips any field
            // where `!field.isConnected` (components/DirtyFormRegistry.tsx): dismiss
            // the dialog and the "Discard your changes?" prompt never appears,
            // because as far as the registry can tell nothing was ever typed.
            //
            // Neither hazard reached the two consumers that shipped before this one.
            // The intake form and the sleep dialog both build their FormData from
            // state by hand, so unmounting a closed panel costs them nothing. This
            // form does not, so it takes the primitive's other documented reading —
            // "the editor is HIDDEN, not unmounted, so the value still posts with the
            // form (#2014)" (components/facts/FactEditorHost.tsx). Every named input
            // below is mounted at all times, whichever panel is open.
            className={openEditor == null ? "hidden" : undefined}
          >
            <div hidden={openEditor !== "practice"}>
              <label className="label" htmlFor={`pr-practice-type-${uid}`}>
                Practice or habit
              </label>
              <select
                id={`pr-practice-type-${uid}`}
                name="practice_type"
                className="input"
                value={practiceSelection}
                onChange={(event) => setPracticeSelection(event.target.value)}
                data-testid="protocol-practice-type"
              >
                <option value="">Don&apos;t track one</option>
                <optgroup label="Wellness practice">
                  {PRACTICE_STARTER_LIST.map((practiceName) => (
                    <option
                      key={practiceName}
                      value={practiceSelectValue("practice", practiceName)}
                    >
                      {practiceName}
                    </option>
                  ))}
                  <option value={CUSTOM_PRACTICE_VALUE}>
                    Other practice (custom)…
                  </option>
                </optgroup>
                <optgroup label="Activity">
                  {PRACTICE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {PRACTICE_TYPE_LABELS[t] ?? t}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Food habit">
                  {FOOD_GROUPS.map((g) => (
                    <option
                      key={g.slug}
                      value={practiceSelectValue("food_group", g.slug)}
                    >
                      {g.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              {/* The custom name stays MOUNTED whatever the select holds, for the
                  same reason every other field does: switching away and back must not
                  silently blank a name the person already typed. */}
              <div
                className="mt-3"
                hidden={practiceSelection !== CUSTOM_PRACTICE_VALUE}
              >
                <label className="label" htmlFor={`pr-practice-custom-${uid}`}>
                  Custom practice
                </label>
                <input
                  id={`pr-practice-custom-${uid}`}
                  type="text"
                  name="practice_custom"
                  className="input"
                  value={practiceCustom}
                  onChange={(event) => setPracticeCustom(event.target.value)}
                  placeholder="e.g. Grounding walk"
                  data-testid="protocol-practice-custom"
                />
              </div>
            </div>

            <div hidden={openEditor !== "cadence"}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor={`pr-practice-min-${uid}`}>
                    Weekly minimum
                  </label>
                  <input
                    id={`pr-practice-min-${uid}`}
                    type="number"
                    name="practice_per_week"
                    min={1}
                    max={14}
                    className="input"
                    defaultValue={
                      practice?.perWeek ?? activeTemplate?.practicePerWeek ?? ""
                    }
                    onChange={(event) => setPerWeek(event.target.value)}
                    placeholder="3"
                    data-testid="protocol-practice-per-week"
                  />
                </div>
                {/* A WEEKLY RANGE IS A WELLNESS-PRACTICE CONCEPT (#3353), and
                    `parseScopedPractice` drops the maximum for every other scope. The
                    field used to be offered anyway, so a sport protocol accepted a
                    number that silently did not exist — discoverable only by noticing
                    the cadence chip say "2×/week" and reading it as the chip being
                    wrong. `scopeAcceptsPerWeekMax` is the storage rule's own
                    predicate, so the two cannot drift.

                    HIDDEN, NOT UNMOUNTED, which is this form's convention (see the
                    custom-name field above) and here also the answer to "what happens
                    to a maximum already typed": it is KEPT. Switching to a sport and
                    back must not blank a number a person typed, and while it is
                    hidden the value posts to a parse that discards it — so nothing
                    is stored under a scope that has no ceiling either way. The
                    minimum keeps its own column at both states, so nothing shifts
                    under the pointer as the scope changes. */}
                <div hidden={!scopeAcceptsPerWeekMax(practiceSelection)}>
                  <label className="label" htmlFor={`pr-practice-max-${uid}`}>
                    Maximum <span className="text-slate-400">(optional)</span>
                  </label>
                  <input
                    id={`pr-practice-max-${uid}`}
                    type="number"
                    name="practice_per_week_max"
                    min={1}
                    max={14}
                    className="input"
                    defaultValue={practice?.perWeekMax ?? ""}
                    onChange={(event) => setPerWeekMax(event.target.value)}
                    placeholder="5"
                    data-testid="protocol-practice-per-week-max"
                  />
                </div>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                This adds weekly progress and a quick-log action to the protocol
                page.
              </p>
            </div>

            <div hidden={openEditor !== "window"}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor={`pr-start-${uid}`}>
                    Start date
                  </label>
                  <DateField
                    id={`pr-start-${uid}`}
                    name="start_date"
                    value={startDate}
                    onChange={setStartDate}
                  />
                </div>
                <div>
                  <label className="label" htmlFor={`pr-end-${uid}`}>
                    End date{" "}
                    <span className="text-slate-400">(blank = ongoing)</span>
                  </label>
                  <DateField
                    id={`pr-end-${uid}`}
                    name="end_date"
                    value={endDate}
                    onChange={setEndDate}
                  />
                </div>
              </div>
            </div>

            <div hidden={openEditor !== "link"}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div hidden={equipment.length === 0}>
                  <label className="label" htmlFor={`pr-equipment-${uid}`}>
                    Recovery gear{" "}
                    <span className="text-slate-400">(optional)</span>
                  </label>
                  <select
                    id={`pr-equipment-${uid}`}
                    name="equipment_id"
                    className="input"
                    defaultValue={protocol?.equipment_id ?? ""}
                    onChange={(event) => setEquipmentId(event.target.value)}
                    data-testid="protocol-equipment"
                  >
                    <option value="">None</option>
                    {equipment.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                        {e.retired ? " (retired)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div hidden={intakeItems.length === 0}>
                  <label className="label" htmlFor={`pr-intake-${uid}`}>
                    IntakeItem or medication{" "}
                    <span className="text-slate-400">(optional)</span>
                  </label>
                  <select
                    id={`pr-intake-${uid}`}
                    name="intake_item_id"
                    className="input"
                    value={intakeItemId}
                    onChange={(event) => setIntakeItemId(event.target.value)}
                    data-testid="protocol-intake-item"
                  >
                    <option value="">None</option>
                    {intakeItems.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}
                        {it.kind === "medication" ? " (medication)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div hidden={openEditor !== "situation"}>
              <label className="label" htmlFor={`pr-situation-${uid}`}>
                Situation <span className="text-slate-400">(optional)</span>
              </label>
              <SituationField
                uid={uid}
                value={situation}
                onChange={setSituation}
              />
            </div>

            <div hidden={openEditor !== "notes"}>
              <label className="sr-only" htmlFor={`pr-notes-${uid}`}>
                Notes
              </label>
              <textarea
                id={`pr-notes-${uid}`}
                name="notes"
                className="input"
                rows={4}
                defaultValue={protocol?.notes ?? activeTemplate?.notes ?? ""}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="What are you changing, and what will stay constant?"
              />
            </div>

            {/* The trailing affordance's panel is a MENU, not an editor: it names the
                optional facts with nothing to state and hands off to one of them, so
                opening it still leaves exactly one editor on screen. */}
            <div hidden={openEditor !== "more"}>
              <div className="flex flex-wrap gap-1.5">
                {summary.more.map((key) => (
                  <button
                    key={key}
                    type="button"
                    data-testid={`protocol-more-${key}`}
                    onClick={() => openPanel(key)}
                    className="min-h-11 rounded-full border border-(--border) px-3 py-1.5 text-sm transition hover:bg-(--ghost-hover)"
                  >
                    {PROTOCOL_FACT_NOUNS[key]}
                  </button>
                ))}
              </div>
            </div>
          </FactEditorHost>
        </ProtocolFormSection>

        <ProtocolFormSection
          title="Outcomes"
          description="Choose the measurements that will show whether it worked."
        >
          <ProtocolOutcomePicker
            options={options}
            selectedKeys={selectedKeys}
            onChange={setSelectedKeys}
            relevantPanels={relevantPanels}
          />
        </ProtocolFormSection>

        <InlineError>{error}</InlineError>
      </div>
      <div
        className="flex shrink-0 flex-col-reverse gap-2 border-t border-(--border) bg-surface py-3 sm:flex-row sm:justify-end md:px-6"
        data-testid="protocol-form-actions"
      >
        {onDone && (
          <button
            type="button"
            className="btn-ghost w-full sm:w-auto"
            onClick={onDone}
          >
            Cancel
          </button>
        )}
        <div
          className="grid w-full sm:w-auto sm:min-w-24"
          data-testid="protocol-form-primary-action"
        >
          <SubmitButton pendingLabel="Saving…" variant="primary">
            {editing ? "Save" : "Create protocol"}
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}
