"use client";

import { useMemo, useRef, useState } from "react";
import type {
  BodyMetricKind,
  FormResult,
  OutcomeGoal,
  OutcomeGoalDirection,
  OutcomeGoalKind,
  OutcomeGoalMetric,
} from "@/lib/types";
import { OUTCOME_GOAL_DIRECTIONS } from "@/lib/types";
import type { GoalBiomarkerOption } from "./goal-target-options";
import type { WeightUnit } from "@/lib/settings";
import type { ExerciseBest } from "@/lib/queries";
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
import { displayUnit, storedLabUnit } from "@/lib/display-unit";
import ActivityCombobox from "@/components/ActivityCombobox";
import Chip from "@/components/Chip";
import FilterPills from "@/components/FilterPills";
import Combobox from "@/components/Combobox";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import GoalFactRow, {
  type GoalOpenPanel,
} from "@/components/training/GoalFactRow";
import {
  GOAL_FACT_NOUNS,
  firstGoalProblem,
  goalFactSummary,
  goalStartingFrom,
} from "@/lib/goal-facts";
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

// Create or edit a goal (#3220), in the shared facts-with-editors grammar (#3218).
//
// WHAT REPLACED WHAT. This form used to render a kind toggle and then, beneath it,
// the whole field wall of whichever of four branches that toggle selected — 30 named
// inputs of which a given goal uses six. It now opens on the SUBJECT PICK, states the
// goal as a sentence of chips, and shows exactly one editor at a time behind them.
// `createGoal`/`updateGoal` receive the FormData they received before, field for
// field; `GoalsManager`'s mount is unchanged.
//
// THE KIND IS DERIVED FROM THE SUBJECT, and stated back rather than inferred
// silently: picking "Bench Press" makes this a strength goal, picking "Body fat" a
// body goal, picking "LDL Cholesterol" a lab goal — and the kind chip says so,
// MARKED AS A SUGGESTION (#3216/#846), with the four-kind row one tap away inside the
// same editor. A person opening this form knows what they want to track; which of
// four storage shapes the app keeps it in is not their question.
//
// THE ONE SUBJECT PICKER KEEPS THE BIOMARKER GROUP HEADERS. Merging three
// vocabularies into one list must not cost the analytes the ranked, group-headed
// order every biomarker picker has shown since #1675 — so a biomarker row carries the
// header the RANKER gave it ("Due or flagged" → "Your markers" → "All biomarkers")
// and the two training vocabularies simply precede them. See `goalSubjectOptions`.
//
// WHO OWNS EACH FIELD'S VALUE, which is the decision this conversion turns on.
//
// The chips must read every value as it changes, because a chip stating a stale
// default is worse than no chip. But WHO OWNS the value is a separate question from
// who reads it, and the answer here is the one #3219 established: every field that
// was a plain uncontrolled input STAYS DOM-OWNED — `defaultValue` seeds it, the DOM
// holds it, and an `onChange` mirrors into state that only the chips read. Fields
// that were ALREADY React-controlled stay controlled and lose nothing.
//
// THE HAZARD THAT MADE THAT A RULE (#3352). `fieldHoldsUnsavedInput` ends at
// `current !== serverValue`, and `serverValue` was the DOM `defaultValue` — which
// React KEEPS IN SYNC with `value` on a controlled input. So a controlled field
// reported clean forever and ModalShell's "Discard your changes?" guard silently
// vanished for it. That hole is closed in the registry itself now (it snapshots the
// default at registration and stops believing a live default that has moved onto
// exactly what the user typed), so converting a field here would no longer disarm its
// guard — it is simply not needed, and this is the largest named-input surface in the
// tree, so the cheaper shape wins by the widest margin.
//
//   DOM-OWNED (defaultValue + onChange mirror): target_weight, target_reps,
//   target_sets, target_duration, title, description, category, current_value,
//   target_value, unit.
//   ALREADY CONTROLLED, left alone: body_target and biomarker_target (both `value`
//   + `onChange` since #631/#1853), equipment_id (a `<select value=…>` since #1610).
//   NEITHER: every `type="hidden"` carrier — kind, weight_unit, exercise, metric,
//   body_metric, biomarker_name, target_direction — which the registry excludes
//   outright (NON_INPUT_TYPES), and DateField, whose named input is hidden too.
//
// THE CLOSED PANELS STAY MOUNTED, hidden rather than unmounted, for the reason #3219
// found the hard way: this is a DOM-COLLECTED form (`<form action={submit}>` hands
// the action whatever FormData the browser gathers from the inputs mounted AT
// SUBMIT), so a field that unmounts when its panel closes is a field the form CLEARS.
//
// THE ONE PLACE THAT IS DELIBERATELY NOT TRUE is the exercise target's metric-
// conditional block, which mounts only the inputs its metric uses — exactly as it did
// before. Mounting all four would post a stale `target_weight` on a hold goal, and on
// a REPS goal `target_weight_kg` is not decoration: `bestValueForGoal` reads it as a
// weight FLOOR, so a leftover number would silently change which sets count.
export default function GoalForm({
  lifts,
  equipment = [],
  equipmentByExercise = {},
  exerciseBests = {},
  latestBodyMetrics = {},
  weightUnit,
  biomarkerOptions = [],
  editGoal,
  strengthTrainingAvailable = true,
  onDone,
}: {
  lifts: string[];
  // The profile's equipment registry and, per canonical movement, the implements it
  // has been logged on (#1610). Default to empty so the picker is simply absent for a
  // profile that owns no gear — and for every caller that predates it.
  equipment?: { id: number; name: string }[];
  equipmentByExercise?: Record<string, number[]>;
  // WHERE A NEW TARGET IS STARTING FROM (#3220), per logged movement and per body
  // metric. Both default to empty, so a caller that predates them renders the chip
  // row with the starting-point fact simply absent rather than wrong.
  exerciseBests?: Record<string, ExerciseBest>;
  latestBodyMetrics?: Partial<Record<BodyMetricKind, number | null>>;
  weightUnit: WeightUnit;
  // The ranked analyte rows for the lab/vital target picker (#1853), already grouped
  // and label-disambiguated by the shared series-picker options. Defaults to empty so
  // a caller that predates the target keeps rendering the other three kinds.
  biomarkerOptions?: GoalBiomarkerOption[];
  editGoal?: OutcomeGoal;
  strengthTrainingAvailable?: boolean;
  onDone?: () => void;
}) {
  const allowExerciseGoal =
    strengthTrainingAvailable || editGoal?.kind === "exercise";
  const initialKind: OutcomeGoalKind =
    editGoal?.kind ?? (allowExerciseGoal ? "exercise" : "freeform");
  const formRef = useRef<HTMLFormElement>(null);
  const formatPrefs = useFormatPrefs();
  const [kind, setKind] = useState(initialKind);
  // True while the kind came from a subject pick rather than from the kind row —
  // what the chip's suggestion marking states (#3216/#3222). An edit reads back a
  // kind the person already chose, so it starts false.
  const [kindDerived, setKindDerived] = useState(false);
  const [exercise, setExercise] = useState(editGoal?.exercise ?? "");
  const [metric, setMetric] = useState<OutcomeGoalMetric>(() => {
    const initialMetric = editGoal?.metric ?? "weight";
    return isTimed(editGoal?.exercise ?? "")
      ? "hold"
      : initialMetric === "hold"
        ? "weight"
        : initialMetric;
  });
  const [bodyMetric, setBodyMetric] = useState<BodyMetricKind>(
    editGoal?.body_metric ?? "weight"
  );

  // Pre-filled values for the DOM-owned inputs when editing.
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
  const optionByLabel = useMemo(
    () => new Map(biomarkerOptions.map((o) => [o.label, o])),
    [biomarkerOptions]
  );
  const optionByName = useMemo(
    () => new Map(biomarkerOptions.map((o) => [o.name, o])),
    [biomarkerOptions]
  );
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
      ? (storedLabUnit(editGoal.unit) ?? storedLabUnit(bioOption?.unit) ?? null)
      : (storedLabUnit(bioOption?.unit) ?? null);

  // The thresholds the app already holds for this analyte, stated beside the number
  // the user is about to type — the reference band the biomarker chart draws, for
  // this profile's sex and age. Nothing is prefilled from it: a reference range is
  // context, and picking someone's target for them is a different (clinical) act.
  const referenceHint = (() => {
    if (!bioOption) return null;
    const { low, high } = bioOption;
    const suffix = displayUnit(bioOption.unit);
    if (low != null && high != null)
      return `Reference range ${low}–${high}${suffix ? ` ${suffix}` : ""}`;
    if (high != null)
      return `Reference under ${high}${suffix ? ` ${suffix}` : ""}`;
    if (low != null)
      return `Reference over ${low}${suffix ? ` ${suffix}` : ""}`;
    return null;
  })();

  // ── The DOM-owned fields' mirrors ─────────────────────────────────────────
  // Read by the chips only; the DOM still owns every one of these values. See the
  // header for why they are not controlled.
  const [targetWeight, setTargetWeight] = useState(String(wVal));
  const [targetReps, setTargetReps] = useState(
    editGoal?.target_reps == null ? "" : String(editGoal.target_reps)
  );
  const [targetSets, setTargetSets] = useState(
    editGoal?.target_sets == null ? "" : String(editGoal.target_sets)
  );
  const [targetDuration, setTargetDuration] = useState(holdVal);
  const [titleText, setTitleText] = useState(editGoal?.title ?? "");
  const [descriptionText, setDescriptionText] = useState(
    editGoal?.description ?? ""
  );
  const [categoryText, setCategoryText] = useState(
    editGoal?.categoryLabel ?? ""
  );
  const [currentValue, setCurrentValue] = useState(
    editGoal?.current_value == null ? "" : String(editGoal.current_value)
  );
  const [targetValue, setTargetValue] = useState(
    editGoal?.target_value == null || editGoal.kind !== "freeform"
      ? ""
      : String(editGoal.target_value)
  );
  const [unitText, setUnitText] = useState(editGoal?.unit ?? "");
  // Controlled, and it always was: DateField's named input is `type="hidden"`, so
  // this is outside what the dirty-form registry can see either way.
  const [targetDate, setTargetDate] = useState(editGoal?.target_date ?? "");

  function resetTargetMirrors() {
    setTargetWeight(String(wVal));
    setTargetReps(
      editGoal?.target_reps == null ? "" : String(editGoal.target_reps)
    );
    setTargetSets(
      editGoal?.target_sets == null ? "" : String(editGoal.target_sets)
    );
    setTargetDuration(holdVal);
  }

  const timed = isTimed(exercise);
  // Timed lifts can only have a hold target. Apply that invariant in the same
  // interaction that changes the exercise, so the form never renders a mismatched
  // exercise/metric pair and needs no follow-up synchronization render.
  const chooseExercise = (nextExercise: string) => {
    setExercise(nextExercise);
    const next: OutcomeGoalMetric = isTimed(nextExercise)
      ? "hold"
      : timed && metric === "hold"
        ? "weight"
        : metric;
    if (next !== metric) {
      setMetric(next);
      // The metric-conditional block remounts, so its inputs go back to their
      // defaults; the mirrors follow in the same gesture or the chips would state
      // numbers no field holds.
      resetTargetMirrors();
    }
  };

  const chooseMetric = (next: OutcomeGoalMetric) => {
    if (next === metric) return;
    setMetric(next);
    resetTargetMirrors();
  };

  const variant = variantOf(exercise);
  const showEquipment = !!variant && variant.group.equipment.length > 0;

  // ── Load context (#1610) ──────────────────────────────────────────────────
  // The registry implements THIS movement has been logged on. `variantOf` above is
  // the CATALOG axis ("Barbell" vs "Dumbbell" Curl, part of the exercise NAME);
  // this is the INSTANCE axis — two machines that both serialize as the same exact
  // name and whose loads are not comparable. They are different questions and both
  // can apply, which is why they render as separate rows.
  const equipmentName = useMemo(
    () => new Map(equipment.map((e) => [e.id, e.name])),
    [equipment]
  );
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
  const showLoadContext = kind === "exercise" && contextIds.length > 0;
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

  // ── The subject pick, and the kind it derives ─────────────────────────────
  //
  // THE SUBJECT EDITOR HOLDS ALL FOUR VOCABULARIES AT ONCE, and which one you use is
  // what sets the kind. There is no "what kind of goal is this" question any more: a
  // person opening this form knows they want to bench 100 kg or get their LDL under
  // 100, and which of four storage shapes the app keeps that in is not their problem.
  //
  // FOUR PICKERS RATHER THAN ONE MERGED LIST, and that is a measured decision rather
  // than a stylistic one. A single combobox over exercises + body metrics + analytes
  // was written first and refuted: `Combobox`'s empty-query relevance view keeps the
  // first EIGHT options (components/Combobox.tsx), and `getActivitySuggestions`
  // returns the whole ranked lift CATALOG — so the merged list's relevance view was
  // eight exercises and nothing else, and the ranked, group-headed analyte order
  // every biomarker picker has shown since #1675 ("Due or flagged" → "Your markers"
  // → "All biomarkers") could not survive sharing those eight rows. Each vocabulary
  // therefore keeps its own picker and its own ranking, and the DERIVATION — the
  // thing #3220 actually asks for — comes from WHICH picker was used.
  const chooseExerciseSubject = (next: string) => {
    chooseExercise(next);
    if (!next.trim()) return;
    if (kind !== "exercise") setKind("exercise");
    setKindDerived(true);
  };

  function chooseBodyMetric(bm: BodyMetricKind) {
    setBodyMetric(bm);
    // Recompute the target for the new metric — clears a stale weight value that
    // would otherwise post as a bpm/% target (issue #631).
    setBodyTarget(bodyTargetFor(bm));
    if (kind !== "body") setKind("body");
    setKindDerived(true);
  }

  function chooseBiomarker(label: string) {
    // Switching analyte clears the number: 100 mg/dL is not 100 mmol/L, and a stale
    // value would post against the new analyte's unit.
    if (label !== bioLabel) setBioTarget("");
    setBioLabel(label);
    if (!optionByLabel.has(label)) return;
    if (kind !== "biomarker") setKind("biomarker");
    setKindDerived(true);
  }

  function chooseKind(next: OutcomeGoalKind) {
    if (next === kind) return;
    setKind(next);
    // Stated, not suggested, from here on — the person answered this themselves.
    setKindDerived(false);
    setError(null);
    // The other kind's fields unmount, so their DOM values go back to defaults; the
    // mirrors follow in the same gesture.
    resetTargetMirrors();
    setTitleText(editGoal?.title ?? "");
    setDescriptionText(editGoal?.description ?? "");
    setCategoryText(editGoal?.categoryLabel ?? "");
    setCurrentValue(
      editGoal?.current_value == null ? "" : String(editGoal.current_value)
    );
    setTargetValue(
      editGoal?.target_value == null || editGoal.kind !== "freeform"
        ? ""
        : String(editGoal.target_value)
    );
    setUnitText(editGoal?.unit ?? "");
  }

  // ── Where this goal is starting from (#3220) ──────────────────────────────
  const startingFrom = goalStartingFrom({
    kind,
    exerciseBest: exerciseBests[exerciseHistoryKey(exercise)] ?? null,
    metric,
    bodyLatest: latestBodyMetrics[bodyMetric] ?? null,
    bodyMetric,
    biomarkerLatest: bioOption?.latest ?? null,
    biomarkerUnit: storedLabUnit(bioOption?.latestUnit) ?? null,
    currentValue,
    freeformUnit: unitText,
    toDisplayWeight: (kg) => round(kgTo(kg, weightUnit), 1),
    weightUnit,
  });

  const summary = goalFactSummary(
    {
      kind,
      kindDerived,
      subject:
        kind === "exercise"
          ? exercise
          : kind === "body"
            ? BODY_METRIC_LABELS[bodyMetric]
            : kind === "biomarker"
              ? (bioOption?.label ?? "")
              : titleText,
      target:
        kind === "exercise"
          ? {
              kind: "exercise",
              metric,
              weight: targetWeight,
              reps: targetReps,
              sets: targetSets,
              duration: targetDuration,
              weightUnit,
            }
          : kind === "body"
            ? {
                kind: "body",
                metric: bodyMetric,
                value: bodyTarget,
                weightUnit,
              }
            : kind === "biomarker"
              ? {
                  kind: "biomarker",
                  direction,
                  value: bioTarget,
                  unit: bioUnit,
                }
              : { kind: "freeform", value: targetValue, unit: unitText },
      targetDate,
      startingFrom,
      startingFromSuggested: kind !== "freeform",
      equipment: showLoadContext
        ? {
            label:
              selectedContext === ""
                ? null
                : selectedContext === "any"
                  ? "any machine"
                  : (equipmentName.get(Number(selectedContext)) ?? null),
          }
        : null,
      title: titleText,
      category: categoryText,
      notes: descriptionText,
    },
    formatPrefs
  );

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<GoalOpenPanel>({
    scopeRef: formRef,
    // A create lands ON the subject pick, because there is nothing else it could be
    // about; an edit lands on the chips, which is what "edit mode reads back" means.
    initial: editGoal ? null : "subject",
  });
  // The kind is a chip of its own but not a panel of its own: correcting it and
  // picking a subject are the same question, so both doors open the subject editor
  // and `focusKey` keeps the return path per CHIP (#3311).
  const panelFor = (key: GoalOpenPanel): GoalOpenPanel =>
    key === "kind" ? "subject" : key;

  const submitLabel = editGoal ? "Save changes" : "Create goal";
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const problem = firstGoalProblem({
    kind,
    exercise,
    metric,
    targetWeight,
    targetReps,
    targetSets,
    targetDuration,
    machineUnchosen: showLoadContext && selectedContext === "",
    bodyTarget,
    biomarkerPicked: bioOption != null,
    biomarkerTarget: bioTarget,
    title: titleText,
  });

  async function submit(fd: FormData) {
    setError(null);
    if (problem) {
      setError(problem.message);
      openPanel(problem.fact);
      return;
    }
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

  const uid = editGoal?.id ?? "new";

  return (
    <form
      ref={formRef}
      action={submit}
      onKeyDown={onKeyDown}
      className="mt-4 space-y-4"
      data-testid="goal-form"
    >
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

      {/* THE SENTENCE, and the one open editor behind it (#3218/#3220). At most one
          editor is on screen: the row is unmounted while a panel is open, and the
          host is display:none while none is. */}
      {openEditor == null && (
        <GoalFactRow
          summary={summary}
          openEditor={openEditor}
          onOpen={(key, focusKey) => openPanel(panelFor(key), focusKey)}
        />
      )}

      <FactEditorHost
        testId="goal-editor"
        doneTestId="goal-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        className={openEditor == null ? "hidden" : undefined}
      >
        {/* ── The subject, and the kind it derives ──────────────────────── */}
        {/* FOUR VOCABULARIES, ONE EDITOR. Whichever picker you use decides the kind
            — see the state block above for why they are not one merged list. The
            hidden carriers each mount only for the kind they belong to, so the
            FormData the action receives is field-for-field what it received before. */}
        <div hidden={openEditor !== "subject"} className="space-y-4">
          {allowExerciseGoal && (
            <div>
              <label className="label" htmlFor={`goal-exercise-${uid}`}>
                Exercise
              </label>
              {kind === "exercise" && (
                <input type="hidden" name="exercise" value={exercise} />
              )}
              <ActivityCombobox
                id={`goal-exercise-${uid}`}
                value={exercise}
                onChange={chooseExerciseSubject}
                options={lifts}
                placeholder="e.g. Bench Press, Squat, Plank"
              />
              {showEquipment && (
                <div className="mt-2">
                  <FilterPills
                    mode="button"
                    layout="wrap"
                    label="Equipment variant"
                    density="dense"
                    value={variant!.equipment}
                    onSelect={(equipment) =>
                      chooseExerciseSubject(
                        composeVariant(variant!.group, equipment)
                      )
                    }
                    options={variant!.group.equipment.map((equipment) => ({
                      value: equipment,
                      label: equipment,
                    }))}
                  />
                  {variant!.equipment === null && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Pick equipment
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="label">Body metric</label>
            {kind === "body" && (
              <input type="hidden" name="body_metric" value={bodyMetric} />
            )}
            <FilterPills
              mode="button"
              layout="wrap"
              label="Body metric"
              value={kind === "body" ? bodyMetric : null}
              onSelect={chooseBodyMetric}
              options={BODY_METRICS.map((bodyMetricOption) => ({
                value: bodyMetricOption,
                label: BODY_METRIC_LABELS[bodyMetricOption],
                testId: `goal-body-metric-${bodyMetricOption}`,
              }))}
            />
          </div>

          <div>
            <label className="label" htmlFor="goal-biomarker">
              Lab or vital
            </label>
            {/* The SAME ranked, group-headed option list every other biomarker
                picker has shown since #1675: due-or-flagged first, then your
                markers, then the whole vocabulary — not a new alphabetical list.
                The name the form posts is resolved from the picked LABEL, which
                seriesPickerOptions guarantees is unique. */}
            {kind === "biomarker" && (
              <input
                type="hidden"
                name="biomarker_name"
                value={bioOption?.name ?? ""}
              />
            )}
            <Combobox
              id="goal-biomarker"
              value={bioLabel}
              onChange={chooseBiomarker}
              options={biomarkerOptions.map((o) => o.label)}
              groupFor={(label) => optionByLabel.get(label)?.group ?? null}
              // The SAME search keys as every other biomarker picker (#2382): the
              // analyte's own acronym and its curated aliases, so "a1c" and "psa"
              // reach their entries rather than walking a long name's letters.
              searchTermsFor={biomarkerSearchTerms}
              ariaLabel="Lab or vital"
              closeStopsPropagation
              placeholder="e.g. LDL Cholesterol, Hemoglobin A1c"
            />
          </div>

          <div>
            {/* THE FOURTH VOCABULARY IS THE ABSENCE OF ONE. A freeform goal is
                whatever the person writes, so it has no picker — it has a door, and
                the title field appears BELOW it rather than instead of it. Replacing
                the button would unmount the control the person just pressed and drop
                focus to <body>, outside the form's own keydown handler — the same
                defect #3311 fixed for the chips. */}
            <Chip
              role="filter"
              testId="goal-kind-freeform"
              pressed={kind === "freeform"}
              onClick={() => chooseKind("freeform")}
            >
              Track something else
            </Chip>
            {kind === "freeform" && (
              <div className="mt-3">
                <label className="label" htmlFor={`goal-ff-title-${uid}`}>
                  Title
                </label>
                <input
                  id={`goal-ff-title-${uid}`}
                  name="title"
                  defaultValue={editGoal?.title ?? ""}
                  onChange={(e) => setTitleText(e.target.value)}
                  className="input"
                  placeholder="e.g. Run a half marathon"
                />
              </div>
            )}
          </div>
        </div>

        {/* ── The target ────────────────────────────────────────────────── */}
        <div hidden={openEditor !== "target"}>
          {kind === "exercise" && (
            <>
              <label className="label">Target</label>
              <input type="hidden" name="metric" value={metric} />
              <FilterPills
                mode="button"
                layout="wrap"
                label="Goal target"
                value={metric}
                onSelect={chooseMetric}
                options={METRICS.map((option) => ({
                  ...option,
                  disabled: timed
                    ? option.value !== "hold"
                    : option.value === "hold",
                }))}
              />
              {/* Metric-conditional inputs — mounted only for the metric that uses
                  them; see the header for why this one block is not merely hidden. */}
              <div key={metric} className="mt-3 grid gap-3 sm:grid-cols-2">
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
                        onChange={(e) => setTargetWeight(e.target.value)}
                        className="input"
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
                        onChange={(e) => setTargetReps(e.target.value)}
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
                        onChange={(e) => setTargetReps(e.target.value)}
                        className="input"
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
                        onChange={(e) => setTargetWeight(e.target.value)}
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
                        onChange={(e) => setTargetSets(e.target.value)}
                        className="input"
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
                        onChange={(e) => setTargetReps(e.target.value)}
                        className="input"
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
                        onChange={(e) => setTargetWeight(e.target.value)}
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
                      onChange={(e) => setTargetDuration(e.target.value)}
                      placeholder="2:00"
                      className="input"
                    />
                  </div>
                )}
              </div>
            </>
          )}

          {kind === "body" && (
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
              />
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                Progress tracks automatically from your latest Body metrics
                entry.
              </p>
            </div>
          )}

          {kind === "biomarker" && (
            <>
              <label className="label">Target</label>
              <input type="hidden" name="target_direction" value={direction} />
              <FilterPills
                mode="button"
                layout="wrap"
                label="Target direction"
                value={direction}
                onSelect={setDirection}
                options={OUTCOME_GOAL_DIRECTIONS.map((directionOption) => ({
                  value: directionOption,
                  label: DIRECTION_LABEL[directionOption],
                  testId: `goal-direction-${directionOption}`,
                }))}
              />
              <div className="mt-3">
                <label className="label" htmlFor="goal-biomarker-target">
                  Target value
                  {bioUnit ? ` (${displayUnit(bioUnit)})` : ""}
                </label>
                <input
                  id="goal-biomarker-target"
                  type="number"
                  step="any"
                  name="biomarker_target"
                  value={bioTarget}
                  onChange={(e) => setBioTarget(e.target.value)}
                  className="input"
                />
                {referenceHint && (
                  <p
                    className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                    data-testid="goal-clinical-result-reference"
                  >
                    {referenceHint}
                  </p>
                )}
                <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  Progress tracks from your results for this marker, and
                  advances when a new one arrives — not day by day.
                </p>
              </div>
            </>
          )}

          {kind === "freeform" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor={`goal-ff-target-${uid}`}>
                  Target value
                </label>
                <input
                  id={`goal-ff-target-${uid}`}
                  type="number"
                  step="any"
                  name="target_value"
                  defaultValue={editGoal?.target_value ?? ""}
                  onChange={(e) => setTargetValue(e.target.value)}
                  className="input"
                />
              </div>
              <div>
                <label className="label" htmlFor={`goal-ff-unit-${uid}`}>
                  Unit
                </label>
                <input
                  id={`goal-ff-unit-${uid}`}
                  name="unit"
                  defaultValue={editGoal?.unit ?? ""}
                  onChange={(e) => setUnitText(e.target.value)}
                  className="input"
                  placeholder="kg / reps / km"
                />
              </div>
            </div>
          )}
        </div>

        {/* ── The load context (#1610) ──────────────────────────────────── */}
        {showLoadContext && (
          <div
            hidden={openEditor !== "equipment"}
            data-testid="goal-load-context"
          >
            <label className="label" htmlFor="goal-equipment">
              Machine {contextRequired ? "" : "(optional)"}
            </label>
            <select
              id="goal-equipment"
              name="equipment_id"
              className="input"
              value={selectedContext}
              onChange={(e) => setEquipmentId(e.target.value)}
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

        {/* ── The deadline ──────────────────────────────────────────────── */}
        <div hidden={openEditor !== "deadline"}>
          <label className="label" htmlFor={`goal-date-${uid}`}>
            Target date (optional)
          </label>
          <DateField
            id={`goal-date-${uid}`}
            name="target_date"
            value={targetDate}
            onChange={setTargetDate}
            showCountdown
          />
        </div>

        {/* ── The starting point ────────────────────────────────────────── */}
        <div hidden={openEditor !== "startingFrom"}>
          {kind === "freeform" ? (
            <div>
              <label className="label" htmlFor={`goal-ff-current-${uid}`}>
                Current value
              </label>
              <input
                id={`goal-ff-current-${uid}`}
                type="number"
                step="any"
                name="current_value"
                defaultValue={editGoal?.current_value ?? ""}
                onChange={(e) => setCurrentValue(e.target.value)}
                className="input"
              />
            </div>
          ) : (
            // NOT AN EDITOR, AND HONEST ABOUT IT. A measured goal's starting point is
            // read out of history at write time (`baseline_value` in createGoal), so
            // there is nothing here to change — only somewhere to find out where the
            // number came from, which is the question a suggested chip provokes.
            <p
              className="text-sm text-slate-600 dark:text-slate-300"
              data-testid="goal-starting-from-source"
            >
              {startingFrom
                ? `This goal starts ${startingFrom.replace(/^from /, "from ")} — your ${
                    kind === "exercise"
                      ? "best logged set for this movement"
                      : kind === "body"
                        ? "latest Body metrics entry"
                        : "latest result for this marker"
                  }. Progress runs from there to your target.`
                : `Nothing logged yet, so progress starts from your first ${
                    kind === "exercise"
                      ? "set"
                      : kind === "body"
                        ? "Body metrics entry"
                        : "result"
                  }.`}
            </p>
          )}
        </div>

        {/* ── The optional title override ───────────────────────────────── */}
        {kind !== "freeform" && (
          <div hidden={openEditor !== "title"}>
            <label className="label" htmlFor={`goal-title-${uid}`}>
              Title (optional)
            </label>
            <input
              id={`goal-title-${uid}`}
              name="title"
              defaultValue={editGoal?.title ?? ""}
              onChange={(e) => setTitleText(e.target.value)}
              className="input"
              placeholder={
                kind === "body"
                  ? `${BODY_METRIC_LABELS[bodyMetric]} goal`
                  : bioOption
                    ? `${bioOption.name} ${direction === "below" ? "under" : "over"} target`
                    : "Goal title"
              }
            />
          </div>
        )}

        {/* ── Freeform's own optionals ──────────────────────────────────── */}
        {kind === "freeform" && (
          <>
            <div hidden={openEditor !== "category"}>
              <label className="label" htmlFor={`goal-ff-category-${uid}`}>
                Category
              </label>
              <input
                id={`goal-ff-category-${uid}`}
                name="category"
                defaultValue={editGoal?.categoryLabel ?? ""}
                onChange={(e) => setCategoryText(e.target.value)}
                className="input"
                placeholder="weight / habit"
              />
            </div>
            <div hidden={openEditor !== "notes"}>
              <label className="label" htmlFor={`goal-ff-description-${uid}`}>
                Description
              </label>
              <textarea
                id={`goal-ff-description-${uid}`}
                name="description"
                defaultValue={editGoal?.description ?? ""}
                onChange={(e) => setDescriptionText(e.target.value)}
                rows={2}
                className="input"
              />
            </div>
          </>
        )}

        {/* The trailing affordance's panel is a MENU, not an editor: it names the
            optional facts with nothing to state and hands off to one of them, so
            opening it still leaves exactly one editor on screen. */}
        <div hidden={openEditor !== "more"}>
          <div className="flex flex-wrap gap-1.5">
            {summary.more.map((key) => (
              <button
                key={key}
                type="button"
                data-testid={`goal-more-${key}`}
                onClick={() => openPanel(key)}
                className="min-h-11 rounded-full border border-(--border) px-3 py-1.5 text-sm transition hover:bg-(--ghost-hover)"
              >
                {GOAL_FACT_NOUNS[key]}
              </button>
            ))}
          </div>
        </div>
      </FactEditorHost>

      <div>
        <SubmitButton
          pendingLabel="Saving…"
          disabled={
            kind === "exercise"
              ? !exercise.trim()
              : kind === "biomarker"
                ? !bioOption
                : false
          }
        >
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}
