"use client";

import { useState } from "react";
import type {
  BodyMetricKind,
  FormResult,
  OutcomeGoal,
  OutcomeGoalDirection,
  OutcomeGoalKind,
  OutcomeGoalMetric,
} from "@/lib/types";
import { OUTCOME_GOAL_DIRECTIONS, OUTCOME_GOAL_KINDS } from "@/lib/types";
import type { GoalBiomarkerOption } from "./goal-target-options";
import type { WeightUnit } from "@/lib/settings";
import {
  variantOf,
  composeVariant,
  exerciseHistoryKey,
  isTimed,
} from "@/lib/lifts";
import { kgTo, round } from "@/lib/units";
import { formatSeconds } from "@/lib/duration";
import { BODY_METRIC_LABELS } from "@/lib/outcome-goals";
import { biomarkerSearchTerms } from "@/lib/canonical-name";
import ActivityCombobox from "@/components/ActivityCombobox";
import Combobox from "@/components/Combobox";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { createGoal, updateGoal } from "./goal-actions";

const METRICS: { value: OutcomeGoalMetric; label: string }[] = [
  { value: "weight", label: "Weight" },
  { value: "reps", label: "Reps" },
  { value: "sets", label: "Sets × reps" },
  { value: "hold", label: "Hold time" },
];

// The three metrics the BODY-metric goal path owns, unchanged since it shipped.
// #1853 added biomarker targets ALONGSIDE these, not instead of them: these three
// keep their own column, their own canonical-kg storage and their own daily pacing.
const BODY_METRICS: BodyMetricKind[] = ["weight", "body_fat", "resting_hr"];
const BODY_TARGET_LABEL: Record<BodyMetricKind, string> = {
  weight: "Target bodyweight",
  body_fat: "Target body fat (%)",
  resting_hr: "Target resting HR (bpm)",
};

// Which side of the number the goal wants to be on (#1853). Declared, never inferred:
// "LDL under 100" and "Vitamin D over 100" are different goals with the same number.
const DIRECTION_LABEL: Record<OutcomeGoalDirection, string> = {
  below: "Under",
  above: "Over",
};

const KIND_LABEL: Record<OutcomeGoalKind, string> = {
  exercise: "Exercise goal",
  body: "Body metric",
  biomarker: "Lab or vital",
  freeform: "Freeform",
};

// Create or edit a goal. Pass `editGoal` to pre-fill and submit to updateGoal;
// `onDone` is called after a successful submit (e.g. to close the modal).
export default function GoalForm({
  lifts,
  equipment = [],
  equipmentByExercise = {},
  weightUnit,
  biomarkerOptions = [],
  editGoal,
  onDone,
}: {
  lifts: string[];
  // The profile's equipment registry and, per canonical movement, the implements it
  // has been logged on (#1610). Default to empty so the picker is simply absent for a
  // profile that owns no gear — and for every caller that predates it.
  equipment?: { id: number; name: string }[];
  equipmentByExercise?: Record<string, number[]>;
  weightUnit: WeightUnit;
  // The ranked analyte rows for the lab/vital target picker (#1853), already grouped
  // and label-disambiguated by the shared series-picker options. Defaults to empty so
  // a caller that predates the target keeps rendering the other three kinds.
  biomarkerOptions?: GoalBiomarkerOption[];
  editGoal?: OutcomeGoal;
  onDone?: () => void;
}) {
  const initialKind: OutcomeGoalKind = editGoal?.kind ?? "exercise";
  const [kind, setKind] = useState(initialKind);
  const [exercise, setExercise] = useState(editGoal?.exercise ?? "");
  const [metric, setMetric] = useState<OutcomeGoalMetric>(() => {
    const initialMetric = editGoal?.metric ?? "weight";
    return isTimed(exercise)
      ? "hold"
      : initialMetric === "hold"
        ? "weight"
        : initialMetric;
  });
  const [bodyMetric, setBodyMetric] = useState<BodyMetricKind>(
    editGoal?.body_metric ?? "weight"
  );

  // Pre-filled values for the uncontrolled inputs when editing.
  const wVal =
    editGoal?.target_weight_kg != null
      ? round(kgTo(editGoal.target_weight_kg, weightUnit), 1)
      : "";
  const holdVal =
    editGoal?.target_duration_sec != null
      ? formatSeconds(editGoal.target_duration_sec)
      : "";
  // Body-goal target for a given metric: the stored value only belongs to the
  // metric the goal was SAVED as — weight in the user's unit (canonical kg →
  // display), body fat / resting HR as entered. Switching to any OTHER metric
  // clears the field, so a weight number can never be posted as a bpm target
  // (issue #631). Create mode ("") is unaffected since editGoal is absent.
  const bodyTargetFor = (bm: BodyMetricKind): string => {
    if (editGoal?.body_metric !== bm) return "";
    if (bm === "weight")
      return String(round(kgTo(editGoal.target_value ?? 0, weightUnit), 1));
    return editGoal.target_value != null ? String(editGoal.target_value) : "";
  };
  // Controlled so it recomputes on a metric switch (issue #631) — the unit label
  // already reacts to bodyMetric, so the value must too.
  const [bodyTarget, setBodyTarget] = useState(() =>
    bodyTargetFor(editGoal?.body_metric ?? "weight")
  );

  // ── Lab / vital target (#1853) ────────────────────────────────────────────
  // A Combobox picks by LABEL, and seriesPickerOptions guarantees labels are unique,
  // so the label→name map is total and a pick can never be ambiguous.
  const optionByLabel = new Map(biomarkerOptions.map((o) => [o.label, o]));
  const optionByName = new Map(biomarkerOptions.map((o) => [o.name, o]));
  const [bioLabel, setBioLabel] = useState(() =>
    editGoal?.biomarker_name
      ? (optionByName.get(editGoal.biomarker_name)?.label ??
        editGoal.biomarker_name)
      : ""
  );
  const bioOption = optionByLabel.get(bioLabel) ?? null;
  const [direction, setDirection] = useState<OutcomeGoalDirection>(
    editGoal?.target_direction ?? "below"
  );
  // The stored target belongs to the analyte the goal was SAVED on; switching to a
  // different analyte clears it, so an mg/dL number can never be posted as a
  // mmol/L target (the biomarker analogue of the #631 body-metric fix).
  const [bioTarget, setBioTarget] = useState(() =>
    editGoal?.target_value != null && editGoal.kind === "biomarker"
      ? String(editGoal.target_value)
      : ""
  );
  // The unit the goal was saved with wins while the analyte is unchanged, so an edit
  // shows the number in the unit it was actually captured in.
  const bioUnit =
    editGoal?.biomarker_name && editGoal.biomarker_name === bioOption?.name
      ? (editGoal.unit ?? bioOption?.unit ?? null)
      : (bioOption?.unit ?? null);

  // The thresholds the app already holds for this analyte, stated beside the number
  // the user is about to type — the reference band the biomarker chart draws, for
  // this profile's sex and age. Nothing is prefilled from it: a reference range is
  // context, and picking someone's target for them is a different (clinical) act.
  const referenceHint = (() => {
    if (!bioOption) return null;
    const { low, high, unit } = bioOption;
    const suffix = unit ? ` ${unit}` : "";
    if (low != null && high != null)
      return `Reference range ${low}–${high}${suffix}`;
    if (high != null) return `Reference under ${high}${suffix}`;
    if (low != null) return `Reference over ${low}${suffix}`;
    return null;
  })();

  const timed = isTimed(exercise);
  // Timed lifts can only have a hold target. Apply that invariant in the same
  // interaction that changes the exercise, so the form never renders a mismatched
  // exercise/metric pair and needs no follow-up synchronization render.
  const chooseExercise = (nextExercise: string) => {
    setExercise(nextExercise);
    setMetric((current) =>
      isTimed(nextExercise)
        ? "hold"
        : timed && current === "hold"
          ? "weight"
          : current
    );
  };

  const variant = variantOf(exercise);
  const showEquipment = !!variant && variant.group.equipment.length > 0;

  // ── Load context (#1610) ──────────────────────────────────────────────────
  // The registry implements THIS movement has been logged on. `variantOf` above is
  // the CATALOG axis ("Barbell" vs "Dumbbell" Curl, part of the exercise NAME);
  // this is the INSTANCE axis — two machines that both serialize as the same exact
  // name and whose loads are not comparable. They are different questions and both
  // can apply, which is why they render as separate rows.
  const equipmentName = new Map(equipment.map((e) => [e.id, e.name]));
  const loggedIds = equipmentByExercise[exerciseHistoryKey(exercise)] ?? [];
  // A goal being EDITED keeps its own implement offered even when the movement has
  // since lost every set on it, so opening the form can't silently widen the goal.
  const contextIds = [
    ...new Set(
      [...loggedIds, editGoal?.equipment_id ?? null].filter(
        (id): id is number => id != null && equipmentName.has(id)
      )
    ),
  ];
  const [equipmentId, setEquipmentId] = useState<string>(
    editGoal?.equipment_id != null ? String(editGoal.equipment_id) : ""
  );
  // #1610: when a WEIGHT target has more than one context to choose from, silently
  // taking the maximum across machines is the bug — so the choice is REQUIRED, with
  // "Any machine" available as a deliberate, explicit answer rather than a default.
  // Rep/sets/hold targets and single-context lifts keep the movement-wide default.
  const contextRequired = contextIds.length > 1 && metric === "weight";
  const showLoadContext = contextIds.length > 0;
  // Derived, not stored: switching exercise (or metric) can strand a selection that
  // the new movement never had, and the select must never render a value that is not
  // one of its options. An unstranded pick wins; otherwise "any" (movement-wide),
  // except when a choice is REQUIRED, where the empty placeholder holds the line.
  const selectedContext =
    equipmentId !== "" && contextIds.includes(Number(equipmentId))
      ? equipmentId
      : contextRequired && equipmentId !== "any"
        ? ""
        : "any";

  const submitLabel = editGoal ? "Save changes" : "Create goal";
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  async function submit(fd: FormData) {
    setError(null);
    let result: FormResult;
    try {
      if (editGoal) {
        fd.set("id", String(editGoal.id));
        result = await updateGoal(fd);
      } else {
        result = await createGoal(fd);
      }
    } catch {
      // Keep the modal open with the user's entries intact on failure.
      setError("Couldn't save this goal. Try again.");
      return;
    }
    // A failed validation guard now returns { ok:false } instead of a bare
    // resolve — surface it inline instead of toasting a false success.
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editGoal ? "Goal updated" : "Goal created");
    onDone?.();
  }

  return (
    <form action={submit} className="mt-4 space-y-4">
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <input type="hidden" name="kind" value={kind} />
      {/* Carry the unit the weight target was captured in (issue #630) so the
          action converts with the render-time unit, not the login's pref if it
          changed in another tab mid-edit. */}
      <input type="hidden" name="weight_unit" value={weightUnit} />

      {/* Kind toggle */}
      <div className="flex flex-wrap gap-1.5">
        {OUTCOME_GOAL_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            data-testid={`goal-kind-${k}`}
            onClick={() => setKind(k)}
            className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
              kind === k
                ? "border-brand-500 bg-brand-500 text-white"
                : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
            }`}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {kind === "exercise" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Exercise</label>
            <input type="hidden" name="exercise" value={exercise} />
            <ActivityCombobox
              value={exercise}
              onChange={chooseExercise}
              options={lifts}
              placeholder="e.g. Bench Press, Squat, Plank"
            />
            {showEquipment && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {variant!.group.equipment.map((eq) => {
                  const active = variant!.equipment === eq;
                  return (
                    <button
                      key={eq}
                      type="button"
                      onClick={() =>
                        chooseExercise(composeVariant(variant!.group, eq))
                      }
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                        active
                          ? "border-brand-500 bg-brand-500 text-white"
                          : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
                      }`}
                    >
                      {eq}
                    </button>
                  );
                })}
                {variant!.equipment === null && (
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Pick equipment
                  </span>
                )}
              </div>
            )}
            {showLoadContext && (
              <div className="mt-3" data-testid="goal-load-context">
                <label className="label" htmlFor="goal-equipment">
                  Machine {contextRequired ? "" : "(optional)"}
                </label>
                <select
                  id="goal-equipment"
                  name="equipment_id"
                  className="input"
                  value={selectedContext}
                  onChange={(e) => setEquipmentId(e.target.value)}
                  required={contextRequired}
                >
                  {contextRequired && selectedContext === "" && (
                    <option value="" disabled>
                      Choose a machine…
                    </option>
                  )}
                  <option value="any">Any machine</option>
                  {contextIds.map((id) => (
                    <option key={id} value={String(id)}>
                      {equipmentName.get(id)}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {contextRequired
                    ? "You’ve logged this lift on more than one machine, and their loads aren’t comparable — pick the one this target is for."
                    : "Scope this target to one machine, or leave it across all of them."}
                </p>
              </div>
            )}
          </div>

          <div className="sm:col-span-2">
            <label className="label">Target</label>
            <input type="hidden" name="metric" value={metric} />
            <div className="flex flex-wrap gap-1.5">
              {METRICS.map((m) => {
                const disabled = timed
                  ? m.value !== "hold"
                  : m.value === "hold";
                const active = metric === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    disabled={disabled}
                    onClick={() => setMetric(m.value)}
                    className={`rounded-full border px-3 py-1 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      active
                        ? "border-brand-500 bg-brand-500 text-white"
                        : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Metric-conditional inputs */}
          {metric === "weight" && (
            <>
              <div>
                <label className="label" htmlFor="goal-target-weight">
                  Target weight ({weightUnit})
                </label>
                <input
                  id="goal-target-weight"
                  type="number"
                  step="0.5"
                  name="target_weight"
                  defaultValue={wVal}
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="goal-target-reps">
                  At reps (optional)
                </label>
                <input
                  id="goal-target-reps"
                  type="number"
                  name="target_reps"
                  defaultValue={editGoal?.target_reps ?? ""}
                  className="input"
                />
              </div>
            </>
          )}
          {metric === "reps" && (
            <>
              <div>
                <label className="label" htmlFor="goal-target-reps">
                  Target reps
                </label>
                <input
                  id="goal-target-reps"
                  type="number"
                  name="target_reps"
                  defaultValue={editGoal?.target_reps ?? ""}
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="goal-target-weight">
                  At weight ({weightUnit}, optional)
                </label>
                <input
                  id="goal-target-weight"
                  type="number"
                  step="0.5"
                  name="target_weight"
                  defaultValue={wVal}
                  className="input"
                />
              </div>
            </>
          )}
          {metric === "sets" && (
            <>
              <div>
                <label className="label" htmlFor="goal-target-sets">
                  Sets
                </label>
                <input
                  id="goal-target-sets"
                  type="number"
                  name="target_sets"
                  defaultValue={editGoal?.target_sets ?? ""}
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="goal-target-reps">
                  Reps per set
                </label>
                <input
                  id="goal-target-reps"
                  type="number"
                  name="target_reps"
                  defaultValue={editGoal?.target_reps ?? ""}
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="goal-target-weight">
                  At weight ({weightUnit}, optional)
                </label>
                <input
                  id="goal-target-weight"
                  type="number"
                  step="0.5"
                  name="target_weight"
                  defaultValue={wVal}
                  className="input"
                />
              </div>
            </>
          )}
          {metric === "hold" && (
            <div>
              <label className="label" htmlFor="goal-target-duration">
                Target hold (m:ss)
              </label>
              <input
                id="goal-target-duration"
                type="text"
                inputMode="numeric"
                name="target_duration"
                defaultValue={holdVal}
                placeholder="2:00"
                className="input"
                required
              />
            </div>
          )}

          <div>
            <label className="label" htmlFor="goal-exercise-date">
              Target date (optional)
            </label>
            <DateField
              id="goal-exercise-date"
              name="target_date"
              defaultValue={editGoal?.target_date ?? ""}
              showCountdown
            />
          </div>
          <div className="sm:col-span-2">
            <SubmitButton pendingLabel="Saving…" disabled={!exercise.trim()}>
              {submitLabel}
            </SubmitButton>
          </div>
        </div>
      ) : kind === "body" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Metric</label>
            <input type="hidden" name="body_metric" value={bodyMetric} />
            <div className="flex flex-wrap gap-1.5">
              {BODY_METRICS.map((bm) => {
                const active = bodyMetric === bm;
                return (
                  <button
                    key={bm}
                    type="button"
                    onClick={() => {
                      setBodyMetric(bm);
                      // Recompute the target for the new metric — clears a stale
                      // weight value that would otherwise post as a bpm/% target
                      // (issue #631).
                      setBodyTarget(bodyTargetFor(bm));
                    }}
                    className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
                      active
                        ? "border-brand-500 bg-brand-500 text-white"
                        : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
                    }`}
                  >
                    {BODY_METRIC_LABELS[bm]}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="goal-body-target">
              {bodyMetric === "weight"
                ? `${BODY_TARGET_LABEL.weight} (${weightUnit})`
                : BODY_TARGET_LABEL[bodyMetric]}
            </label>
            <input
              id="goal-body-target"
              type="number"
              step="0.1"
              name="body_target"
              value={bodyTarget}
              onChange={(e) => setBodyTarget(e.target.value)}
              className="input"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="goal-body-date">
              Target date (optional)
            </label>
            <DateField
              id="goal-body-date"
              name="target_date"
              defaultValue={editGoal?.target_date ?? ""}
              showCountdown
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="goal-body-title">
              Title (optional)
            </label>
            <input
              id="goal-body-title"
              name="title"
              defaultValue={editGoal?.title ?? ""}
              className="input"
              placeholder={`${BODY_METRIC_LABELS[bodyMetric]} goal`}
            />
          </div>
          <div className="sm:col-span-2">
            <p className="-mt-1 text-xs text-slate-500 dark:text-slate-400">
              Progress tracks automatically from your latest Body metrics entry.
            </p>
          </div>
          <div className="sm:col-span-2">
            <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
          </div>
        </div>
      ) : kind === "biomarker" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="goal-biomarker">
              Lab or vital
            </label>
            {/* The SAME ranked, group-headed option list every other biomarker
                picker has shown since #1675: due-or-flagged first, then your
                markers, then the whole vocabulary — not a new alphabetical list.
                The name the form posts is resolved from the picked LABEL, which
                seriesPickerOptions guarantees is unique. */}
            <input
              type="hidden"
              name="biomarker_name"
              value={bioOption?.name ?? ""}
            />
            <Combobox
              id="goal-biomarker"
              value={bioLabel}
              onChange={(v) => {
                setBioLabel(v);
                // Switching analyte clears the number: 100 mg/dL is not 100 mmol/L,
                // and a stale value would post against the new analyte's unit.
                if (v !== bioLabel) setBioTarget("");
              }}
              options={biomarkerOptions.map((o) => o.label)}
              groupFor={(label) => optionByLabel.get(label)?.group ?? null}
              // The SAME search keys as every other biomarker picker (#2382): the
              // analyte's own acronym and its curated aliases, so "a1c" and "psa"
              // reach their entries rather than walking a long name's letters.
              searchTermsFor={biomarkerSearchTerms}
              ariaLabel="Lab or vital"
              placeholder="e.g. LDL Cholesterol, Hemoglobin A1c"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="label">Target</label>
            <input type="hidden" name="target_direction" value={direction} />
            <div className="flex flex-wrap gap-1.5">
              {OUTCOME_GOAL_DIRECTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  data-testid={`goal-direction-${d}`}
                  onClick={() => setDirection(d)}
                  className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
                    direction === d
                      ? "border-brand-500 bg-brand-500 text-white"
                      : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
                  }`}
                >
                  {DIRECTION_LABEL[d]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="goal-biomarker-target">
              Target value{bioUnit ? ` (${bioUnit})` : ""}
            </label>
            <input
              id="goal-biomarker-target"
              type="number"
              step="any"
              name="biomarker_target"
              value={bioTarget}
              onChange={(e) => setBioTarget(e.target.value)}
              className="input"
              required
            />
            {referenceHint && (
              <p
                className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                data-testid="goal-biomarker-reference"
              >
                {referenceHint}
              </p>
            )}
          </div>
          <div>
            <label className="label" htmlFor="goal-biomarker-date">
              Target date (optional)
            </label>
            <DateField
              id="goal-biomarker-date"
              name="target_date"
              defaultValue={editGoal?.target_date ?? ""}
              showCountdown
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="goal-biomarker-title">
              Title (optional)
            </label>
            <input
              id="goal-biomarker-title"
              name="title"
              defaultValue={editGoal?.title ?? ""}
              className="input"
              placeholder={
                bioOption
                  ? `${bioOption.name} ${direction === "below" ? "under" : "over"} target`
                  : "Lab goal"
              }
            />
          </div>
          <div className="sm:col-span-2">
            <p className="-mt-1 text-xs text-slate-500 dark:text-slate-400">
              Progress tracks from your results for this marker, and advances
              when a new one arrives — not day by day.
            </p>
          </div>
          <div className="sm:col-span-2">
            <SubmitButton pendingLabel="Saving…" disabled={!bioOption}>
              {submitLabel}
            </SubmitButton>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="goal-ff-title">
              Title
            </label>
            <input
              id="goal-ff-title"
              name="title"
              defaultValue={editGoal?.title ?? ""}
              className="input"
              placeholder="e.g. Run a half marathon"
              required
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="goal-ff-description">
              Description
            </label>
            <textarea
              id="goal-ff-description"
              name="description"
              defaultValue={editGoal?.description ?? ""}
              rows={2}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="goal-ff-category">
              Category
            </label>
            <input
              id="goal-ff-category"
              name="category"
              defaultValue={editGoal?.categoryLabel ?? ""}
              className="input"
              placeholder="weight / habit"
            />
          </div>
          <div>
            <label className="label" htmlFor="goal-ff-date">
              Target date
            </label>
            <DateField
              id="goal-ff-date"
              name="target_date"
              defaultValue={editGoal?.target_date ?? ""}
              showCountdown
            />
          </div>
          <div>
            <label className="label" htmlFor="goal-ff-current">
              Current value
            </label>
            <input
              id="goal-ff-current"
              type="number"
              step="any"
              name="current_value"
              defaultValue={editGoal?.current_value ?? ""}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="goal-ff-target">
              Target value
            </label>
            <input
              id="goal-ff-target"
              type="number"
              step="any"
              name="target_value"
              defaultValue={editGoal?.target_value ?? ""}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="goal-ff-unit">
              Unit
            </label>
            <input
              id="goal-ff-unit"
              name="unit"
              defaultValue={editGoal?.unit ?? ""}
              className="input"
              placeholder="kg / reps / km"
            />
          </div>
          <div className="sm:col-span-2">
            <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
          </div>
        </div>
      )}
    </form>
  );
}
