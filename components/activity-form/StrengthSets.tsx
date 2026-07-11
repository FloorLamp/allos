"use client";

import type { Equipment } from "@/lib/types";
import { isBarbell } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import type { ExerciseHistoryMap } from "@/lib/queries";
import {
  isUnilateral,
  isTimed,
  isBodyweight,
  isBarbellLift,
  variantOf,
  composeVariant,
  defaultEquipment,
  exerciseHistoryKey,
} from "@/lib/lifts";
import { isValidDuration } from "@/lib/duration";
import { formatLongDate } from "@/lib/format-date";
import {
  judgeTargets,
  summarizeExercise,
  SET_STATUS_TITLES,
} from "@/lib/journal-format";
import {
  suggestNextSet,
  sessionBestSet,
  sessionWorkSets,
  nextSetText,
  type NextSet,
} from "@/lib/coaching";
import {
  dispWeight,
  round,
  stripNegative,
  stripNonPositive,
} from "@/lib/units";
import { IconX, IconBarbell, IconAlertTriangle } from "@tabler/icons-react";
import {
  partIntent,
  partTotal,
  recentSessionsForForm,
  setComplete,
  sidePartial,
  blockedField,
  blockedRing,
  chipCls,
  type PartEntry,
  type SetEntry,
  type PartFault,
} from "./model";

// The strength editor for one part: bodyweight prompt, equipment chips, recent
// sessions, coached next set, per-side + intent options, the set rows, and the
// running total. All state lives in the parent ActivityForm; this component
// renders it and calls back the pi-bound mutators. `fault` is this part's
// partIssue while a change is stuck — it points at the exact inputs to fill.
export default function StrengthSets({
  part,
  fault,
  units,
  isEdit,
  history,
  currentActivityId,
  editedDate,
  equipmentList,
  showBodyweightPrompt,
  bwInput,
  bwSaving,
  onBwInput,
  onSaveBodyweight,
  onUpdatePart,
  onUpdateSet,
  onAddSet,
  onRemoveSet,
  onUpdatePartName,
  onApplySuggestion,
  onPlateTarget,
}: {
  part: PartEntry;
  fault: PartFault;
  units: UnitPrefs;
  isEdit: boolean;
  history: ExerciseHistoryMap;
  // The session the form is saving (edit row id, or the auto-saved create row
  // once it exists, else null) — always excluded from its own "Recent" list.
  currentActivityId: number | null;
  // The edited session's date in edit mode (else null): drops later sessions.
  editedDate: string | null;
  equipmentList: Equipment[];
  showBodyweightPrompt: boolean;
  bwInput: string;
  bwSaving: boolean;
  onBwInput: (v: string) => void;
  onSaveBodyweight: () => void;
  onUpdatePart: (patch: Partial<PartEntry>) => void;
  onUpdateSet: (si: number, patch: Partial<SetEntry>) => void;
  onAddSet: () => void;
  onRemoveSet: (si: number) => void;
  onUpdatePartName: (name: string, extra?: Partial<PartEntry>) => void;
  onApplySuggestion: (ns: NextSet) => void;
  onPlateTarget: (si: number, field: "weight" | "weightRight") => void;
}) {
  const p = part;
  // Recent attempts as a reference — shown when logging fresh AND while editing
  // (issue #188). The current session is always excluded (`currentActivityId`),
  // so a session never appears in its own "Recent": in create that's the
  // auto-saved row once it exists (the layout fetches one spare session per
  // exercise so three priors still show); in edit it's the row being edited,
  // and `editedDate` also drops any session logged after it so the panel stays
  // "previous".
  // Canonical, variant-collapsed key so a typed variant ("Barbell Curl") finds
  // its merged history keyed under the base (#331).
  const hist = p.name.trim() ? history[exerciseHistoryKey(p.name)] : undefined;
  const recent = recentSessionsForForm(
    hist?.sessions,
    currentActivityId,
    isEdit ? editedDate : null
  );
  // Suggested next top set — a forward-looking coaching prompt for logging a
  // fresh set, so it stays create-only. Seeded from every set on the newest
  // prior date (two same-day activities are one session, as in
  // getStrengthByExercise), with the exercise's resolved bodyweight flag and
  // fold base shipped by the server so the two surfaces always agree.
  const past = !isEdit
    ? hist?.sessions.filter((s) => s.activityId !== currentActivityId)
    : undefined;
  let suggestion: NextSet | null = null;
  if (hist && past?.length) {
    // All sets of the newest prior session (two same-day activities are one
    // session, as in getStrengthByExercise) — the anchor plus every working set
    // so progression judges the session, not the single best set (#330).
    const newestSets = past
      .filter((s) => s.date === past[0].date)
      .flatMap((s) => s.sets);
    const best = sessionBestSet(newestSets, past[0].baseKg);
    // A weighted lift whose newest session carries only weightless sets
    // (possible via imports) has no load to progress from — no suggestion
    // beats a from-zero "add 2.5 kg".
    if (best && (hist.bodyweight || best.weightKg > 0))
      suggestion = suggestNextSet(
        {
          exercise: p.name,
          bodyweight: hist.bodyweight,
          lastSessionBest: best,
          lastSessionSets: sessionWorkSets(newestSets, past[0].baseKg),
        },
        units.weightUnit
      );
  }
  const timed = isTimed(p.name);
  // A "content" fault means no set counts yet: flag the effort input (reps or
  // hold), and the weight too where a set needs one (not bodyweight/timed).
  const needsSet = fault === "content";
  const weightBlocked = needsSet && !isBodyweight(p.name) && !timed;
  // Which of a side's inputs to flag: all of them while the part has no
  // content at all ("content" fault), or just the missing half of a set
  // someone started ("set" fault — that side blocks auto-save).
  const sideFlags = (w: string, r: string, d: string) => {
    const partial = fault === "set" && sidePartial(p.name, w, r, d);
    return {
      weight: weightBlocked || (partial && !w.trim()),
      effort: needsSet || (partial && (timed ? !d.trim() : !r.trim())),
    };
  };
  const last = p.sets[p.sets.length - 1];
  const canAddSet = !!last && setComplete(p.name, last, p.perSide);
  const total = partTotal(p);
  // Live version of the journal card's missed-target marker, judged by the
  // same shared rule the saved data will be (completed sets only).
  const intent = partIntent(p);
  const showPerSide = isUnilateral(p.name);
  const belowTarget =
    judgeTargets(
      p.sets
        .filter((s) => setComplete(p.name, s, false))
        .map((s) => ({ reps: Number(s.reps), target_reps: intent.target }))
    ) === "missed";
  const variant = variantOf(p.name);
  // For lifts with no selectable equipment variant, show their normal implement.
  const defaultEq = variant ? null : defaultEquipment(p.name);
  // Plate builder applies to barbells: a user-defined barbell implement, or any
  // barbell lift (the "Barbell" variant chip, or plain lifts like Back Squat).
  const selectedEq = equipmentList.find((e) => e.id === p.equipmentId);
  const showPlate = isBarbell(selectedEq?.category) || isBarbellLift(p.name);
  // Small button that opens the plate builder for a specific weight field.
  const plateButton = (si: number, field: "weight" | "weightRight") => (
    <button
      type="button"
      onClick={() => onPlateTarget(si, field)}
      title="Plate builder"
      aria-label="Open plate builder"
      className="-mx-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-500 dark:hover:bg-ink-800 dark:hover:text-brand-400"
    >
      <IconBarbell className="h-4 w-4" />
    </button>
  );
  // The "effort" input is reps for normal lifts, a m:ss hold time for timed.
  const effortInput = (
    value: string,
    onChange: (v: string) => void,
    blocked: boolean
  ) => {
    if (!timed) {
      return (
        <input
          type="number"
          min="1"
          value={value}
          onChange={(e) => onChange(stripNonPositive(e.target.value))}
          placeholder="reps"
          className={`input bg-white dark:bg-ink-900 ${
            blocked ? blockedField : ""
          }`}
        />
      );
    }
    const invalid = !!value.trim() && !isValidDuration(value);
    return (
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="m:ss"
        aria-invalid={invalid || undefined}
        title={
          invalid ? "Enter time as m:ss or seconds, e.g. 1:30 or 90" : undefined
        }
        className={`input bg-white dark:bg-ink-900 ${
          invalid
            ? "border-rose-300 dark:border-rose-800"
            : blocked
              ? blockedField
              : ""
        }`}
      />
    );
  };
  const badDuration =
    timed &&
    p.sets.some(
      (s) =>
        (!!s.duration.trim() && !isValidDuration(s.duration)) ||
        (p.perSide &&
          !!s.durationRight.trim() &&
          !isValidDuration(s.durationRight))
    );
  return (
    <>
      {showBodyweightPrompt && (
        <div className="mt-2 rounded-md border border-brand-200 bg-brand-50 px-2.5 py-2 text-xs dark:border-brand-900 dark:bg-brand-950/40">
          <div className="font-medium text-slate-600 dark:text-slate-300">
            Add your bodyweight to track volume &amp; strength for bodyweight
            moves.
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="number"
              min="1"
              step="any"
              value={bwInput}
              onChange={(e) => onBwInput(e.target.value)}
              placeholder={`Bodyweight (${units.weightUnit})`}
              className="input bg-white dark:bg-ink-900"
            />
            <button
              type="button"
              onClick={onSaveBodyweight}
              disabled={bwSaving || !(Number(bwInput) > 0)}
              className="btn shrink-0 disabled:opacity-50"
            >
              {bwSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
      {(variant || defaultEq || equipmentList.length > 0) && (
        <div
          className={`mt-2 flex flex-wrap items-center gap-1.5 ${
            fault === "equipment"
              ? `-mx-1.5 -my-1 rounded-lg px-1.5 py-1 ${blockedRing}`
              : ""
          }`}
        >
          {variant &&
            variant.group.equipment.map((eq) => {
              // A variant equipment and a custom implement are mutually
              // exclusive, so a variant chip is active only when no custom
              // implement is chosen.
              const active = variant.equipment === eq && p.equipmentId == null;
              return (
                <button
                  key={eq}
                  type="button"
                  onClick={() => {
                    onUpdatePartName(composeVariant(variant.group, eq));
                    onUpdatePart({ equipmentId: null });
                  }}
                  className={chipCls(active)}
                >
                  {eq}
                </button>
              );
            })}
          {/* This lift's default implement — click to clear any custom
              implement and use the default; highlighted while it's active. */}
          {defaultEq && (
            <button
              type="button"
              onClick={() => onUpdatePart({ equipmentId: null })}
              title="Use the default equipment"
              className={chipCls(p.equipmentId == null)}
            >
              {defaultEq}
            </button>
          )}
          {/* User-defined implement: a compact dropdown sharing the chip row.
              Selecting one drops any variant equipment (resets to the base). */}
          {equipmentList.length > 0 && (
            <select
              value={p.equipmentId ?? ""}
              onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                if (id != null) {
                  // Match the name (and strength grouping) to the implement's
                  // type: a Barbell/Machine implement composes that variant,
                  // "Other" falls back to the base lift.
                  const v = variantOf(p.name);
                  if (v) {
                    const cat = (
                      equipmentList.find((x) => x.id === id)?.category ?? ""
                    )
                      .trim()
                      .toLowerCase();
                    const wantEquip =
                      cat === "barbell"
                        ? "Barbell"
                        : cat === "machine"
                          ? "Machine"
                          : null;
                    const name =
                      wantEquip !== null &&
                      v.group.equipment.includes(wantEquip)
                        ? composeVariant(v.group, wantEquip)
                        : v.group.name;
                    if (name !== p.name) onUpdatePartName(name);
                  }
                }
                onUpdatePart({ equipmentId: id });
              }}
              className={chipCls(p.equipmentId != null)}
            >
              <option value="">Equipment</option>
              {equipmentList.map((eq) => (
                <option key={eq.id} value={eq.id}>
                  {eq.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {recent.length > 0 && (
        <div
          data-testid="recent-sessions"
          className="mt-2 rounded-md border border-black/10 bg-white px-2.5 py-1.5 text-xs dark:border-white/10 dark:bg-ink-900"
        >
          <div className="font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Recent
          </div>
          <ul className="mt-0.5 space-y-0.5">
            {recent.map((sess, i) => (
              <li
                key={i}
                className="flex justify-between gap-3 text-slate-600 dark:text-slate-300"
              >
                <span className="shrink-0 text-slate-400 dark:text-slate-500">
                  {formatLongDate(sess.date)}
                </span>
                <span className="flex items-center gap-1 tabular-nums">
                  {summarizeExercise(sess.sets, units.weightUnit).text}
                  {/* Same missed-target marker as the journal card; the
                      session status is judged server-side. */}
                  {sess.status === "missed" && (
                    <span
                      className="text-amber-500 dark:text-amber-400"
                      title={SET_STATUS_TITLES.missed}
                    >
                      <IconAlertTriangle className="h-3.5 w-3.5" stroke={2} />
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* The coached next set (same progression as the exercise detail
          panel's card) with a one-tap fill, so the suggestion can be acted
          on right where sets are logged. */}
      {suggestion && (
        <div className="mt-2 rounded-md border border-brand-200 bg-brand-50/60 px-2.5 py-1.5 text-xs dark:border-brand-900 dark:bg-brand-950/40">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-brand-600 dark:text-brand-400">
              Next set
            </span>
            <span className="flex items-center gap-2.5">
              <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                {nextSetText(suggestion, units.weightUnit)}
              </span>
              {/* No one-tap fill for per-side parts: the suggestion seeds
                  from the stronger side, so filling both sides with it
                  would over-load the weaker one. */}
              {!p.perSide && (
                <button
                  type="button"
                  onClick={() => onApplySuggestion(suggestion)}
                  title="Fill this into a set"
                  className="rounded-md border border-brand-300 px-2 py-0.5 font-medium text-brand-600 transition hover:bg-brand-500 hover:text-white dark:border-brand-800 dark:text-brand-400 dark:hover:bg-brand-600 dark:hover:text-white"
                >
                  Use
                </button>
              )}
            </span>
          </div>
          <p className="mt-0.5 text-slate-500 dark:text-slate-400">
            {suggestion.rationale}
          </p>
        </div>
      )}
      {/* One options row: the per-side toggle (unilateral lifts) and the
          declared intent — planned reps, or an AMRAP ("to failure") plan.
          Intent is optional; without it, no hit/missed-target judgment is
          made. Checking per-side hides the intent controls (per-side parts
          carry no status), but the row itself stays. */}
      {(showPerSide || intent.applies) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          {showPerSide && (
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={p.perSide}
                onChange={() => onUpdatePart({ perSide: !p.perSide })}
                className="h-3.5 w-3.5 cursor-pointer accent-brand-600"
              />
              Track sides separately
            </label>
          )}
          {intent.applies && (
            <>
              <label className="flex items-center gap-1.5">
                Target reps
                <input
                  type="number"
                  min="1"
                  value={p.targetReps}
                  disabled={p.toFailure}
                  onChange={(e) =>
                    onUpdatePart({
                      targetReps: stripNonPositive(e.target.value),
                    })
                  }
                  placeholder="—"
                  className="input w-16 bg-white px-2 py-1 disabled:opacity-40 dark:bg-ink-900"
                />
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={p.toFailure}
                  onChange={() => onUpdatePart({ toFailure: !p.toFailure })}
                  className="h-3.5 w-3.5 cursor-pointer accent-brand-600"
                />
                To failure
              </label>
            </>
          )}
        </div>
      )}
      <div className="mt-2 space-y-2">
        {p.sets.map((s, si) => (
          <div key={si} className="flex items-start gap-2">
            <span className="w-12 shrink-0 pt-2 text-xs font-medium text-slate-400 dark:text-slate-500">
              Set {si + 1}
            </span>
            {p.perSide ? (
              <div className="flex-1 space-y-1.5">
                {(["", "Right"] as const).map((_, sideIdx) => {
                  const isRight = sideIdx === 1;
                  const sideW = isRight ? s.weightRight : s.weight;
                  const sideR = isRight ? s.repsRight : s.reps;
                  const sideD = isRight ? s.durationRight : s.duration;
                  const flags = sideFlags(sideW, sideR, sideD);
                  return (
                    <div key={sideIdx} className="flex items-center gap-2">
                      <span className="w-4 shrink-0 text-xs font-semibold text-slate-400 dark:text-slate-500">
                        {isRight ? "R" : "L"}
                      </span>
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        value={sideW}
                        onChange={(e) =>
                          onUpdateSet(
                            si,
                            isRight
                              ? { weightRight: stripNegative(e.target.value) }
                              : { weight: stripNegative(e.target.value) }
                          )
                        }
                        placeholder={units.weightUnit}
                        className={`input bg-white dark:bg-ink-900 ${
                          flags.weight ? blockedField : ""
                        }`}
                      />
                      {showPlate &&
                        plateButton(si, isRight ? "weightRight" : "weight")}
                      <span className="text-slate-400 dark:text-slate-500">
                        ×
                      </span>
                      {effortInput(
                        timed ? sideD : sideR,
                        (v) =>
                          onUpdateSet(
                            si,
                            isRight
                              ? timed
                                ? { durationRight: v }
                                : { repsRight: v }
                              : timed
                                ? { duration: v }
                                : { reps: v }
                          ),
                        flags.effort
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-1 items-center gap-2">
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={s.weight}
                  onChange={(e) =>
                    onUpdateSet(si, {
                      weight: stripNegative(e.target.value),
                    })
                  }
                  placeholder={units.weightUnit}
                  className={`input bg-white dark:bg-ink-900 ${
                    sideFlags(s.weight, s.reps, s.duration).weight
                      ? blockedField
                      : ""
                  }`}
                />
                {showPlate && plateButton(si, "weight")}
                <span className="text-slate-400 dark:text-slate-500">×</span>
                {effortInput(
                  timed ? s.duration : s.reps,
                  (v) => onUpdateSet(si, timed ? { duration: v } : { reps: v }),
                  sideFlags(s.weight, s.reps, s.duration).effort
                )}
              </div>
            )}
            {p.sets.length > 1 && (
              <button
                type="button"
                onClick={() => onRemoveSet(si)}
                className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:text-rose-500/80 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                aria-label="Remove set"
              >
                <IconX className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => onAddSet()}
          disabled={!canAddSet}
          title={
            canAddSet
              ? "Add another set"
              : timed
                ? "Enter a hold time first"
                : isBodyweight(p.name)
                  ? "Enter reps first"
                  : "Enter weight and reps first"
          }
          className={`-mx-2 -my-2 px-2 py-2 text-xs font-medium ${
            canAddSet
              ? "text-brand-600 hover:underline dark:text-brand-400"
              : "cursor-not-allowed text-slate-300 dark:text-slate-600"
          }`}
        >
          + Add set
        </button>
        <span className="flex items-center gap-3">
          {belowTarget && (
            <span
              className="flex items-center gap-1 text-xs font-medium text-amber-500 dark:text-amber-400"
              title={`At least one set fell short of the ${intent.target}-rep target`}
            >
              <IconAlertTriangle className="h-3.5 w-3.5" stroke={2} />
              Below target
            </span>
          )}
          {total > 0 && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Total: {total.toLocaleString()} {units.weightUnit}
            </span>
          )}
        </span>
      </div>
      {badDuration && (
        <p className="mt-1 text-xs text-rose-500 dark:text-rose-400">
          Enter hold time as m:ss (e.g. 1:30) or seconds (e.g. 90).
        </p>
      )}
    </>
  );
}
