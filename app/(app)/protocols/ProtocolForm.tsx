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

export type ProtocolFormResult =
  | { ok: true; redirectTo?: `/protocols/${number}` }
  | { ok: false; error: string };

// One geometry for both creation and edit. Wide enough for the outcome picker,
// but deliberately below the app shell's largest work-surface modal.
export const PROTOCOL_MODAL_CLASS =
  "flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white p-4 shadow-xl outline-none sm:max-h-[calc(100dvh-4rem)] sm:p-6 dark:bg-ink-900";

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
  const [practiceSelection, setPracticeSelection] = useState(
    initialPractice.selection
  );
  const [practiceCustom, setPracticeCustom] = useState(initialPractice.custom);
  const [intakeItemId, setIntakeItemId] = useState(
    protocol?.intake_item_id == null ? "" : String(protocol.intake_item_id)
  );
  const activeTemplate = editing ? null : protocolTemplateById(templateId);
  const activeIntake = intakeItems.find(
    (item) => String(item.id) === intakeItemId
  );
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

  function selectTemplate(id: string) {
    const next = protocolTemplateById(id);
    const available = new Set(options.map((option) => option.key));
    setTemplateId(id);
    setSelectedKeys(
      (next?.outcomeKeys ?? []).filter((key) => available.has(key))
    );
    const defaults = practiceDefaults(null, next);
    setPracticeSelection(defaults.selection);
    setPracticeCustom(defaults.custom);
    setIntakeItemId("");
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
      formRef.current?.reset();
      selectTemplate("");
    }
    onDone?.();
    router.refresh();
  }

  const uid = protocol?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      className="-mx-4 -mb-4 mt-4 flex min-h-0 flex-1 flex-col sm:-mx-6 sm:-mb-6"
      data-testid="protocol-form"
    >
      {editing && <input type="hidden" name="id" value={protocol!.id} />}
      <div
        key={editing ? "editing" : templateId || "blank"}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-5 sm:px-6"
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
                onChange={(event) => selectTemplate(event.target.value)}
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
          description="Name the protocol and choose when it starts and ends."
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`pr-start-${uid}`}>
                Start date
              </label>
              <DateField
                id={`pr-start-${uid}`}
                name="start_date"
                defaultValue={protocol?.start_date ?? ""}
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
                defaultValue={protocol?.end_date ?? ""}
              />
            </div>
          </div>
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

        <ProtocolFormSection
          title="What you're testing"
          description="Optionally link the situation, item, or equipment this protocol is about."
        >
          <div>
            <label className="label" htmlFor={`pr-situation-${uid}`}>
              Situation <span className="text-slate-400">(optional)</span>
            </label>
            <input
              id={`pr-situation-${uid}`}
              name="situation"
              className="input"
              defaultValue={
                protocol?.situation ?? activeTemplate?.situation ?? ""
              }
              placeholder="e.g. Creatine loading"
            />
          </div>
          {(equipment.length > 0 || intakeItems.length > 0) && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {equipment.length > 0 && (
                <div>
                  <label className="label" htmlFor={`pr-equipment-${uid}`}>
                    Recovery gear{" "}
                    <span className="text-slate-400">(optional)</span>
                  </label>
                  <select
                    id={`pr-equipment-${uid}`}
                    name="equipment_id"
                    className="input"
                    defaultValue={protocol?.equipment_id ?? ""}
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
              )}
              {intakeItems.length > 0 && (
                <div>
                  <label className="label" htmlFor={`pr-intake-${uid}`}>
                    Supplement or medication{" "}
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
              )}
            </div>
          )}
        </ProtocolFormSection>

        <ProtocolFormSection
          title="Weekly practice"
          description="Choose a practice, activity, or food habit to repeat during this protocol."
        >
          <div>
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
                {PRACTICE_STARTER_LIST.map((name) => (
                  <option
                    key={name}
                    value={practiceSelectValue("practice", name)}
                  >
                    {name}
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
          </div>
          {practiceSelection && (
            <>
              {practiceSelection === CUSTOM_PRACTICE_VALUE && (
                <div>
                  <label
                    className="label"
                    htmlFor={`pr-practice-custom-${uid}`}
                  >
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
              )}
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
                    placeholder="3"
                    data-testid="protocol-practice-per-week"
                  />
                </div>
                <div>
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
                    placeholder="5"
                    data-testid="protocol-practice-per-week-max"
                  />
                </div>
              </div>
              <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                This adds weekly progress and a quick-log action to the protocol
                page.
              </p>
            </>
          )}
        </ProtocolFormSection>

        <ProtocolFormSection
          title="Notes"
          description="Record the dose, routine, or other context you will need later."
        >
          <div>
            <label className="sr-only" htmlFor={`pr-notes-${uid}`}>
              Notes
            </label>
            <textarea
              id={`pr-notes-${uid}`}
              name="notes"
              className="input"
              rows={4}
              defaultValue={protocol?.notes ?? activeTemplate?.notes ?? ""}
              placeholder="What are you changing, and what will stay constant?"
            />
          </div>
        </ProtocolFormSection>

        {error && (
          <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        )}
      </div>
      <div
        className="flex shrink-0 flex-col-reverse gap-2 border-t border-black/5 bg-white px-4 py-3 sm:flex-row sm:justify-end sm:px-6 dark:border-white/10 dark:bg-ink-900"
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
        <SubmitButton
          className="btn w-full sm:w-auto sm:min-w-24"
          pendingLabel="Saving…"
        >
          {editing ? "Save" : "Create protocol"}
        </SubmitButton>
      </div>
    </form>
  );
}
