"use client";

import { useEffect, useState } from "react";
import type { BodyMetricKind, FormResult, Goal, GoalMetric } from "@/lib/types";
import type { WeightUnit } from "@/lib/settings";
import { variantOf, composeVariant, isTimed } from "@/lib/lifts";
import { kgTo, round } from "@/lib/units";
import { formatSeconds } from "@/lib/duration";
import { BODY_METRIC_LABELS } from "@/lib/goals";
import ActivityCombobox from "@/components/ActivityCombobox";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { createGoal, updateGoal } from "./actions";

const METRICS: { value: GoalMetric; label: string }[] = [
  { value: "weight", label: "Weight" },
  { value: "reps", label: "Reps" },
  { value: "sets", label: "Sets × reps" },
  { value: "hold", label: "Hold time" },
];

const BODY_METRICS: BodyMetricKind[] = ["weight", "body_fat", "resting_hr"];
const BODY_TARGET_LABEL: Record<BodyMetricKind, string> = {
  weight: "Target bodyweight",
  body_fat: "Target body fat (%)",
  resting_hr: "Target resting HR (bpm)",
};

// Create or edit a goal. Pass `editGoal` to pre-fill and submit to updateGoal;
// `onDone` is called after a successful submit (e.g. to close the modal).
export default function GoalForm({
  lifts,
  weightUnit,
  editGoal,
  onDone,
}: {
  lifts: string[];
  weightUnit: WeightUnit;
  editGoal?: Goal;
  onDone?: () => void;
}) {
  const isExerciseGoal = !!(editGoal?.exercise && editGoal?.metric);
  const initialKind: "exercise" | "freeform" | "body" = editGoal
    ? isExerciseGoal
      ? "exercise"
      : editGoal.body_metric
        ? "body"
        : "freeform"
    : "exercise";
  const [kind, setKind] = useState(initialKind);
  const [exercise, setExercise] = useState(editGoal?.exercise ?? "");
  const [metric, setMetric] = useState<GoalMetric>(
    editGoal?.metric ?? "weight"
  );
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
  // Body-goal target: weight is stored canonical kg → show in the user's unit.
  const bodyTargetVal =
    editGoal?.body_metric === "weight"
      ? round(kgTo(editGoal.target_value ?? 0, weightUnit), 1)
      : editGoal?.body_metric
        ? (editGoal.target_value ?? "")
        : "";

  const timed = isTimed(exercise);
  // Timed lifts can only have a hold target; force it.
  useEffect(() => {
    if (timed) setMetric("hold");
    else if (metric === "hold") setMetric("weight");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timed]);

  const variant = variantOf(exercise);
  const showEquipment = !!variant && variant.group.equipment.length > 0;

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
      setError("Couldn't save this goal. Please try again.");
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

      {/* Kind toggle */}
      <div className="flex flex-wrap gap-1.5">
        {(["exercise", "body", "freeform"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
              kind === k
                ? "border-brand-500 bg-brand-500 text-white"
                : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
            }`}
          >
            {k === "exercise"
              ? "Exercise goal"
              : k === "body"
                ? "Body metric"
                : "Freeform"}
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
              onChange={setExercise}
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
                        setExercise(composeVariant(variant!.group, eq))
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
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    Pick equipment
                  </span>
                )}
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
                    onClick={() => setBodyMetric(bm)}
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
              defaultValue={bodyTargetVal}
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
            <p className="-mt-1 text-xs text-slate-400 dark:text-slate-500">
              Progress tracks automatically from your latest Body Metrics entry.
            </p>
          </div>
          <div className="sm:col-span-2">
            <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
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
              defaultValue={editGoal?.category ?? ""}
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
